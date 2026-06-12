'use strict';

const { app, BrowserWindow, ipcMain, session, screen, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const os    = require('os');
const { exec } = require('child_process');

// DNS-over-HTTPS: Cloudflare for Families
if (app && app.commandLine) {
  app.commandLine.appendSwitch('enable-features', 'DnsOverHttps');
  app.commandLine.appendSwitch('doh-template',
    'https://family.cloudflare-dns.com/dns-query{?dns}');
}

// ── BLOCKLISTE ────────────────────────────────────────────────────────────────
const blocklistPath = path.join(__dirname, 'src', 'blocklists', 'adult.txt');
let adultBlocklist = new Set();
try {
  const raw = fs.readFileSync(blocklistPath, 'utf8');
  adultBlocklist = new Set(raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  console.log(`[FoxiBrowser] Blockliste: ${adultBlocklist.size} Domains`);
} catch (e) { console.warn('[FoxiBrowser] Blockliste fehlt:', e.message); }

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

function sanitizeUrl(input) {
  if (!input) return null;
  input = input.trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) { try { new URL(input); return input; } catch (_) {} }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(input)) return 'https://' + input;
  return 'https://www.google.com/search?q=' + encodeURIComponent(input) + '&safe=active';
}

function isDomainBlocked(hostname) {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  if (adultBlocklist.has(h)) return true;
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (adultBlocklist.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ── STORE ─────────────────────────────────────────────────────────────────────
let _store = null;
async function getStore() {
  if (!_store) {
    const { default: Store } = await import('electron-store');
    _store = new Store();
    // Standard-PIN beim ersten Start setzen
    if (!_store.has('settings')) {
      _store.set('settings', { pin: '1234', timeLimitMinutes: 0 });
    }
  }
  return _store;
}

// ── NUTZUNGSZEIT-TRACKING ─────────────────────────────────────────────────────
let usageStartTime = null;
let usageCheckInterval = null;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2025-05-24"
}

async function getUsedSeconds() {
  const s = await getStore();
  const data = s.get('usageData', {});
  return data[todayKey()] || 0;
}

async function addUsageSeconds(secs) {
  const s = await getStore();
  const data = s.get('usageData', {});
  const key  = todayKey();
  data[key] = (data[key] || 0) + secs;
  // Alte Einträge löschen (nur letzte 30 Tage behalten)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const k of Object.keys(data)) {
    if (new Date(k) < cutoff) delete data[k];
  }
  s.set('usageData', data);
  return data[key];
}

let warningSent5min = false;
let warningSent1min = false;
let timeLimitActive = false;

async function getLimitMinutes() {
  const s = await getStore();
  const settings = s.get('settings', { pin: '1234', timeLimitMinutes: 0 });
  const todayDow   = new Date().getDay();
  const weekLimits = settings.weekdayLimits || {};
  return (weekLimits[todayDow] !== undefined)
    ? weekLimits[todayDow]
    : (settings.timeLimitMinutes || 0);
}

function getLiveUsedSeconds() {
  const stored = _cachedUsedSeconds || 0;
  if (!usageStartTime) return stored;
  return stored + Math.floor((Date.now() - usageStartTime) / 1000);
}

let _cachedUsedSeconds = 0;

async function syncUsedSeconds() {
  _cachedUsedSeconds = await getUsedSeconds();
}

async function checkTimeLimit() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const limitMins = await getLimitMinutes();
  if (limitMins <= 0) return;

  const limitSecs     = limitMins * 60;
  const usedSecs      = getLiveUsedSeconds();
  const remainingSecs = limitSecs - usedSecs;

  mainWindow.webContents.send('time-update', {
    usedSeconds: usedSecs,
    limitSeconds: limitSecs,
    remainingSeconds: remainingSecs,
  });

  if (remainingSecs <= 300 && remainingSecs > 60 && !warningSent5min) {
    warningSent5min = true;
    mainWindow.webContents.send('time-warning', { remainingSeconds: remainingSecs });
  }
  if (remainingSecs <= 60 && remainingSecs > 0 && !warningSent1min) {
    warningSent1min = true;
    mainWindow.webContents.send('time-warning', { remainingSeconds: remainingSecs });
  }
  if (remainingSecs > 300) { warningSent5min = false; warningSent1min = false; }

  if (remainingSecs <= 0 && !timeLimitActive) {
    timeLimitActive = true;
    mainWindow.webContents.send('time-limit-reached');
  }
  if (remainingSecs > 0) timeLimitActive = false;
}

// ── HAUPTFENSTER ─────────────────────────────────────────────────────────────
let mainWindow = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    frame: false,
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    }
  });

  const childSession = session.fromPartition('persist:child', { cache: true });

  // Werbeblocker (erweiterte Filterlisten + cosmetic filtering)
  const AD_FILTER_LISTS = [
    // EasyList (Kernliste für Werbebanner weltweit)
    'https://easylist.to/easylist/easylist.txt',
    // EasyPrivacy (Tracker-Blocker)
    'https://easylist.to/easylist/easyprivacy.txt',
    // EasyList Germany (deutsche Werbung)
    'https://easylist.to/easylistgermany/easylistgermany.txt',
    // uBlock Origin Filterlisten
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
    'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
    // Fanboy Annoyances (Cookie-Banner, Popups, Overlays)
    'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
  ];
  let activeBlocker = null;
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cachePath = path.join(app.getPath('userData'), 'adblocker-cache.bin');

    async function buildBlocker() {
      return ElectronBlocker.fromLists(fetch, AD_FILTER_LISTS, {
        enableCompression: true,
      });
    }

    if (fs.existsSync(cachePath)) {
      try {
        const cached = fs.readFileSync(cachePath);
        activeBlocker = ElectronBlocker.deserialize(cached);
        console.log('[FoxiBrowser] Adblocker aus Cache geladen');
        // Hintergrund-Update
        buildBlocker().then(fresh => {
          fs.writeFileSync(cachePath, fresh.serialize());
          console.log('[FoxiBrowser] Adblocker-Listen aktualisiert');
        }).catch(() => {});
      } catch (_) {
        // Korrupter Cache – löschen und neu herunterladen
        console.warn('[FoxiBrowser] Cache korrupt – wird neu heruntergeladen');
        try { fs.unlinkSync(cachePath); } catch (_) {}
        buildBlocker().then(fresh => {
          activeBlocker = fresh;
          fs.writeFileSync(cachePath, fresh.serialize());
          try { activeBlocker.enableBlockingInSession(childSession); } catch (_) {}
        }).catch(() => {});
      }
    } else {
      // Kein Cache: im Hintergrund laden damit Fenster sofort erscheint
      buildBlocker().then(fresh => {
        activeBlocker = fresh;
        fs.writeFileSync(cachePath, fresh.serialize());
        try { activeBlocker.enableBlockingInSession(childSession); } catch (_) {}
        console.log('[FoxiBrowser] Adblocker-Listen heruntergeladen');
      }).catch(e => console.warn('[FoxiBrowser] Adblocker-Download fehlgeschlagen:', e.message));
    }
    if (activeBlocker) {
      activeBlocker.enableBlockingInSession(childSession);
      console.log('[FoxiBrowser] Werbeblocker aktiv');
    }
  } catch (e) { console.warn('[FoxiBrowser] Adblocker-Fehler:', e.message); }

  // Domain-Blockliste
  childSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    try {
      const url = new URL(details.url);
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) { callback({ cancel: true }); return; }
      if (isDomainBlocked(url.hostname)) {
        callback({ cancel: true });
        if (details.resourceType === 'mainFrame' && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigation-blocked', {
            url: details.url,
            hostname: url.hostname.replace(/^www\./, '')
          });
        }
        return;
      }
    } catch (_) {}
    callback({});
  });

  childSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // Nutzungszeit-Tracking
  mainWindow.on('focus', async () => {
    await syncUsedSeconds();
    usageStartTime = Date.now();
  });
  mainWindow.on('blur',  async () => {
    if (usageStartTime) {
      const secs = Math.floor((Date.now() - usageStartTime) / 1000);
      _cachedUsedSeconds = await addUsageSeconds(secs);
      usageStartTime = null;
    }
  });

  // Alle 10 Sekunden echte Nutzungszeit in Store schreiben
  usageCheckInterval = setInterval(async () => {
    if (usageStartTime) {
      const elapsed = Math.floor((Date.now() - usageStartTime) / 1000);
      _cachedUsedSeconds = await addUsageSeconds(elapsed);
      usageStartTime = Date.now();
    }
  }, 10000);

  // Jede Sekunde UI aktualisieren und Limit prüfen
  setInterval(() => { checkTimeLimit(); }, 1000);

  // Sofort beim Start
  usageStartTime = Date.now();
  syncUsedSeconds().then(() => checkTimeLimit());

  // Auto-Update: 5 Sekunden nach Start prüfen
  setTimeout(startAutoUpdater, 5000);

  // Remote-Server starten falls in Einstellungen aktiviert
  getStore().then(async s => {
    const settings = s.get('settings', {});
    if (settings.remoteEnabled) {
      await addFirewallRule();
      startRemoteServer();
    }
  });
}

// ── AUTO-UPDATER ──────────────────────────────────────────────────────────────
function startAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload         = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', info => {
      console.log('[FoxiBrowser] Update verfügbar:', info.version);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update-available', { version: info.version });
      // Download manuell starten damit download-progress Events feuern
      autoUpdater.downloadUpdate().catch(e => console.warn('[FoxiBrowser] Download-Fehler:', e.message));
    });

    autoUpdater.on('download-progress', progress => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update-progress', {
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        });
    });

    autoUpdater.on('update-downloaded', info => {
      console.log('[FoxiBrowser] Update heruntergeladen:', info.version);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update-downloaded', { version: info.version });
    });

    autoUpdater.on('error', e => console.warn('[FoxiBrowser] Updater-Fehler:', e.message));

    autoUpdater.checkForUpdates().catch(() => {});

    // Alle 4 Stunden erneut prüfen
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[FoxiBrowser] Auto-Updater nicht verfügbar:', e.message);
  }
}

// ── REMOTE CONTROL SERVER ─────────────────────────────────────────────────────
const REMOTE_PORT = 7777;
let remoteServer  = null;
let remotePaused  = false;

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function remoteLoginHtml(error) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FoxiBrowser – Eltern-Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#FF6B35;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:20px;padding:36px 32px;max-width:380px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.2);text-align:center}
  .fox{font-size:3.5rem;margin-bottom:8px}
  h1{font-size:1.3rem;color:#333;margin-bottom:4px}
  .sub{color:#888;font-size:.9rem;margin-bottom:24px}
  input{width:100%;border:2px solid #eee;border-radius:12px;padding:14px;font-size:1.2rem;text-align:center;letter-spacing:6px;outline:none;margin-bottom:12px}
  input:focus{border-color:#FF6B35}
  button{width:100%;padding:14px;border:none;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;background:#FF6B35;color:#fff}
  button:hover{background:#e55a25}
  .err{color:#e53935;font-size:.9rem;margin-top:10px;min-height:18px}
</style>
</head>
<body>
<div class="card">
  <div class="fox">🦊</div>
  <h1>FoxiBrowser Eltern-Bereich</h1>
  <p class="sub">Fernzugriff – bitte PIN eingeben</p>
  <form method="POST" action="/login">
    <input type="password" name="pin" placeholder="PIN" autocomplete="current-password" autofocus maxlength="8">
    <p class="err">${error || ''}</p>
    <button type="submit">Anmelden</button>
  </form>
</div>
</body>
</html>`;
}

function remoteMainHtml(data) {
  const { history, usageToday, usageWeek, settings, paused } = data;
  const usedMin = Math.floor(usageToday / 60);
  const usedSec = usageToday % 60;
  const limitMin = settings.timeLimitMinutes || 0;
  const usedPct  = limitMin > 0 ? Math.min(100, Math.round(usageToday / (limitMin * 60) * 100)) : 0;

  const historyRows = history.slice(0, 50).map(h => {
    const d = new Date(h.time);
    const t = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    const host = (() => { try { return new URL(h.url).hostname.replace(/^www\./,''); } catch(_){ return h.url; } })();
    return `<tr><td class="h-time">${t}</td><td class="h-host">${host}</td><td class="h-title">${(h.title||'').substring(0,60)}</td></tr>`;
  }).join('');

  const weekBars = usageWeek.map(d => {
    const mins = Math.floor(d.seconds / 60);
    const pct  = limitMin > 0 ? Math.min(100, Math.round(d.seconds / (limitMin * 60) * 100)) : Math.min(100, Math.round(mins / 60 * 100));
    const day  = new Date(d.date + 'T12:00:00').toLocaleDateString('de-DE', {weekday:'short'});
    return `<div class="wb"><div class="wb-bar" style="height:${pct}%"></div><div class="wb-label">${day}</div><div class="wb-val">${mins}m</div></div>`;
  }).join('');

  const ageLabels = { klein:'Klein (3–6)', mittel:'Mittel (7–10)', gross:'Groß (11–14)' };
  const currentAge = settings.childAge || 'mittel';

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FoxiBrowser – Eltern-Bereich</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f5f5;color:#222;min-height:100vh}
  header{background:#FF6B35;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.15)}
  header .fox{font-size:1.6rem}
  header h1{font-size:1.1rem;font-weight:800}
  header .logout{margin-left:auto;background:rgba(255,255,255,.2);border:none;color:#fff;padding:8px 16px;border-radius:20px;cursor:pointer;font-size:.85rem;font-weight:700}
  .status-bar{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#fff;border-bottom:2px solid #eee}
  .status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
  .status-dot.active{background:#43a047} .status-dot.paused{background:#e53935}
  .status-text{font-weight:700;font-size:1rem}
  .pause-btn{margin-left:auto;padding:10px 22px;border:none;border-radius:12px;font-weight:800;font-size:.95rem;cursor:pointer}
  .pause-btn.do-pause{background:#e53935;color:#fff} .pause-btn.do-resume{background:#43a047;color:#fff}
  .tabs{display:flex;gap:0;background:#fff;border-bottom:2px solid #eee;overflow-x:auto}
  .tab{padding:12px 18px;border:none;background:none;cursor:pointer;font-size:.9rem;font-weight:600;color:#888;white-space:nowrap;border-bottom:3px solid transparent;margin-bottom:-2px}
  .tab.active{color:#FF6B35;border-bottom-color:#FF6B35}
  .panel{display:none;padding:16px 20px} .panel.active{display:block}
  .card{background:#fff;border-radius:14px;padding:18px;margin-bottom:14px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
  .card h2{font-size:1rem;margin-bottom:12px;color:#555}
  .usage-big{font-size:2.2rem;font-weight:800;color:#FF6B35}
  .usage-sub{color:#888;font-size:.85rem;margin-top:2px}
  .progress-wrap{background:#eee;border-radius:20px;height:12px;margin-top:12px;overflow:hidden}
  .progress-fill{height:100%;border-radius:20px;background:#FF6B35;transition:width .4s}
  .week-chart{display:flex;align-items:flex-end;gap:8px;height:100px;margin-top:8px}
  .wb{display:flex;flex-direction:column;align-items:center;flex:1;height:100%}
  .wb-bar{background:#FF6B35;border-radius:4px 4px 0 0;width:100%;min-height:4px;margin-top:auto}
  .wb-label{font-size:.7rem;color:#888;margin-top:4px}
  .wb-val{font-size:.7rem;font-weight:700;color:#555}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  td{padding:7px 6px;border-bottom:1px solid #f0f0f0;vertical-align:top}
  .h-time{color:#888;white-space:nowrap;width:44px}
  .h-host{font-weight:700;color:#333;width:140px;word-break:break-all}
  .h-title{color:#666}
  .age-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px}
  .age-card{border:2px solid #eee;border-radius:12px;padding:12px;text-align:center;cursor:pointer;transition:all .2s}
  .age-card.selected{border-color:#FF6B35;background:#fff8f5}
  .age-card .age-emoji{font-size:1.8rem}
  .age-card .age-name{font-size:.8rem;font-weight:700;margin-top:4px;color:#333}
  .age-card .age-sub{font-size:.7rem;color:#888}
  .time-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .time-row label{font-size:.9rem;font-weight:600;color:#555}
  .time-input{width:80px;border:2px solid #eee;border-radius:8px;padding:8px;font-size:1rem;text-align:center}
  .save-btn{width:100%;padding:12px;border:none;border-radius:12px;background:#FF6B35;color:#fff;font-weight:800;font-size:1rem;cursor:pointer;margin-top:8px}
  .save-btn:hover{background:#e55a25}
  .msg{padding:8px 12px;border-radius:8px;font-size:.85rem;margin-top:8px;display:none}
  .msg.ok{background:#e8f5e9;color:#2e7d32;display:block}
  .msg.err{background:#ffebee;color:#c62828;display:block}
</style>
</head>
<body>
<header>
  <span class="fox">🦊</span>
  <h1>FoxiBrowser – Eltern-Bereich</h1>
  <form method="POST" action="/logout" style="margin:0"><button type="submit" class="logout">Abmelden</button></form>
</header>

<div class="status-bar">
  <div class="status-dot ${paused ? 'paused' : 'active'}"></div>
  <span class="status-text">${paused ? '⏸ Surfen pausiert' : '▶ Kind surft gerade'}</span>
  <form method="POST" action="/action" style="margin:0">
    <input type="hidden" name="action" value="${paused ? 'resume' : 'pause'}">
    <button type="submit" class="pause-btn ${paused ? 'do-resume' : 'do-pause'}">${paused ? '▶ Surfen freigeben' : '⏸ Pause'}</button>
  </form>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('time',this)">⏰ Nutzungszeit</button>
  <button class="tab" onclick="showTab('history',this)">📋 Verlauf</button>
  <button class="tab" onclick="showTab('settings',this)">⚙️ Einstellungen</button>
</div>

<div id="tab-time" class="panel active">
  <div class="card">
    <h2>Heute</h2>
    <div class="usage-big">${usedMin}m ${usedSec.toString().padStart(2,'0')}s</div>
    <div class="usage-sub">${limitMin > 0 ? `von ${limitMin} Minuten erlaubt (${usedPct}%)` : 'kein Zeitlimit gesetzt'}</div>
    ${limitMin > 0 ? `<div class="progress-wrap"><div class="progress-fill" style="width:${usedPct}%"></div></div>` : ''}
  </div>
  <div class="card">
    <h2>Diese Woche</h2>
    <div class="week-chart">${weekBars}</div>
  </div>
  <div class="card">
    <h2>Tageslimit ändern</h2>
    <form method="POST" action="/set-limit">
      <div class="time-row">
        <label>Minuten pro Tag (0 = kein Limit)</label>
        <input type="number" class="time-input" name="limit" value="${limitMin}" min="0" max="720">
      </div>
      <button type="submit" class="save-btn">💾 Speichern</button>
    </form>
    <div id="limit-msg" class="msg"></div>
  </div>
</div>

<div id="tab-history" class="panel">
  <div class="card">
    <h2>Besuchte Seiten (letzte 50)</h2>
    ${historyRows ? `<table><tbody>${historyRows}</tbody></table>` : '<p style="color:#888;font-size:.9rem">Noch keine Seiten besucht.</p>'}
  </div>
</div>

<div id="tab-settings" class="panel">
  <div class="card">
    <h2>Altersgruppe</h2>
    <form method="POST" action="/set-age">
      <div class="age-grid">
        ${['klein','mittel','gross'].map(age => `
        <label class="age-card ${currentAge === age ? 'selected' : ''}" onclick="selectAge('${age}')">
          <input type="radio" name="age" value="${age}" ${currentAge === age ? 'checked' : ''} style="display:none">
          <div class="age-emoji">${age==='klein'?'🧒':age==='mittel'?'👦':'👩‍💻'}</div>
          <div class="age-name">${ageLabels[age]}</div>
        </label>`).join('')}
      </div>
      <button type="submit" class="save-btn" style="margin-top:12px">💾 Altersgruppe speichern</button>
    </form>
  </div>
</div>

<script>
function showTab(id, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
}
function selectAge(age) {
  document.querySelectorAll('.age-card').forEach(c => c.classList.remove('selected'));
  document.querySelector('.age-card input[value="' + age + '"]').closest('.age-card').classList.add('selected');
}
// Auto-Refresh alle 15s
setTimeout(() => location.reload(), 15000);
</script>
</body>
</html>`;
}

// Einfache Session-Tokens (kein npm-Paket nötig)
const remoteSessions = new Set();
function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/foxi_session=([a-z0-9]+)/);
  return m ? m[1] : null;
}
function isAuthenticated(req) {
  const token = getSessionToken(req);
  return token && remoteSessions.has(token);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}
function parseForm(body) {
  const p = new URLSearchParams(body);
  const out = {};
  for (const [k,v] of p) out[k] = v;
  return out;
}

async function startRemoteServer() {
  if (remoteServer) return;
  const store = await getStore();

  remoteServer = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // ── Login ────────────────────────────────────────────────────
    if (url === '/login' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const settings = store.get('settings', { pin: '1234' });
      if (form.pin === settings.pin) {
        const token = makeToken();
        remoteSessions.add(token);
        res.writeHead(302, { 'Set-Cookie': `foxi_session=${token}; Path=/; HttpOnly`, Location: '/' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(remoteLoginHtml('Falsche PIN – bitte erneut versuchen.'));
      }
      return;
    }

    // ── Logout ───────────────────────────────────────────────────
    if (url === '/logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) remoteSessions.delete(token);
      res.writeHead(302, { 'Set-Cookie': 'foxi_session=; Max-Age=0; Path=/', Location: '/' });
      res.end();
      return;
    }

    // ── Nicht eingeloggt → Login-Seite ───────────────────────────
    if (!isAuthenticated(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(remoteLoginHtml());
      return;
    }

    // ── Pause / Resume ───────────────────────────────────────────
    if (url === '/action' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      if (form.action === 'pause') {
        remotePaused = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-pause');
      } else if (form.action === 'resume') {
        remotePaused = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-resume');
      }
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Zeitlimit setzen ─────────────────────────────────────────
    if (url === '/set-limit' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const limit = Math.max(0, Math.min(720, parseInt(form.limit, 10) || 0));
      const settings = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      settings.timeLimitMinutes = limit;
      store.set('settings', settings);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Altersgruppe setzen ──────────────────────────────────────
    if (url === '/set-age' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const age = ['klein','mittel','gross'].includes(form.age) ? form.age : 'mittel';
      const settings = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      settings.childAge = age;
      store.set('settings', settings);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-set-age', age);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Hauptseite ───────────────────────────────────────────────
    if (url === '/' && req.method === 'GET') {
      const history   = store.get('history', []);
      const usageData = store.get('usageData', {});
      const settings  = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      const today     = new Date().toISOString().slice(0, 10);
      const usageToday = getLiveUsedSeconds();
      const usageWeek = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        usageWeek.push({ date: key, seconds: key === today ? getLiveUsedSeconds() : (usageData[key] || 0) });
      }
      const html = remoteMainHtml({ history, usageToday, usageWeek, settings, paused: remotePaused });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  remoteServer.listen(REMOTE_PORT, '0.0.0.0', () => {
    console.log(`[FoxiBrowser] Remote-Server läuft auf Port ${REMOTE_PORT}`);
  });
}

function runElevatedNetsh(args) {
  return new Promise(resolve => {
    // Temp-Skript schreiben und erhöht ausführen – zuverlässiger als inline args
    const tmpScript = path.join(app.getPath('temp'), 'foxi_fw.ps1');
    fs.writeFileSync(tmpScript, `netsh advfirewall firewall ${args}\r\n`, 'utf8');
    const cmd = `powershell -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-ExecutionPolicy Bypass -File \\"${tmpScript.replace(/\\/g, '\\\\')}\\""`;
    exec(cmd, err => {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
      if (err) console.warn('[FoxiBrowser] Firewall-Fehler:', err.message);
      else console.log('[FoxiBrowser] Firewall-Befehl ausgeführt:', args);
      resolve(!err);
    });
  });
}

function addFirewallRule() {
  return runElevatedNetsh(`add rule name="FoxiBrowser Fernzugriff" dir=in action=allow protocol=TCP localport=${REMOTE_PORT} enable=yes`);
}

function removeFirewallRule() {
  runElevatedNetsh(`delete rule name="FoxiBrowser Fernzugriff"`);
}

function stopRemoteServer() {
  if (!remoteServer) return;
  remoteServer.close();
  remoteServer = null;
  remotePaused = false;
  console.log('[FoxiBrowser] Remote-Server gestoppt');
}

// ── IPC HANDLER ───────────────────────────────────────────────────────────────
ipcMain.handle('navigate', (_, input) => sanitizeUrl(input));
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-for-update', () => {
  try { require('electron-updater').autoUpdater.checkForUpdates(); } catch (_) {}
});
ipcMain.on('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch (_) {}
});

ipcMain.on('open-external', (_, url) => { if (url.startsWith('http')) shell.openExternal(url); });

ipcMain.handle('create-bug-report', async (_, { title, body }) => {
  const token = process.env.GH_TOKEN ||
    (() => { try { return require('child_process').execSync(
      'powershell -command "[System.Environment]::GetEnvironmentVariable(\'GH_TOKEN\',\'User\')"',
      { encoding: 'utf8' }).trim(); } catch (_) { return ''; } })();
  if (!token) return { ok: false, error: 'Kein GitHub-Token gefunden.' };
  try {
    const res = await fetch('https://api.github.com/repos/chstubi-stack/FoxiBrowser/issues', {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FoxiBrowser',
      },
      body: JSON.stringify({
        title: title.trim(),
        body: `${body.trim()}\n\n---\n_Gesendet von FoxiBrowser v${app.getVersion()}_`,
        labels: ['bug'],
      }),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, url: data.html_url, number: data.number };
    return { ok: false, error: data.message || 'Unbekannter Fehler' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('allow-popup', (_, url) => {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return;
  } catch (_) { return; }

  const popup = new BrowserWindow({
    width: 900, height: 700,
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    title: 'FoxiBrowser – Popup',
    icon: require('path').join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      partition: 'persist:child',
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  popup.loadURL(url);

  // Fenster schließen sobald OAuth-Redirect zurück kommt
  popup.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const u = new URL(navUrl);
      if (u.searchParams.has('gaia_popup_redirect') || navUrl.includes('popup_redirect')) {
        // Redirect-URL an Hauptfenster weitergeben und Popup schließen
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('popup-redirect', navUrl);
        }
        popup.close();
      }
    } catch (_) {}
  });

  popup.on('closed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('window-close',    () => mainWindow?.close());

// Favoriten
ipcMain.handle('get-favorites', async () => { const s = await getStore(); return s.get('favorites', null); });
ipcMain.handle('set-favorites', async (_, favs) => { const s = await getStore(); s.set('favorites', favs); });

// Einstellungen (PIN, Zeitlimit)
ipcMain.handle('get-settings', async () => { const s = await getStore(); return s.get('settings', { pin: '1234', timeLimitMinutes: 0 }); });
ipcMain.handle('set-settings', async (_, settings) => { const s = await getStore(); s.set('settings', settings); });

// PIN prüfen
ipcMain.handle('verify-pin', async (_, pin) => {
  const s = await getStore();
  const settings = s.get('settings', { pin: '1234', timeLimitMinutes: 0 });
  return pin === settings.pin;
});

// Verlauf
ipcMain.handle('add-history', async (_, entry) => {
  const s = await getStore();
  const history = s.get('history', []);
  // Duplikate innerhalb der letzten 30 Sekunden verhindern
  if (history.length > 0 && history[0].url === entry.url &&
      Date.now() - history[0].time < 30000) return;
  history.unshift({ url: entry.url, title: entry.title || entry.url, time: Date.now() });
  if (history.length > 300) history.splice(300);
  s.set('history', history);
});
ipcMain.handle('get-history',   async () => { const s = await getStore(); return s.get('history', []); });
ipcMain.handle('update-history-duration', async (_, { url, duration }) => {
  const s = await getStore();
  const history = s.get('history', []);
  const entry = history.find(h => h.url === url);
  if (entry) { entry.duration = duration; s.set('history', history); }
});
ipcMain.handle('clear-history', async () => { const s = await getStore(); s.set('history', []); });

// Nutzungszeit
ipcMain.handle('get-usage-today', async () => getUsedSeconds());
ipcMain.handle('get-usage-week',  async () => {
  const s = await getStore();
  const data = s.get('usageData', {});
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, seconds: data[key] || 0 });
  }
  return result;
});
ipcMain.handle('reset-usage-today', async () => {
  const s = await getStore();
  const data = s.get('usageData', {});
  delete data[todayKey()];
  s.set('usageData', data);
});

// Remote Control
ipcMain.handle('get-remote-status', async () => {
  const s = await getStore();
  const enabled = s.get('settings', {}).remoteEnabled || false;
  return { enabled, ip: getLocalIp(), port: REMOTE_PORT, paused: remotePaused };
});
ipcMain.handle('set-remote-enabled', async (_, enabled) => {
  const s = await getStore();
  const settings = s.get('settings', { pin: '1234', timeLimitMinutes: 0 });
  settings.remoteEnabled = enabled;
  s.set('settings', settings);
  if (enabled) {
    await addFirewallRule();  // UAC-Prompt erscheint hier
    await startRemoteServer();
  } else {
    stopRemoteServer();
    removeFirewallRule();
  }
  return { ok: true, ip: getLocalIp(), port: REMOTE_PORT };
});

// ── ZERTIFIKATSFEHLER AUTOMATISCH AKZEPTIEREN ────────────────────────────────
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// ── SINGLE INSTANCE LOCK ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── APP LIFECYCLE ─────────────────────────────────────────────────────────────
app.whenReady().then(() => createWindow().catch(e => {
  console.error('[FoxiBrowser] Kritischer Startfehler:', e);
  app.quit();
}));

app.on('window-all-closed', () => {
  if (usageStartTime) {
    const secs = Math.floor((Date.now() - usageStartTime) / 1000);
    getStore().then(s => {
      const data = s.get('usageData', {});
      data[todayKey()] = (data[todayKey()] || 0) + secs;
      s.set('usageData', data);
    });
  }
  clearInterval(usageCheckInterval);
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    try {
      const { protocol } = new URL(url);
      if (!ALLOWED_PROTOCOLS.has(protocol) && protocol !== 'about:' && protocol !== 'file:') event.preventDefault();
    } catch (_) { event.preventDefault(); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('popup-requested', url);
    }
    return { action: 'deny' };
  });


  // Cursor-Position beim Rechtsklick an Renderer senden
  contents.on('context-menu', (event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cursor  = screen.getCursorScreenPoint();
    const bounds  = mainWindow.getBounds();
    mainWindow.webContents.send('context-menu-at', {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y,
      selectionText: params.selectionText,
      isEditable:    params.isEditable,
    });
  });
});
