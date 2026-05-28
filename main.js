'use strict';

const { app, BrowserWindow, ipcMain, session, screen, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

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

async function checkTimeLimit() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const s = await getStore();
  const settings = s.get('settings', { pin: '1234', timeLimitMinutes: 0 });
  const limitMins = settings.timeLimitMinutes || 0;
  if (limitMins <= 0) return; // kein Limit

  const usedSecs = await getUsedSeconds();
  const limitSecs = limitMins * 60;
  const remainingSecs = limitSecs - usedSecs;

  mainWindow.webContents.send('time-update', {
    usedSeconds: usedSecs,
    limitSeconds: limitSecs,
    remainingSeconds: remainingSecs
  });

  if (remainingSecs <= 0) {
    mainWindow.webContents.send('time-limit-reached');
  }
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
      const cached = fs.readFileSync(cachePath);
      activeBlocker = ElectronBlocker.deserialize(cached);
      console.log('[FoxiBrowser] Adblocker aus Cache geladen');
      // Hintergrund-Update
      buildBlocker().then(fresh => {
        fs.writeFileSync(cachePath, fresh.serialize());
        console.log('[FoxiBrowser] Adblocker-Listen aktualisiert');
      }).catch(() => {});
    } else {
      activeBlocker = await buildBlocker();
      fs.writeFileSync(cachePath, activeBlocker.serialize());
      console.log('[FoxiBrowser] Adblocker-Listen heruntergeladen');
    }
    activeBlocker.enableBlockingInSession(childSession);
    console.log('[FoxiBrowser] Werbeblocker aktiv (' +
      activeBlocker.networkFilters.size + ' Netzwerk-Filter, ' +
      activeBlocker.cosmeticFilters.size + ' Kosmetik-Filter)');
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
  mainWindow.on('focus', () => { usageStartTime = Date.now(); });
  mainWindow.on('blur',  () => {
    if (usageStartTime) {
      const secs = Math.floor((Date.now() - usageStartTime) / 1000);
      addUsageSeconds(secs);
      usageStartTime = null;
    }
  });

  // Jede Minute Nutzungszeit speichern und Limit prüfen
  usageCheckInterval = setInterval(async () => {
    if (usageStartTime) {
      await addUsageSeconds(60);
      usageStartTime = Date.now();
    }
    await checkTimeLimit();
  }, 60000);

  // Sofort beim Start prüfen
  usageStartTime = Date.now();
  setTimeout(checkTimeLimit, 2000);

  // Auto-Update: 5 Sekunden nach Start prüfen
  setTimeout(startAutoUpdater, 5000);
}

// ── AUTO-UPDATER ──────────────────────────────────────────────────────────────
function startAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload    = true;   // Im Hintergrund herunterladen
    autoUpdater.autoInstallOnAppQuit = true; // Bei nächstem Schließen installieren

    autoUpdater.on('update-available', info => {
      console.log('[FoxiBrowser] Update verfügbar:', info.version);
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('update-available', { version: info.version });
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

// ── ZERTIFIKATSFEHLER AUTOMATISCH AKZEPTIEREN ────────────────────────────────
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// ── APP LIFECYCLE ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

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
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
