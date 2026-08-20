'use strict';

const { app, BrowserWindow, ipcMain, session, screen, shell, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const os    = require('os');
const crypto = require('crypto');
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

// Bekannte zweistufige Top-Level-Domains (damit z. B. bbc.co.uk nicht als "co.uk" gilt)
const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp',
  'co.nz', 'com.br', 'com.mx', 'co.in', 'co.za', 'com.tr',
]);

// Registrierbare Basis-Domain ermitteln (en.wikipedia.org + de.wikipedia.org → wikipedia.org)
function baseDomain(hostname) {
  if (!hostname) return '';
  const h = hostname.replace(/^www\./, '').toLowerCase();
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo   = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  return TWO_LEVEL_TLDS.has(lastTwo) ? lastThree : lastTwo;
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
    // Migration: altes Feld childAge → ageProfile (einheitliches Feld)
    const settings = _store.get('settings', {});
    if (settings.childAge !== undefined) {
      if (settings.ageProfile === undefined) settings.ageProfile = settings.childAge;
      delete settings.childAge;
      _store.set('settings', settings);
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
  // Keine native Menüleiste (Windows/Linux) – entfernt damit auch alle daran
  // hängenden Standard-Tastenkürzel (u.a. Strg+R, F11-Rollen aus dem Default-Menü).
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    frame: false,
    fullscreen: true,
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      devTools: false,
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
    // Eine vorher per Fernzugriff gesetzte Pause übersteht so einen Neustart
    // von FoxiBrowser (siehe get-time-status für die eigentliche PIN-Sperre).
    remotePaused = !!settings.remotePaused;
    if (remotePaused && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-pause');
    }
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
let remoteServer     = null;
let remotePaused     = false;
let currentChildUrl  = '';
let currentChildTitle = '';

// Merkt eine per Fernzugriff ausgelöste Pause im Store, damit sie nicht durch
// Schließen+Neuöffnen des Browsers verloren geht (gleiches Problem wie beim
// Tageslimit – siehe get-time-status).
async function setRemotePausedPersisted(paused) {
  const s = await getStore();
  const settings = s.get('settings', { pin: '1234', timeLimitMinutes: 0 });
  settings.remotePaused = paused;
  s.set('settings', settings);
}
// Chat zwischen Eltern (remote) und Kind (Browser)
let chatMessages = []; // [{from:'parent'|'child', text, time}]

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
  const { history, usageToday, usageWeek, settings, todayLimit, paused, childUrl, childTitle, favorites } = data;
  const usedMin  = Math.floor(usageToday / 60);
  const usedSec  = usageToday % 60;
  const limitMin = todayLimit !== undefined ? todayLimit : (settings.timeLimitMinutes || 0);
  const usedPct  = limitMin > 0 ? Math.min(100, Math.round(usageToday / (limitMin * 60) * 100)) : 0;
  const weekLimits = settings.weekdayLimits || {};
  const dayNames = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const limitOptions = [0,30,60,90,120,180,240,300,360,480,600,720];
  const limitLabel = m => m <= 0 ? 'Kein Limit' : m < 60 ? `${m} Min.` : m % 60 === 0 ? `${m/60} Std.` : `${Math.floor(m/60)}h ${m%60}m`;

  // Verlauf gruppiert nach Datum
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function durStr(secs) {
    if (!secs || secs <= 0) return '';
    return secs >= 60 ? `${Math.floor(secs/60)} Min. ${secs%60} Sek.` : `${secs} Sek.`;
  }
  // Alle verfügbaren Tage sammeln für Schnellbuttons
  const historyDays = [...new Set(history.map(h => new Date(h.time).toISOString().slice(0,10)))].sort().reverse();

  let historyHtml = '';
  let lastDateKey = '';
  for (const h of history) {
    const d   = new Date(h.time);
    const dateKey = d.toISOString().slice(0,10);
    const dateLabel = d.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'long' });
    const timeStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    let host = h.url;
    try { host = new URL(h.url).hostname.replace(/^www\./,''); } catch(_) {}
    const dur = durStr(h.duration);
    const title = esc((h.title && h.title !== h.url ? h.title : host).substring(0, 80));
    const urlShort = esc(h.url.substring(0, 80));
    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      historyHtml += `<div class="rh-sep" data-date="${dateKey}">${esc(dateLabel)}</div>`;
    }
    historyHtml += `<div class="rh-entry" data-date="${dateKey}">
      <img class="rh-fav" src="https://www.google.com/s2/favicons?domain=${esc(host)}&sz=20" alt="" onerror="this.style.display='none'">
      <div class="rh-info">
        <div class="rh-title">${title}</div>
        <div class="rh-url">${urlShort}</div>
        ${dur ? `<div class="rh-dur">⏱ ${dur}</div>` : ''}
      </div>
      <span class="rh-time">${timeStr}</span>
    </div>`;
  }
  if (!historyHtml) historyHtml = '<p id="rh-empty" style="color:#888;padding:20px 0;font-size:.9rem">Noch keine Seiten besucht.</p>';

  // Schnellbutton-Labels für verfügbare Tage
  const todayStr = new Date().toISOString().slice(0,10);
  const yesterStr = (() => { const y = new Date(); y.setDate(y.getDate()-1); return y.toISOString().slice(0,10); })();
  const dayBtns = historyDays.slice(0,7).map(dk => {
    let label = dk === todayStr ? 'Heute' : dk === yesterStr ? 'Gestern'
      : new Date(dk+'T12:00:00').toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' });
    return `<button class="rh-day-btn" data-date="${dk}">${label}</button>`;
  }).join('');

  const weekBars = usageWeek.map(d => {
    const mins = Math.floor(d.seconds / 60);
    const pct  = limitMin > 0 ? Math.min(100, Math.round(d.seconds / (limitMin * 60) * 100)) : Math.min(100, Math.round(mins / 60 * 100));
    const day  = new Date(d.date + 'T12:00:00').toLocaleDateString('de-DE', {weekday:'short'});
    return `<div class="wb"><div class="wb-bar" style="height:${pct}%"></div><div class="wb-label">${day}</div><div class="wb-val">${mins}m</div></div>`;
  }).join('');

  const ageLabels = { klein:'Klein (3–6)', mittel:'Mittel (7–10)', gross:'Groß (11–14)' };
  const currentAge = settings.ageProfile || 'mittel';

  // Startseite-Kacheln (Favoriten)
  const favList = favorites || [];
  const favoritesHtml = favList.length ? favList.map((f, idx) => `
    <div class="fav-row">
      <span class="fav-row-emoji">${esc(f.emoji || '🌐')}</span>
      <div class="fav-row-info">
        <div class="fav-row-name">${esc(f.name)}</div>
        <div class="fav-row-url">${esc(f.url)}</div>
      </div>
      <form method="POST" action="/delete-favorite" onsubmit="return confirm('Diese Kachel wirklich von der Startseite entfernen?')">
        <input type="hidden" name="idx" value="${idx}">
        <button type="submit" class="fav-del-btn" title="Entfernen">✕</button>
      </form>
    </div>`).join('') : '<p style="color:#888;font-size:.9rem">Noch keine Kacheln auf der Startseite.</p>';

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FoxiBrowser – Eltern-Bereich</title>
<script>
  // Theme so frueh wie moeglich setzen (kein Aufblitzen), ueberlebt das 3s-Polling via localStorage
  (function(){ try { document.documentElement.setAttribute('data-theme', localStorage.getItem('foxi-remote-theme') || 'light'); } catch(e){} })();
  function foxiToggleTheme(){
    var r = document.documentElement;
    var next = r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    r.setAttribute('data-theme', next);
    try { localStorage.setItem('foxi-remote-theme', next); } catch(e){}
    var b = document.getElementById('theme-toggle-btn'); if (b) b.textContent = next === 'dark' ? '☀️' : '🌙';
  }
</script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f5f5;color:#222;min-height:100vh}
  header{background:#FF6B35;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.15)}
  header .fox{font-size:1.6rem}
  header h1{font-size:1.1rem;font-weight:800}
  header .logout{margin-left:auto;background:rgba(255,255,255,.2);border:none;color:#fff;padding:8px 16px;border-radius:20px;cursor:pointer;font-size:.85rem;font-weight:700}
  .status-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 20px;background:#fff;border-bottom:2px solid #eee}
  .status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
  .status-dot.active{background:#43a047} .status-dot.paused{background:#e53935}
  .status-text{font-weight:700;font-size:1rem}
  .current-page{font-size:.8rem;color:#666;background:#f5f5f5;border-radius:8px;padding:5px 10px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
  .current-page a{color:#1565c0;text-decoration:none;font-weight:600}
  .current-page.home{color:#999;font-style:italic}
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
  .week-table{width:100%;border-collapse:collapse;font-size:.9rem}
  .week-table tr{border-bottom:1px solid #f0f0f0}
  .week-table td{padding:8px 6px;vertical-align:middle}
  .week-table td:first-child{font-weight:700;color:#444;width:110px}
  .week-table .today-row td:first-child{color:#FF6B35}
  .week-table select{border:2px solid #eee;border-radius:8px;padding:6px 8px;font-size:.85rem;background:#fff;width:130px}
  .week-table select:focus{border-color:#FF6B35;outline:none}
  .live-dot{width:8px;height:8px;border-radius:50%;background:#43a047;display:inline-block;margin-right:6px;animation:blink 1.5s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
  .live-badge{font-size:.75rem;color:#43a047;font-weight:700}
  .r-preset{background:#2a2a2a;color:#aaa;border:1px solid #333;border-radius:8px;padding:7px 14px;font-size:.85rem;font-weight:700;cursor:pointer;transition:all .15s;font-family:inherit}
  .r-preset:hover{border-color:#FF6B35;color:#FF6B35}
  .r-preset-active{background:#FF6B35!important;color:#fff!important;border-color:#FF6B35!important}
  .rh-list{max-height:60vh;overflow-y:auto;margin:0 -18px;padding:0 18px 18px}
  .rh-day-active{background:#FF6B35!important;color:#fff!important;border-color:#FF6B35!important}
  .rh-sep{font-size:.75rem;font-weight:800;color:#777;text-transform:uppercase;letter-spacing:.8px;padding:14px 0 6px;border-bottom:1px solid #2a2a2a;margin-bottom:6px}
  .rh-entry{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:1px solid transparent;transition:border-color .15s,background .15s;margin-bottom:4px}
  .rh-entry:hover{background:#1a1a1a;border-color:#333}
  .rh-fav{width:18px;height:18px;border-radius:3px;flex-shrink:0;opacity:.8}
  .rh-info{flex:1;min-width:0}
  .rh-title{font-size:.85rem;font-weight:700;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rh-url{font-size:.75rem;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
  .rh-dur{font-size:.75rem;color:#FF6B35;font-weight:700;margin-top:2px}
  .rh-time{font-size:.75rem;color:#555;flex-shrink:0;white-space:nowrap}
  .fav-list{display:flex;flex-direction:column;gap:8px}
  .fav-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #eee;border-radius:10px}
  .fav-row-emoji{font-size:1.4rem;flex-shrink:0}
  .fav-row-info{flex:1;min-width:0}
  .fav-row-name{font-weight:700;font-size:.9rem;color:#333}
  .fav-row-url{font-size:.75rem;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fav-del-btn{background:#ffebee;color:#c62828;border:none;border-radius:8px;width:32px;height:32px;font-weight:800;cursor:pointer;flex-shrink:0;font-size:.9rem}
  .fav-del-btn:hover{background:#ffcdd2}
  .add-fav-form{display:flex;flex-direction:column;gap:10px}
  .add-fav-form input{border:2px solid #eee;border-radius:8px;padding:10px 12px;font-size:.9rem;font-family:inherit}
  .add-fav-form input:focus{border-color:#FF6B35;outline:none}
  /* ── Darkmode ─────────────────────────────────────────────── */
  .theme-toggle{margin-left:auto;background:rgba(255,255,255,.2);border:none;color:#fff;width:38px;height:38px;border-radius:50%;cursor:pointer;font-size:1.05rem;line-height:1;flex-shrink:0}
  .theme-toggle:hover{background:rgba(255,255,255,.32)}
  header .logout{margin-left:12px}
  :root[data-theme="dark"] body{background:#14161a;color:#e2e2e2}
  :root[data-theme="dark"] .status-bar{background:#1e2127;border-bottom-color:#2a2e35}
  :root[data-theme="dark"] .current-page{background:#2a2e35;color:#bbb}
  :root[data-theme="dark"] .current-page.home{color:#888}
  :root[data-theme="dark"] .current-page a{color:#5b9bff}
  :root[data-theme="dark"] .tabs{background:#1e2127;border-bottom-color:#2a2e35}
  :root[data-theme="dark"] .card{background:#1e2127;box-shadow:0 1px 6px rgba(0,0,0,.4)}
  :root[data-theme="dark"] .card h2{color:#bbb}
  :root[data-theme="dark"] .progress-wrap{background:#2a2e35}
  :root[data-theme="dark"] .usage-sub,:root[data-theme="dark"] .wb-label{color:#999}
  :root[data-theme="dark"] .wb-val{color:#bbb}
  :root[data-theme="dark"] td{border-bottom-color:#2a2e35}
  :root[data-theme="dark"] .h-host{color:#ddd}
  :root[data-theme="dark"] .h-title{color:#999}
  :root[data-theme="dark"] .time-row label{color:#bbb}
  :root[data-theme="dark"] .time-input,:root[data-theme="dark"] .week-table select{background:#2a2e35;color:#eee;border-color:#3a3e45}
  :root[data-theme="dark"] .age-card{border-color:#3a3e45;background:#1e2127}
  :root[data-theme="dark"] .age-card.selected{background:#2c2420;border-color:#FF6B35}
  :root[data-theme="dark"] .age-card .age-name{color:#ddd}
  :root[data-theme="dark"] .week-table tr,:root[data-theme="dark"] .week-table td{border-bottom-color:#2a2e35}
  :root[data-theme="dark"] .week-table td:first-child{color:#ccc}
  :root[data-theme="dark"] .rh-url{color:#777}
  :root[data-theme="dark"] .fav-row{border-color:#2a2e35}
  :root[data-theme="dark"] .fav-row-name{color:#ddd}
  :root[data-theme="dark"] .fav-row-url{color:#888}
  :root[data-theme="dark"] .add-fav-form input{background:#2a2e35;color:#eee;border-color:#3a3e45}
</style>
</head>
<body>
<header>
  <span class="fox">🦊</span>
  <h1>FoxiBrowser – Eltern-Bereich</h1>
  <button type="button" id="theme-toggle-btn" class="theme-toggle" onclick="foxiToggleTheme()" title="Hell/Dunkel umschalten">🌙</button>
  <form method="POST" action="/logout" style="margin:0"><button type="submit" class="logout">Abmelden</button></form>
</header>
<script>
  // Toggle-Icon an gespeichertes Theme anpassen
  (function(){ var b=document.getElementById('theme-toggle-btn'); if(b) b.textContent = document.documentElement.getAttribute('data-theme')==='dark' ? '☀️' : '🌙'; })();
</script>

<div class="status-bar">
  <div class="status-dot ${paused ? 'paused' : 'active'}"></div>
  <span class="status-text">${paused ? '⏸ Pausiert' : '▶ Aktiv'}</span>
  ${(() => {
    if (paused) return `<span class="current-page home">Surfen ist pausiert</span>`;
    if (!childUrl || childUrl === 'about:blank' || childUrl === '') {
      return `<span class="current-page home">🏠 Startseite</span>`;
    }
    let host = childUrl;
    try { host = new URL(childUrl).hostname.replace(/^www\./, ''); } catch(_) {}
    const displayTitle = childTitle || host;
    return `<span class="current-page" title="${childUrl.replace(/"/g,'&quot;')}">🌐 <a href="${childUrl.replace(/"/g,'&quot;')}" target="_blank">${displayTitle.substring(0,60)}</a><br><small style="color:#aaa">${host}</small></span>`;
  })()}
  <form method="POST" action="/action" style="margin:0;margin-left:auto">
    <input type="hidden" name="action" value="${paused ? 'resume' : 'pause'}">
    <button type="submit" class="pause-btn ${paused ? 'do-resume' : 'do-pause'}">${paused ? '▶ Freigeben' : '⏸ Pause'}</button>
  </form>
</div>

<div class="tabs">
  <button class="tab active" data-tab="time" onclick="showTab('time',this)">⏰ Nutzungszeit</button>
  <button class="tab" data-tab="history" onclick="showTab('history',this)">📋 Verlauf</button>
  <button class="tab" data-tab="favorites" onclick="showTab('favorites',this)">🏠 Startseite</button>
  <button class="tab" data-tab="chat" id="chat-tab-btn" onclick="showTab('chat',this)">💬 Nachricht</button>
  <button class="tab" data-tab="settings" onclick="showTab('settings',this)">⚙️ Einstellungen</button>
</div>

<div id="tab-time" class="panel active">
  <div class="card">
    <h2>Heute <span class="live-badge"><span class="live-dot"></span>Live</span></h2>
    <div id="live-usage-big" class="usage-big">${usedMin}m ${usedSec.toString().padStart(2,'0')}s</div>
    <div id="live-usage-sub" class="usage-sub">${limitMin > 0 ? `von ${limitMin} Minuten erlaubt (${usedPct}%)` : 'kein Zeitlimit gesetzt'}</div>
    <div class="progress-wrap"><div id="live-progress" class="progress-fill" style="width:${usedPct}%"></div></div>
  </div>
  <div class="card">
    <h2>Diese Woche</h2>
    <div id="live-week-chart" class="week-chart">${weekBars}</div>
  </div>
  <div class="card">
    <h2>Tages-Limit festlegen</h2>
    <form method="POST" action="/set-limit" id="limit-form">
      <div style="margin-bottom:10px">
        <strong style="font-size:.9rem">Tages-Limit: </strong>
        <span id="r-limit-display" style="color:#FF6B35;font-weight:800">${limitLabel(settings.timeLimitMinutes || 0)}</span>
      </div>
      <input type="range" id="r-limit-range" name="limit" min="0" max="240" step="15"
        value="${Math.min(240, settings.timeLimitMinutes || 0)}"
        style="width:100%;accent-color:#FF6B35;margin-bottom:14px;cursor:pointer">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        ${[0,30,60,90,120].map(m =>
          `<button type="button" class="r-preset${(settings.timeLimitMinutes||0)===m?' r-preset-active':''}" data-mins="${m}">${m===0?'Kein Limit':m<60?m+' Min.':m===60?'1 Std.':m===90?'1,5 Std.':'2 Std.'}</button>`
        ).join('')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="submit" class="save-btn" style="flex:1;min-width:120px">✓ Limit speichern</button>
        <button type="button" id="r-btn-reset" class="save-btn" style="flex:1;min-width:120px;background:#e53935">↺ Heutigen Zähler zurücksetzen</button>
      </div>
    </form>
  </div>
  <div class="card">
    <h2>Wochentag-Limits</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:12px">Unterschiedliche Limits für Schultage und Wochenende. Leer lassen = Standard-Tageslimit.</p>
    <form method="POST" action="/set-week-limits">
      <table class="week-table">
        ${[1,2,3,4,5,6,0].map(d => {
          const isToday = new Date().getDay() === d;
          const val = weekLimits[d] !== undefined ? weekLimits[d] : -1;
          const opts = [-1,...limitOptions].map(m =>
            `<option value="${m}" ${val === m ? 'selected' : ''}>${m < 0 ? '(Standard)' : limitLabel(m)}</option>`
          ).join('');
          return `<tr class="${isToday ? 'today-row' : ''}"><td>${dayNames[d]}${isToday ? ' ◀' : ''}</td><td><select name="day${d}">${opts}</select></td></tr>`;
        }).join('')}
      </table>
      <button type="submit" class="save-btn" style="margin-top:12px">💾 Wochentag-Limits speichern</button>
    </form>
  </div>
</div>

<div id="tab-history" class="panel">
  <div class="card" style="padding-bottom:0">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <h2 style="margin-bottom:0">Besuchte Seiten</h2>
      <form method="POST" action="/clear-history" style="margin:0"
        onsubmit="return confirm('Verlauf wirklich löschen?')">
        <button type="submit" style="background:#c62828;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-weight:700;font-size:.82rem;cursor:pointer">🗑 Verlauf löschen</button>
      </form>
    </div>
    <!-- Datum-Filter -->
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <button class="r-preset rh-day-active" data-date="all" onclick="rhFilter('all',this)">Alle</button>
      ${dayBtns ? dayBtns.replace(/class="rh-day-btn"/g, 'class="r-preset" onclick="rhFilter(this.dataset.date,this)"') : ''}
      <input type="date" id="rh-date-picker" style="background:#1e1e1e;color:#eee;border:1px solid #333;border-radius:8px;padding:6px 10px;font-size:.85rem;cursor:pointer;font-family:inherit" onchange="rhFilter(this.value,null)">
      <span id="rh-count" style="margin-left:auto;font-size:.8rem;color:#777"></span>
    </div>
    <div id="rh-empty-msg" style="display:none;color:#888;padding:20px 0;font-size:.9rem">Keine Einträge für diesen Tag.</div>
    <div class="rh-list" id="rh-list">${historyHtml}</div>
  </div>
</div>

<div id="tab-favorites" class="panel">
  <div class="card">
    <h2>Kacheln auf der Startseite</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:14px">Diese Seiten kann dein Kind ohne PIN direkt öffnen. Kacheln hinzufügen oder entfernen wirkt sich sofort auf die Startseite im Browser aus.</p>
    <div class="fav-list" id="fav-list">${favoritesHtml}</div>
  </div>
  <div class="card">
    <h2>Neue Kachel hinzufügen</h2>
    <form method="POST" action="/add-favorite" class="add-fav-form">
      <input type="text" name="name" placeholder="Name (z. B. YouTube Kids)" maxlength="40" required>
      <input type="text" name="url" placeholder="Adresse (z. B. youtube.com)" maxlength="300" required>
      <input type="text" name="emoji" placeholder="Emoji (optional, z. B. 📺)" maxlength="4">
      <button type="submit" class="save-btn">➕ Kachel hinzufügen</button>
    </form>
  </div>
</div>

<div id="tab-chat" class="panel">
  <div class="card" style="display:flex;flex-direction:column;height:calc(100vh - 220px);min-height:300px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">
      <h2 style="margin-bottom:0">💬 Nachricht ans Kind</h2>
      <button onclick="clearChat()" style="background:transparent;color:#666;border:1px solid #333;border-radius:8px;padding:5px 12px;font-size:.8rem;cursor:pointer">🗑 Löschen</button>
    </div>
    <div id="chat-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:8px"></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-shrink:0">
      <input id="chat-input" type="text" placeholder="Nachricht schreiben…" maxlength="500"
        style="flex:1;background:#1e1e1e;color:#eee;border:1px solid #333;border-radius:10px;padding:10px 14px;font-size:.95rem;font-family:inherit;outline:none"
        onkeydown="if(event.key==='Enter')sendMsg()">
      <button onclick="sendMsg()" style="background:#FF6B35;color:#fff;border:none;border-radius:10px;padding:10px 20px;font-weight:700;font-size:.95rem;cursor:pointer;white-space:nowrap">Senden ➤</button>
    </div>
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

// Nach Redirects (z.B. von /add-favorite) den zuletzt aktiven Tab wiederherstellen
(function(){
  const hash = location.hash.replace('#', '');
  const btn = hash && document.querySelector('.tab[data-tab="' + hash + '"]');
  if (btn) showTab(hash, btn);
})();

// ── Tages-Limit Slider ────────────────────────────────────────────────────
const rRange = document.getElementById('r-limit-range');
const rDisplay = document.getElementById('r-limit-display');
function limitLabelJS(m) {
  if (m <= 0) return 'Kein Limit';
  if (m < 60) return m + ' Min.';
  if (m === 60) return '1 Std.';
  if (m === 90) return '1,5 Std.';
  return m % 60 === 0 ? (m/60) + ' Std.' : Math.floor(m/60) + 'h ' + (m%60) + 'm';
}
function syncPresets(val) {
  document.querySelectorAll('.r-preset').forEach(b => {
    b.classList.toggle('r-preset-active', parseInt(b.dataset.mins) === val);
  });
}
if (rRange) {
  rRange.addEventListener('input', () => {
    const v = parseInt(rRange.value);
    if (rDisplay) rDisplay.textContent = limitLabelJS(v);
    syncPresets(v);
  });
  document.querySelectorAll('.r-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = parseInt(btn.dataset.mins);
      rRange.value = Math.min(240, m);
      if (rDisplay) rDisplay.textContent = limitLabelJS(m);
      syncPresets(m);
    });
  });
}

// ── Heutigen Zähler zurücksetzen ─────────────────────────────────────────
const rResetBtn = document.getElementById('r-btn-reset');
if (rResetBtn) {
  rResetBtn.addEventListener('click', async () => {
    if (!confirm('Heutigen Nutzungszeit-Zähler wirklich auf 0 zurücksetzen?')) return;
    const form = document.createElement('form');
    form.method = 'POST'; form.action = '/reset-today';
    document.body.appendChild(form); form.submit();
  });
}

// ── Live-Polling alle 3 Sekunden ──────────────────────────────────────
function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m + 'm ' + String(s).padStart(2,'0') + 's';
}
function fmtLimitLabel(m) {
  if (m <= 0) return 'kein Zeitlimit';
  if (m < 60) return m + ' Min.';
  return m % 60 === 0 ? (m/60) + ' Std.' : Math.floor(m/60) + 'h ' + (m%60) + 'm';
}
function buildWeekBars(usageWeek, limitMin) {
  return usageWeek.map(d => {
    const mins = Math.floor(d.seconds / 60);
    const pct  = limitMin > 0 ? Math.min(100, Math.round(d.seconds / (limitMin * 60) * 100)) : Math.min(100, Math.round(mins / 60 * 100));
    const day  = new Date(d.date + 'T12:00:00').toLocaleDateString('de-DE', {weekday:'short'});
    return '<div class="wb"><div class="wb-bar" style="height:'+pct+'%"></div><div class="wb-label">'+day+'</div><div class="wb-val">'+mins+'m</div></div>';
  }).join('');
}
function updateStatusBar(d) {
  const dot  = document.querySelector('.status-dot');
  const txt  = document.querySelector('.status-text');
  const page = document.querySelector('.current-page');
  const btn  = document.querySelector('.pause-btn');
  const inp  = document.querySelector('input[name="action"]');
  if (!dot) return;
  if (d.paused) {
    dot.className = 'status-dot paused';
    txt.textContent = '⏸ Pausiert';
    if (page) { page.className = 'current-page home'; page.innerHTML = 'Surfen ist pausiert'; }
    if (btn) { btn.className = 'pause-btn do-resume'; btn.textContent = '▶ Freigeben'; }
    if (inp) inp.value = 'resume';
  } else {
    dot.className = 'status-dot active';
    txt.textContent = '▶ Aktiv';
    if (btn) { btn.className = 'pause-btn do-pause'; btn.textContent = '⏸ Pause'; }
    if (inp) inp.value = 'pause';
    if (page) {
      if (!d.childUrl || d.childUrl === 'about:blank' || d.childUrl === '') {
        page.className = 'current-page home'; page.innerHTML = '🏠 Startseite';
      } else {
        let host = d.childUrl;
        try { host = new URL(d.childUrl).hostname.replace(/^www\./,''); } catch(_) {}
        const title = (d.childTitle || host).substring(0, 60);
        page.className = 'current-page';
        page.innerHTML = '🌐 <a href="' + d.childUrl.replace(/"/g,'') + '" target="_blank">' + title + '</a><br><small style="color:#aaa">' + host + '</small>';
      }
    }
  }
}
async function poll() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    // Status-Bar aktualisieren
    updateStatusBar(d);
    // Nutzungszeit aktualisieren
    const big = document.getElementById('live-usage-big');
    const sub = document.getElementById('live-usage-sub');
    const bar = document.getElementById('live-progress');
    const chart = document.getElementById('live-week-chart');
    if (big) big.textContent = fmtTime(d.usageToday);
    if (sub) {
      const pct = d.limitMinutes > 0 ? Math.min(100, Math.round(d.usageToday / (d.limitMinutes * 60) * 100)) : 0;
      sub.textContent = d.limitMinutes > 0 ? 'von ' + fmtLimitLabel(d.limitMinutes) + ' erlaubt (' + pct + '%)' : 'kein Zeitlimit gesetzt';
      if (bar) bar.style.width = pct + '%';
    }
    if (chart && d.usageWeek) chart.innerHTML = buildWeekBars(d.usageWeek, d.limitMinutes);
  } catch(_) {}
}
setInterval(poll, 3000);

// Verlauf-Datum-Filter
function rhFilter(date, btn) {
  const entries = document.querySelectorAll('#rh-list .rh-entry, #rh-list .rh-sep');
  let visible = 0;
  entries.forEach(el => {
    const show = date === 'all' || el.dataset.date === date;
    el.style.display = show ? '' : 'none';
    if (show && el.classList.contains('rh-entry')) visible++;
  });
  document.getElementById('rh-empty-msg').style.display = visible === 0 ? '' : 'none';
  const countEl = document.getElementById('rh-count');
  if (countEl) countEl.textContent = date === 'all' ? '' : visible + ' Einträge';
  // Picker synchronisieren
  const picker = document.getElementById('rh-date-picker');
  if (picker && date !== 'all') picker.value = date;
  else if (picker && date === 'all') picker.value = '';
  // Aktiven Button markieren
  document.querySelectorAll('[data-date].r-preset').forEach(b => b.classList.remove('rh-day-active'));
  if (btn) btn.classList.add('rh-day-active');
  else if (date === 'all') {
    const allBtn = document.querySelector('[data-date="all"]');
    if (allBtn) allBtn.classList.add('rh-day-active');
  }
}
// Beim Laden: Heute anzeigen wenn vorhanden, sonst alle
(function() {
  const today = new Date().toISOString().slice(0,10);
  const hasToday = !!document.querySelector('#rh-list .rh-entry[data-date="' + today + '"]');
  if (hasToday) {
    const todayBtn = document.querySelector('[data-date="' + today + '"]');
    rhFilter(today, todayBtn);
  }
})();

// ── Chat ─────────────────────────────────────────────────────────
let chatLastTime  = 0;
let chatUnread    = 0;
let chatFetching  = false; // verhindert parallele Polls
const chatSeen    = new Set(); // dedupliziert nach Zeitstempel

function appendChatMsg(m) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const isParent = m.from === 'parent';
  const t = new Date(m.time);
  const ts = t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0');
  const bubble = document.createElement('div');
  bubble.style.cssText = [
    'display:flex', 'flex-direction:column',
    isParent ? 'align-items:flex-end' : 'align-items:flex-start'
  ].join(';');
  bubble.innerHTML =
    '<div style="max-width:80%;background:' + (isParent ? '#FF6B35' : '#2a2a2a') + ';color:#fff;padding:9px 14px;border-radius:' +
    (isParent ? '14px 14px 4px 14px' : '14px 14px 14px 4px') +
    ';font-size:.9rem;line-height:1.4;word-break:break-word">' + escHtml(m.text) + '</div>' +
    '<span style="font-size:.72rem;color:#666;margin-top:3px">' + (isParent ? 'Du' : '👦 Kind') + ' · ' + ts + '</span>';
  box.appendChild(bubble);
  box.scrollTop = box.scrollHeight;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
async function sendMsg() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const r = await fetch('/send-message', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'text=' + encodeURIComponent(text) });
  const data = await r.json();
  // Server-Zeitstempel benutzen damit Dedup-Set und chatLastTime exakt stimmen
  if (data.msg) {
    chatSeen.add(data.msg.time);
    appendChatMsg(data.msg);
    if (data.msg.time > chatLastTime) chatLastTime = data.msg.time;
  }
}
async function clearChat() {
  if (!confirm('Chat wirklich löschen?')) return;
  await fetch('/clear-chat', { method:'POST' });
  document.getElementById('chat-messages').innerHTML = '';
  chatLastTime = 0;
  chatUnread = 0;
  chatSeen.clear();
  updateChatBadge();
}
async function pollChat() {
  if (chatFetching) return;
  chatFetching = true;
  try {
    const r = await fetch('/api/chat?since=' + chatLastTime);
    const msgs = await r.json();
    for (const m of msgs) {
      if (chatSeen.has(m.time)) continue; // bereits angezeigt
      chatSeen.add(m.time);
      appendChatMsg(m);
      if (m.time > chatLastTime) chatLastTime = m.time;
      if (m.from === 'child') { chatUnread++; updateChatBadge(); }
    }
  } catch(_) {}
  chatFetching = false;
}
function updateChatBadge() {
  const btn = document.getElementById('chat-tab-btn');
  if (!btn) return;
  if (chatUnread > 0) {
    btn.innerHTML = '💬 Nachricht <span style="background:#c62828;color:#fff;border-radius:10px;padding:1px 7px;font-size:.75rem;margin-left:4px">' + chatUnread + '</span>';
  } else {
    btn.innerHTML = '💬 Nachricht';
  }
}
// Chat-Badge leeren wenn Tab geöffnet wird
document.getElementById('chat-tab-btn').addEventListener('click', () => {
  chatUnread = 0;
  updateChatBadge();
});
setInterval(pollChat, 3000);
pollChat();
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
      await setRemotePausedPersisted(remotePaused);
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

    // ── Verlauf löschen ──────────────────────────────────────────
    if (url === '/clear-history' && req.method === 'POST') {
      store.set('history', []);
      res.writeHead(302, { Location: '/#history' });
      res.end();
      return;
    }

    // ── Heutigen Zähler zurücksetzen ─────────────────────────────
    if (url === '/reset-today' && req.method === 'POST') {
      const data = store.get('usageData', {});
      const today = new Date().toISOString().slice(0, 10);
      delete data[today];
      store.set('usageData', data);
      _cachedUsedSeconds = 0;
      usageStartTime = Date.now();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-resume');
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Altersgruppe setzen ──────────────────────────────────────
    if (url === '/set-age' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const age = ['klein','mittel','gross'].includes(form.age) ? form.age : 'mittel';
      const settings = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      settings.ageProfile = age;
      delete settings.childAge; // altes Feld bereinigen
      store.set('settings', settings);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-set-age', age);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Startseite: Kachel hinzufügen ────────────────────────────
    if (url === '/add-favorite' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const name = (form.name || '').trim().substring(0, 40);
      let favUrl = (form.url || '').trim().substring(0, 300);
      const emoji = (form.emoji || '').trim().substring(0, 4) || '🌐';
      if (name && favUrl) {
        if (!/^https?:\/\//i.test(favUrl)) favUrl = 'https://' + favUrl;
        const favorites = store.get('favorites', []) || [];
        favorites.push({ name, url: favUrl, emoji, color: '#FF6B35' });
        store.set('favorites', favorites);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-favorites-updated', favorites);
      }
      res.writeHead(302, { Location: '/#favorites' });
      res.end();
      return;
    }

    // ── Startseite: Kachel löschen ────────────────────────────────
    if (url === '/delete-favorite' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const idx = parseInt(form.idx, 10);
      const favorites = store.get('favorites', []) || [];
      if (!isNaN(idx) && idx >= 0 && idx < favorites.length) {
        favorites.splice(idx, 1);
        store.set('favorites', favorites);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-favorites-updated', favorites);
      }
      res.writeHead(302, { Location: '/#favorites' });
      res.end();
      return;
    }

    // ── Live-Status JSON (für Auto-Polling) ─────────────────────
    if (url === '/api/status' && req.method === 'GET') {
      const usageData = store.get('usageData', {});
      const settings  = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      const today     = new Date().toISOString().slice(0, 10);
      const todayDow  = new Date().getDay();
      const weekLimits = settings.weekdayLimits || {};
      const todayLimit = weekLimits[todayDow] !== undefined ? weekLimits[todayDow] : (settings.timeLimitMinutes || 0);
      const usageToday = getLiveUsedSeconds();
      const usageWeek = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        usageWeek.push({ date: key, seconds: key === today ? getLiveUsedSeconds() : (usageData[key] || 0) });
      }
      const payload = {
        paused: remotePaused,
        childUrl: currentChildUrl,
        childTitle: currentChildTitle,
        usageToday,
        limitMinutes: todayLimit,
        usageWeek,
        weekdayLimits: settings.weekdayLimits || {},
        globalLimit: settings.timeLimitMinutes || 0,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    // ── Wochentag-Limits speichern ───────────────────────────────
    if (url === '/set-week-limits' && req.method === 'POST') {
      const form = parseForm(await readBody(req));
      const settings = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      const weekLimits = {};
      for (let d = 0; d <= 6; d++) {
        const val = parseInt(form[`day${d}`], 10);
        weekLimits[d] = isNaN(val) ? -1 : Math.max(0, Math.min(720, val));
      }
      settings.weekdayLimits = weekLimits;
      store.set('settings', settings);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ── Eltern schickt Nachricht ans Kind ───────────────────────
    if (url === '/send-message' && req.method === 'POST') {
      if (!isAuthenticated(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      const form = parseForm(await readBody(req));
      const text = (form.text || '').trim().substring(0, 500);
      let savedMsg = null;
      if (text) {
        savedMsg = { from: 'parent', text, time: Date.now() };
        chatMessages.push(savedMsg);
        if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-message', savedMsg);
      }
      // Server-Zeitstempel zurückgeben damit Client chatLastTime korrekt setzen kann
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: savedMsg }));
      return;
    }

    // ── Kind antwortet (vom Browser) ─────────────────────────────
    if (url === '/api/child-reply' && req.method === 'POST') {
      const body = await readBody(req);
      let data = {};
      try { data = JSON.parse(body); } catch(_) {}
      const text = (data.text || '').trim().substring(0, 500);
      if (text) {
        const msg = { from: 'child', text, time: Date.now() };
        chatMessages.push(msg);
        if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Chat-Nachrichten abrufen (Polling) ───────────────────────
    if (url.startsWith('/api/chat') && req.method === 'GET') {
      const since = parseInt(new URL('http://x' + url).searchParams.get('since') || '0', 10);
      const msgs = chatMessages.filter(m => m.time > since);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(msgs));
      return;
    }

    // ── Chat leeren ──────────────────────────────────────────────
    if (url === '/clear-chat' && req.method === 'POST') {
      if (!isAuthenticated(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      chatMessages = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Hauptseite ───────────────────────────────────────────────
    if (url === '/' && req.method === 'GET') {
      const history   = store.get('history', []);
      const usageData = store.get('usageData', {});
      const settings  = store.get('settings', { pin: '1234', timeLimitMinutes: 0 });
      const today     = new Date().toISOString().slice(0, 10);
      const todayDow  = new Date().getDay();
      const weekLimits = settings.weekdayLimits || {};
      const todayLimit = weekLimits[todayDow] !== undefined ? weekLimits[todayDow] : (settings.timeLimitMinutes || 0);
      const usageToday = getLiveUsedSeconds();
      const usageWeek = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        usageWeek.push({ date: key, seconds: key === today ? getLiveUsedSeconds() : (usageData[key] || 0) });
      }
      const favorites = store.get('favorites', []) || [];
      const html = remoteMainHtml({ history, usageToday, usageWeek, settings, todayLimit, paused: remotePaused, childUrl: currentChildUrl, childTitle: currentChildTitle, favorites });
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

function runElevatedCmd(command) {
  // VBScript ShellExecute mit "runas" – einzige zuverlässige UAC-Methode in Electron
  return new Promise(resolve => {
    const tmpBat = path.join(app.getPath('temp'), 'foxi_fw.bat');
    const tmpVbs = path.join(app.getPath('temp'), 'foxi_fw.vbs');
    // ANSI-Encoding (kein BOM) – VBScript-Anforderung
    const batContent = `@echo off\r\n${command}\r\n`;
    const vbsContent = `Set sh = CreateObject("Shell.Application")\r\nsh.ShellExecute "${tmpBat.replace(/\\/g, '\\\\')}", "", "", "runas", 0\r\nWScript.Sleep 5000\r\n`;
    fs.writeFileSync(tmpBat, batContent, { encoding: 'latin1' });
    fs.writeFileSync(tmpVbs, vbsContent, { encoding: 'latin1' });
    exec(`cscript //nologo "${tmpVbs}"`, err => {
      try { fs.unlinkSync(tmpBat); } catch (_) {}
      try { fs.unlinkSync(tmpVbs); } catch (_) {}
      if (err) console.warn('[FoxiBrowser] Firewall-UAC-Fehler:', err.message);
      else console.log('[FoxiBrowser] Firewall-Befehl ausgeführt');
      resolve(!err);
    });
  });
}

function addFirewallRule() {
  return runElevatedCmd(
    `netsh advfirewall firewall delete rule name="FoxiBrowser Fernzugriff" & ` +
    `netsh advfirewall firewall add rule name="FoxiBrowser Fernzugriff" dir=in action=allow protocol=TCP localport=${REMOTE_PORT} enable=yes`
  );
}

function removeFirewallRule() {
  runElevatedCmd(`netsh advfirewall firewall delete rule name="FoxiBrowser Fernzugriff"`);
}

async function stopRemoteServer() {
  if (!remoteServer) return;
  remoteServer.close();
  remoteServer = null;
  remotePaused = false;
  await setRemotePausedPersisted(false);
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

// Screenshots gehen in ein PRIVATES Repo (nicht ins oeffentliche FoxiBrowser-Repo)
const BUG_IMAGE_REPO = 'chstubi-stack/foxibrowser-bugimages';

async function uploadBugImage(token, dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  let ext = m[2].toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
  const b64 = m[3];
  if (b64.length > 7000000) throw new Error('Bild zu groß (max. ~5 MB).');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pathInRepo = `images/${stamp}-${Math.floor(Math.random() * 10000)}.${ext}`;
  const res = await fetch(`https://api.github.com/repos/${BUG_IMAGE_REPO}/contents/${pathInRepo}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'FoxiBrowser' },
    body: JSON.stringify({ message: `Bug-Screenshot ${stamp}`, content: b64 }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.content) return data.content.html_url;
  throw new Error(data.message || ('Upload-Fehler ' + res.status));
}

ipcMain.handle('create-bug-report', async (_, { title, body, image }) => {
  const token = process.env.GH_TOKEN ||
    (() => { try { return require('child_process').execSync(
      'powershell -command "[System.Environment]::GetEnvironmentVariable(\'GH_TOKEN\',\'User\')"',
      { encoding: 'utf8' }).trim(); } catch (_) { return ''; } })();
  if (!token) return { ok: false, error: 'Kein GitHub-Token gefunden.' };
  let imageNote = '';
  if (image) {
    try {
      const url = await uploadBugImage(token, image);
      if (url) imageNote = `\n\n📷 **Screenshot (privates Repo, nur für Entwickler sichtbar):** ${url}`;
    } catch (e) {
      imageNote = `\n\n⚠️ _Screenshot konnte nicht hochgeladen werden: ${e.message}_`;
    }
  }
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
        body: `${body.trim()}${imageNote}\n\n---\n_Gesendet von FoxiBrowser v${app.getVersion()}_`,
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
      devTools: false,
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

// Standard-Browser: Status abfragen + setzen
// Hinweis: Windows 10/11 erlaubt Apps KEIN automatisches Setzen als Standard-Browser.
// Wir registrieren uns als http/https-Handler und oeffnen die Windows-Einstellungen,
// wo der Nutzer FoxiBrowser manuell auswaehlt.
ipcMain.handle('get-default-browser-status', () => {
  try { return app.isDefaultProtocolClient('http'); } catch (_) { return false; }
});
ipcMain.handle('set-default-browser', () => {
  try {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  } catch (e) { console.warn('[FoxiBrowser] setAsDefaultProtocolClient:', e.message); }
  try { shell.openExternal('ms-settings:defaultapps'); } catch (_) {}
  return { ok: true };
});

// ── PIN-WIEDERHERSTELLUNG (Sicherheitsfrage + E-Mail-Code) ─────────────────────
// SMTP-Daten liegen NICHT in der App, sondern serverseitig in reset.php auf
// foxibrowser.de. Der Client ruft nur den Relay-Endpunkt auf.
const RESET_ENDPOINT = 'https://foxibrowser.de/reset.php';
const RESET_SECRET   = 'fx_reset_2b9d4e7a1c6f8035';
let resetCode = null; // { code, expires } – nur im Speicher

function hashAnswer(answer) {
  return crypto.createHash('sha256').update('foxi:' + String(answer || '').trim().toLowerCase()).digest('hex');
}
function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [u, d] = email.split('@');
  const um = u.length <= 2 ? u[0] + '*' : u[0] + '*'.repeat(u.length - 2) + u[u.length - 1];
  return um + '@' + d;
}
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || ''); }

ipcMain.handle('get-recovery-setup', async () => {
  const s = await getStore();
  const settings = s.get('settings', {});
  return {
    hasQuestion: !!settings.securityQuestion,
    question:    settings.securityQuestion || '',
    hasEmail:    !!settings.recoveryEmail,
    emailMasked: maskEmail(settings.recoveryEmail || ''),
  };
});

ipcMain.handle('save-recovery-setup', async (_, { question, answer, email }) => {
  const s = await getStore();
  const settings = s.get('settings', {});
  if (question !== undefined) {
    const q = (question || '').trim();
    if (q) {
      settings.securityQuestion = q;
      if (answer) settings.securityAnswerHash = hashAnswer(answer);
      if (!settings.securityAnswerHash) return { ok: false, error: 'Bitte auch eine Antwort eingeben.' };
    } else {
      delete settings.securityQuestion;
      delete settings.securityAnswerHash;
    }
  }
  if (email !== undefined) {
    const e = (email || '').trim();
    if (e && validEmail(e)) settings.recoveryEmail = e;
    else if (!e) delete settings.recoveryEmail;
    else return { ok: false, error: 'E-Mail-Adresse ungültig.' };
  }
  s.set('settings', settings);
  return { ok: true };
});

ipcMain.handle('reset-pin-via-answer', async (_, { answer, newPin }) => {
  const s = await getStore();
  const settings = s.get('settings', {});
  if (!settings.securityAnswerHash) return { ok: false, error: 'Keine Sicherheitsfrage eingerichtet.' };
  if (!/^\d{4}$/.test(newPin || '')) return { ok: false, error: 'Neue PIN muss genau 4 Ziffern haben.' };
  if (hashAnswer(answer) !== settings.securityAnswerHash) return { ok: false, error: 'Antwort ist leider falsch.' };
  settings.pin = newPin;
  s.set('settings', settings);
  return { ok: true };
});

ipcMain.handle('send-reset-code', async () => {
  const s = await getStore();
  const settings = s.get('settings', {});
  const email = settings.recoveryEmail;
  if (!email) return { ok: false, error: 'Keine Wiederherstellungs-E-Mail hinterlegt.' };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCode = { code, expires: Date.now() + 15 * 60 * 1000 };
  try {
    const res = await fetch(RESET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'FoxiBrowser' },
      body: JSON.stringify({ secret: RESET_SECRET, email, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) return { ok: true, emailMasked: maskEmail(email) };
    return { ok: false, error: 'Versand fehlgeschlagen (' + (data.error || res.status) + ').' };
  } catch (e) {
    return { ok: false, error: 'Server nicht erreichbar: ' + e.message };
  }
});

ipcMain.handle('reset-pin-via-code', async (_, { code, newPin }) => {
  if (!resetCode || Date.now() > resetCode.expires) return { ok: false, error: 'Code abgelaufen – bitte neu anfordern.' };
  if (!/^\d{4}$/.test(newPin || '')) return { ok: false, error: 'Neue PIN muss genau 4 Ziffern haben.' };
  if (String(code || '').trim() !== resetCode.code) return { ok: false, error: 'Code ist falsch.' };
  const s = await getStore();
  const settings = s.get('settings', {});
  settings.pin = newPin;
  s.set('settings', settings);
  resetCode = null;
  return { ok: true };
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
// Autoritativer Status beim App-Start: verhindert, dass ein Neustart des Browsers
// (Kind schließt Fenster nach Zeitlimit-Ablauf und öffnet Foxi erneut) die Sperre
// kurzzeitig umgeht, weil der Renderer sonst erst showHome() zeigt und danach auf
// den 'time-limit-reached'-Push wartet.
ipcMain.handle('get-time-status', async () => {
  const s            = await getStore();
  const settings     = s.get('settings', {});
  const limitMins    = await getLimitMinutes();
  const usedSecs     = await getUsedSeconds();
  const limitSecs    = limitMins * 60;
  const remainingSecs = limitSecs - usedSecs;
  // Direkt aus dem Store gelesen (nicht die In-Memory-Variable remotePaused),
  // damit eine per Fernzugriff gesetzte Pause den Renderer-Start genauso
  // race-frei blockiert wie ein abgelaufenes Tageslimit.
  const isRemotePaused = !!settings.remotePaused;
  return {
    limitSeconds: limitSecs,
    usedSeconds: usedSecs,
    remainingSeconds: remainingSecs,
    remotePaused: isRemotePaused,
    blocked: isRemotePaused || (limitMins > 0 && remainingSecs <= 0),
  };
});
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

// Aktuelle Seite des Kindes tracken
ipcMain.on('child-navigated', (_, { url, title }) => {
  currentChildUrl   = url  || '';
  currentChildTitle = title || '';
});

// Remote Control
ipcMain.handle('get-remote-status', async () => {
  const s = await getStore();
  const enabled = s.get('settings', {}).remoteEnabled || false;
  return { enabled, ip: getLocalIp(), port: REMOTE_PORT, paused: remotePaused };
});
ipcMain.handle('get-remote-port', () => REMOTE_PORT);
// Kind schickt Antwort per IPC (kein HTTP-Fetch nötig)
ipcMain.handle('child-chat-reply', (_, text) => {
  const t = (text || '').trim().substring(0, 500);
  if (!t) return;
  const msg = { from: 'child', text: t, time: Date.now() };
  chatMessages.push(msg);
  if (chatMessages.length > 100) chatMessages = chatMessages.slice(-100);
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
    await stopRemoteServer();
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
// ── STANDARD-BROWSER: eingehende URLs (falls FoxiBrowser als http-Handler laeuft) ──
// Windows startet die App mit der Ziel-URL als Argument. Diese laeuft absichtlich
// durchs PIN-Gate (nav-needs-pin) – konsistent mit dem Kinderschutz-Modell.
function extractUrlFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  return argv.find(a => typeof a === 'string' && /^https?:\/\//i.test(a)) || null;
}
function openIncomingUrl(rawUrl) {
  const clean = rawUrl && sanitizeUrl(rawUrl);
  if (!clean || !mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const send = () => { if (!wc.isDestroyed()) wc.send('nav-needs-pin', clean); };
  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 300));
  else send();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    openIncomingUrl(extractUrlFromArgv(argv));
  });
}

// ── APP LIFECYCLE ─────────────────────────────────────────────────────────────
app.whenReady().then(() => createWindow().then(() => {
  // Beim Start per Link geoeffnet? URL aus argv aufgreifen
  openIncomingUrl(extractUrlFromArgv(process.argv));
}).catch(e => {
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
    let parsed;
    try { parsed = new URL(url); } catch (_) { event.preventDefault(); return; }
    const { protocol } = parsed;
    // Nur http(s)/about/file erlauben
    if (!ALLOWED_PROTOCOLS.has(protocol) && protocol !== 'about:' && protocol !== 'file:') {
      event.preventDefault();
      return;
    }
    // PIN-Gate: Ein Link auf einer Seite darf das Kind nicht ungefragt auf eine
    // FREMDE Domain führen (z. B. externe Links auf Wikipedia). Nur der Kind-<webview>
    // wird geprüft; von der App per loadURL gestartete Navigationen lösen kein
    // will-navigate aus und sind daher nie betroffen.
    if (contents.getType() === 'webview' && ALLOWED_PROTOCOLS.has(protocol)) {
      let currentHost = '';
      try { currentHost = new URL(contents.getURL()).hostname; } catch (_) {}
      // Erste Seite/about:blank durchlassen; sonst nur gleiche Basis-Domain erlauben
      if (currentHost && baseDomain(parsed.hostname) !== baseDomain(currentHost)) {
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('nav-needs-pin', url);
        }
      }
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('popup-requested', url);
    }
    return { action: 'deny' };
  });


  // Tastenkürzel sperren, mit denen das Kind die App verlassen oder Browser-
  // eigene Funktionen (DevTools, Vollbild-Toggle) aufrufen könnte. Gilt für
  // die App-Oberfläche UND das Kind-Webview gleichermaßen. Strg+Alt+Entf lässt
  // sich technisch NICHT abfangen (Windows Secure Attention Sequence) – das
  // wird hier bewusst nicht versucht.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    // Alt+F4: Fenster darf nur über den eigenen "X"-Button geschlossen werden
    if (key === 'f4' && input.alt) { event.preventDefault(); return; }
    // Strg+Umschalt+Esc: Task-Manager-Shortcut erschweren (keine Garantie,
    // da Windows dies teils außerhalb der App abfängt)
    if (key === 'escape' && input.control && input.shift) { event.preventDefault(); return; }
    // F11 (natives Vollbild-Umschalten) und F12/Strg+Umschalt+I/J/C (DevTools,
    // hier zusätzlich schon über webPreferences.devTools=false gesperrt)
    if (key === 'f11' || key === 'f12') { event.preventDefault(); return; }
    if (input.control && input.shift && ['i', 'j', 'c'].includes(key)) { event.preventDefault(); return; }
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
