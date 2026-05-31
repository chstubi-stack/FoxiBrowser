'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foxiAPI', {
  // Navigation
  navigate:       (url)     => ipcRenderer.invoke('navigate', url),
  // Fenster
  minimize:       ()        => ipcRenderer.send('window-minimize'),
  maximize:       ()        => ipcRenderer.send('window-maximize'),
  close:          ()        => ipcRenderer.send('window-close'),
  // Favoriten
  getFavorites:   ()        => ipcRenderer.invoke('get-favorites'),
  setFavorites:   (favs)    => ipcRenderer.invoke('set-favorites', favs),
  // Einstellungen
  getSettings:    ()        => ipcRenderer.invoke('get-settings'),
  setSettings:    (s)       => ipcRenderer.invoke('set-settings', s),
  verifyPin:      (pin)     => ipcRenderer.invoke('verify-pin', pin),
  // Verlauf
  addHistory:     (entry)   => ipcRenderer.invoke('add-history', entry),
  getHistory:     ()        => ipcRenderer.invoke('get-history'),
  clearHistory:   ()        => ipcRenderer.invoke('clear-history'),
  // Nutzungszeit
  getUsageToday:  ()        => ipcRenderer.invoke('get-usage-today'),
  getUsageWeek:   ()        => ipcRenderer.invoke('get-usage-week'),
  resetUsageToday:()        => ipcRenderer.invoke('reset-usage-today'),
  // App-Version
  getVersion:     ()        => ipcRenderer.invoke('get-version'),
  // Update
  checkForUpdate: ()        => ipcRenderer.invoke('check-for-update'),
  installUpdate:  ()        => ipcRenderer.send('install-update'),
  openExternal:   (url)     => ipcRenderer.send('open-external', url),
  allowPopup:     (url)     => ipcRenderer.send('allow-popup', url),
  createBugReport:(data)    => ipcRenderer.invoke('create-bug-report', data),
  onPopupRedirect:(cb)      => ipcRenderer.on('popup-redirect', (_, url) => cb(url)),
  // Events vom Hauptprozess
  onContextMenu:      (cb)  => ipcRenderer.on('context-menu-at', (_, d) => cb(d)),
  onBlocked:          (cb)  => ipcRenderer.on('navigation-blocked', (_, d) => cb(d)),
  onTimeUpdate:       (cb)  => ipcRenderer.on('time-update', (_, d) => cb(d)),
  onTimeLimitReached: (cb)  => ipcRenderer.on('time-limit-reached', () => cb()),
  onUpdateAvailable:  (cb)  => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb)  => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
  onPopupRequested:   (cb)  => ipcRenderer.on('popup-requested', (_, url) => cb(url)),
});
