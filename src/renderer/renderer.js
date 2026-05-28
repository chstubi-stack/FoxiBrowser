'use strict';

// ── DOM-REFERENZEN ─────────────────────────────────────────────────────────
const webview       = document.getElementById('browser-view');
const homePage      = document.getElementById('home-page');
const blockedPage   = document.getElementById('blocked-page');
const timeLimitPage = document.getElementById('time-limit-page');
const addressBar    = document.getElementById('address-bar');
const lockIcon      = document.getElementById('lock-icon');
const loadingBar    = document.getElementById('loading-progress');
const btnBack       = document.getElementById('btn-back');
const btnForward    = document.getElementById('btn-forward');
const btnHome       = document.getElementById('btn-home');
const btnReload     = document.getElementById('btn-reload');
const btnGo         = document.getElementById('btn-go');
const favGrid       = document.getElementById('favorites-grid');
const blockedReason = document.getElementById('blocked-reason');
const timeDisplay   = document.getElementById('time-display');
const timeLabel     = document.getElementById('time-remaining-label');

// ── ALTERSPROFILE ──────────────────────────────────────────────────────────
const AGE_PROFILES = {
  klein: {
    label: 'Klein (3–6)',
    favorites: [
      { name: 'YouTube Kids',         url: 'https://www.youtubekids.com',    emoji: '📺', color: '#FF0000' },
      { name: 'KiKA',                 url: 'https://www.kika.de',            emoji: '🎬', color: '#009FE3' },
      { name: 'Die Maus',             url: 'https://www.wdrmaus.de',         emoji: '🐭', color: '#FF6600' },
      { name: 'tivi',                 url: 'https://www.tivi.de',            emoji: '🌟', color: '#6600CC' },
      { name: 'Toggo',                url: 'https://www.toggo.de',           emoji: '🦁', color: '#E31E24' },
      { name: 'Sesamstraße',          url: 'https://www.sesamstrasse.de',    emoji: '🐸', color: '#2E7D32' },
    ],
  },
  mittel: {
    label: 'Mittel (7–10)',
    favorites: [
      { name: 'YouTube Kids',         url: 'https://www.youtubekids.com',                       emoji: '📺', color: '#FF0000' },
      { name: 'KiKA',                 url: 'https://www.kika.de',                               emoji: '🎬', color: '#009FE3' },
      { name: 'Die Maus',             url: 'https://www.wdrmaus.de',                            emoji: '🐭', color: '#FF6600' },
      { name: 'logo! Nachrichten',    url: 'https://www.zdf.de/kinder/logo',                    emoji: '📰', color: '#0A75B9' },
      { name: 'Blinde Kuh',           url: 'https://www.blinde-kuh.de',                         emoji: '🐄', color: '#FF9900' },
      { name: 'Wikipedia',            url: 'https://de.wikipedia.org/wiki/Wikipedia:Hauptseite', emoji: '📚', color: '#3366CC' },
      { name: 'Scratch',              url: 'https://scratch.mit.edu',                           emoji: '🐱', color: '#FF8C1A' },
    ],
  },
  gross: {
    label: 'Groß (11–14)',
    favorites: [
      { name: 'Wikipedia',            url: 'https://de.wikipedia.org/wiki/Wikipedia:Hauptseite', emoji: '📚', color: '#3366CC' },
      { name: 'YouTube',              url: 'https://www.youtube.com',                            emoji: '▶️',  color: '#FF0000' },
      { name: 'Khan Academy',         url: 'https://de.khanacademy.org',                         emoji: '🎓', color: '#14BF96' },
      { name: 'Scratch',              url: 'https://scratch.mit.edu',                            emoji: '🐱', color: '#FF8C1A' },
      { name: 'Planet Wissen',        url: 'https://www.planet-wissen.de',                       emoji: '🌍', color: '#1565C0' },
      { name: 'ZDFtivi',              url: 'https://www.zdf.de/kinder',                          emoji: '📺', color: '#E53935' },
      { name: 'Spiegel Kids',         url: 'https://www.spiegel.de/thema/spiegel_wissen',        emoji: '📰', color: '#C62828' },
    ],
  },
};

// ── STANDARD-FAVORITEN ─────────────────────────────────────────────────────
const DEFAULT_FAVORITES = AGE_PROFILES.mittel.favorites;

// ── ZUSTAND ────────────────────────────────────────────────────────────────
let isHome           = true;
let lastBlockedByMain= false;
let timeLimitReached = false;
let currentFavorites = [...DEFAULT_FAVORITES];
let pendingUrl       = null;   // URL die nach PIN-Eingabe geöffnet werden soll
let pinCallback      = null;   // Funktion die nach erfolgreicher PIN-Eingabe aufgerufen wird
let pinBuffer        = '';

// ══════════════════════════════════════════════════════════════════════════
// ANSICHTEN
// ══════════════════════════════════════════════════════════════════════════

function hideAll() {
  homePage.classList.add('hidden');
  blockedPage.classList.add('hidden');
  timeLimitPage.classList.add('hidden');
  webview.classList.add('hidden');
}

function showHome() {
  if (timeLimitReached) { showTimeLimitPage(); return; }
  isHome = true;
  hideAll();
  homePage.classList.remove('hidden');
  addressBar.value = '';
  lockIcon.style.opacity = '0.35';
  btnBack.disabled = btnForward.disabled = btnReload.disabled = true;
  try { webview.loadURL('about:blank'); } catch (_) {}
}

function showBrowser(url) {
  if (timeLimitReached) { showTimeLimitPage(); return; }
  isHome = false;
  hideAll();
  webview.classList.remove('hidden');
  addressBar.value = url;
  updateLockIcon(url);
  btnReload.disabled = false;
  try { webview.loadURL(url); } catch (_) { webview.src = url; }
  updateNavButtons();
}

function showBlocked(data) {
  lastBlockedByMain = true;
  hideAll();
  blockedPage.classList.remove('hidden');
  blockedReason.textContent = `"${data.hostname}" ist für Kinder nicht verfügbar.`;
  addressBar.value = '';
  lockIcon.style.opacity = '0.35';
}

function showTimeLimitPage() {
  timeLimitReached = true;
  hideAll();
  timeLimitPage.classList.remove('hidden');
}

function updateLockIcon(url) {
  lockIcon.style.opacity = url.startsWith('https://') ? '1' : '0.4';
}
function updateNavButtons() {
  try { btnBack.disabled = !webview.canGoBack(); btnForward.disabled = !webview.canGoForward(); } catch (_) {}
}
function setLoading(pct) {
  loadingBar.style.width = pct + '%';
  loadingBar.style.opacity = (pct > 0 && pct < 100) ? '1' : '0';
}

// ══════════════════════════════════════════════════════════════════════════
// PIN-DIALOG
// ══════════════════════════════════════════════════════════════════════════

const pinOverlay  = document.getElementById('pin-overlay');
const pinDots     = [0,1,2,3].map(i => document.getElementById(`dot-${i}`));
const pinErrorEl  = document.getElementById('pin-error');

function openPinDialog(title, subtitle, onSuccess, onCancel) {
  pinBuffer = '';
  pinCallback = onSuccess;
  pinErrorEl.classList.add('hidden');
  document.getElementById('pin-title').textContent    = title    || 'Mama oder Papa fragen!';
  document.getElementById('pin-subtitle').textContent = subtitle || 'Bitte die PIN eingeben';
  updatePinDots();
  pinOverlay.classList.remove('hidden');
  pinOverlay._onCancel = onCancel;
}

function closePinDialog() {
  pinOverlay.classList.add('hidden');
  pinBuffer = '';
  if (pinOverlay._onCancel) { pinOverlay._onCancel(); pinOverlay._onCancel = null; }
  pinCallback = null;
}

function updatePinDots() {
  pinDots.forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinBuffer.length);
  });
}

async function submitPin() {
  if (pinBuffer.length < 4) return;
  const ok = await window.foxiAPI.verifyPin(pinBuffer);
  if (ok) {
    pinErrorEl.classList.add('hidden');
    pinOverlay.classList.add('hidden');
    pinOverlay._onCancel = null;
    const cb = pinCallback;
    pinCallback = null;
    pinBuffer = '';
    updatePinDots();
    if (cb) cb();
  } else {
    pinBuffer = '';
    updatePinDots();
    pinErrorEl.classList.remove('hidden');
    pinErrorEl.classList.remove('shake');
    void pinErrorEl.offsetWidth; // Reflow für Animation
    pinErrorEl.classList.add('shake');
  }
}

// Numpad-Events
document.getElementById('pin-numpad').addEventListener('click', e => {
  const btn = e.target.closest('.pin-key');
  if (!btn) return;
  if (btn.id === 'pin-delete') {
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots();
  } else if (btn.id === 'pin-cancel') {
    closePinDialog();
  } else if (btn.dataset.digit !== undefined && pinBuffer.length < 4) {
    pinBuffer += btn.dataset.digit;
    updatePinDots();
    if (pinBuffer.length === 4) setTimeout(submitPin, 120);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ADRESSLEISTE – PIN-GATE
// ══════════════════════════════════════════════════════════════════════════

function requestNavigation(input) {
  if (!input.trim()) return;
  pendingUrl = input;
  openPinDialog(
    'Mama oder Papa fragen!',
    `Adresse öffnen: ${input.length > 40 ? input.slice(0,40)+'…' : input}`,
    async () => {
      const url = await window.foxiAPI.navigate(pendingUrl);
      if (url) showBrowser(url);
      pendingUrl = null;
    },
    () => { pendingUrl = null; }
  );
}

btnGo.addEventListener('click', () => {
  const val = addressBar.value.trim();
  if (val) requestNavigation(val);
});

addressBar.addEventListener('click', () => {
  // Adressleiste ist readonly – Klick öffnet PIN-Dialog
  openPinDialog(
    'Mama oder Papa fragen!',
    'Bitte die PIN eingeben um eine Adresse einzugeben',
    () => {
      // Adressleiste editierbar machen
      addressBar.removeAttribute('readonly');
      addressBar.focus();
      addressBar.select();
    },
    () => {}
  );
});

addressBar.addEventListener('blur', () => {
  // Nach Verlassen wieder sperren
  setTimeout(() => addressBar.setAttribute('readonly', ''), 200);
});

addressBar.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const val = addressBar.value.trim();
    addressBar.setAttribute('readonly', '');
    if (val) requestNavigation(val);
  }
  if (e.key === 'Escape') {
    addressBar.setAttribute('readonly', '');
    addressBar.blur();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FAVORITEN
// ══════════════════════════════════════════════════════════════════════════

function buildFavCard(fav) {
  const card = document.createElement('div');
  card.className = 'fav-card';
  card.style.setProperty('--card-color', fav.color || '#FF6B35');
  card.title = fav.name;

  if (fav.emoji) {
    const em = document.createElement('span');
    em.className = 'fav-emoji';
    em.textContent = fav.emoji;
    card.appendChild(em);
  } else {
    const img = document.createElement('img');
    img.src = fav.icon || '';
    img.alt = fav.name;
    img.onerror = () => {
      const em = document.createElement('span');
      em.className = 'fav-emoji';
      em.textContent = '🌐';
      img.replaceWith(em);
    };
    card.appendChild(img);
  }

  const label = document.createElement('span');
  label.className = 'fav-label';
  label.textContent = fav.name;
  card.appendChild(label);

  // Favoriten brauchen KEINE PIN (explizit erlaubte Seiten)
  card.addEventListener('click', async () => {
    const url = await window.foxiAPI.navigate(fav.url);
    if (url) showBrowser(url);
  });
  return card;
}

async function loadFavorites() {
  const settings = await window.foxiAPI.getSettings();
  const age = settings.ageProfile || 'mittel';
  applyAgeTheme(age);
  const saved = await window.foxiAPI.getFavorites();
  currentFavorites = saved || [...AGE_PROFILES[age].favorites];
  renderFavGrid();
}

function applyAgeTheme(age) {
  document.body.setAttribute('data-age', age);
}

function renderFavGrid() {
  favGrid.innerHTML = '';
  currentFavorites.forEach(fav => favGrid.appendChild(buildFavCard(fav)));
}

// ══════════════════════════════════════════════════════════════════════════
// NAVIGATIONS-BUTTONS
// ══════════════════════════════════════════════════════════════════════════

btnHome.addEventListener('click', showHome);
btnBack.addEventListener('click',    () => { try { webview.goBack();    } catch(_){} });
btnForward.addEventListener('click', () => { try { webview.goForward(); } catch(_){} });
btnReload.addEventListener('click',  () => { try { webview.reload();    } catch(_){} });

document.getElementById('btn-go-home-blocked').addEventListener('click', showHome);
document.getElementById('btn-time-parent').addEventListener('click', () => {
  openPinDialog('Eltern-Bereich', 'PIN eingeben um weiterzusurfen', () => {
    timeLimitReached = false;
    showHome();
  }, () => {});
});

// Fenster-Steuerung
document.getElementById('btn-minimize').addEventListener('click', () => window.foxiAPI.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.foxiAPI.maximize());
document.getElementById('btn-close').addEventListener('click',    () => window.foxiAPI.close());

// ══════════════════════════════════════════════════════════════════════════
// WEBVIEW-EVENTS
// ══════════════════════════════════════════════════════════════════════════

webview.addEventListener('did-start-loading', () => { setLoading(30); lastBlockedByMain = false; });
webview.addEventListener('did-stop-loading',  () => { setLoading(100); setTimeout(() => setLoading(0), 400); updateNavButtons(); });
webview.addEventListener('did-fail-load', e  => { setLoading(0); if (e.errorCode !== -3) updateNavButtons(); });

webview.addEventListener('did-navigate', e => {
  if (lastBlockedByMain) return;
  addressBar.value = e.url;
  updateLockIcon(e.url);
  updateNavButtons();
  // Verlauf speichern
  window.foxiAPI.addHistory({ url: e.url, title: e.url });
});

webview.addEventListener('did-navigate-in-page', e => {
  if (lastBlockedByMain) return;
  addressBar.value = e.url;
  updateLockIcon(e.url);
  updateNavButtons();
});

webview.addEventListener('page-title-updated', e => {
  document.title = e.title ? `${e.title} – FoxiBrowser` : 'FoxiBrowser';
  // Titel im Verlauf nachträglich ergänzen
  if (addressBar.value) window.foxiAPI.addHistory({ url: addressBar.value, title: e.title });
});

// Blockiert-Meldung vom Hauptprozess
window.foxiAPI.onBlocked(data => showBlocked(data));

// ══════════════════════════════════════════════════════════════════════════
// NUTZUNGSZEIT-EVENTS
// ══════════════════════════════════════════════════════════════════════════

window.foxiAPI.onTimeUpdate(data => {
  if (data.limitSeconds <= 0) { timeDisplay.classList.add('hidden'); return; }
  const mins = Math.max(0, Math.ceil(data.remainingSeconds / 60));
  timeDisplay.classList.remove('hidden');
  timeLabel.textContent = `${mins} Min. übrig`;
  if (mins <= 10) timeDisplay.classList.add('warning');
  else            timeDisplay.classList.remove('warning');
});

window.foxiAPI.onTimeLimitReached(() => showTimeLimitPage());

// ══════════════════════════════════════════════════════════════════════════
// ELTERN-PANEL
// ══════════════════════════════════════════════════════════════════════════

const parentPanel = document.getElementById('parent-panel');

// Eltern-Button → PIN-Dialog → Panel öffnen
document.getElementById('btn-parent').addEventListener('click', () => {
  openPinDialog('Eltern-Bereich', 'Bitte die Eltern-PIN eingeben', openParentPanel, () => {});
});

async function openParentPanel() {
  parentPanel.classList.remove('hidden');
  await loadParentHistory();
  await loadParentTime();
  loadParentFavorites();
}

document.getElementById('parent-close').addEventListener('click', () => {
  parentPanel.classList.add('hidden');
});

// Tabs
document.getElementById('parent-tabs').addEventListener('click', async e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  btn.classList.add('active');
  const tab = document.getElementById(`tab-${btn.dataset.tab}`);
  tab.classList.remove('hidden');
  if (btn.dataset.tab === 'history')   await loadParentHistory();
  if (btn.dataset.tab === 'time')      await loadParentTime();
  if (btn.dataset.tab === 'favorites') loadParentFavorites();
  if (btn.dataset.tab === 'profile')   await loadParentProfile();
});

// ── Tab: Verlauf ──────────────────────────────────────────────────────────

async function loadParentHistory() {
  const list = document.getElementById('history-list');
  const history = await window.foxiAPI.getHistory();
  if (!history.length) {
    list.innerHTML = '<p style="color:#555;text-align:center;padding:32px">Kein Verlauf vorhanden.</p>';
    return;
  }
  list.innerHTML = '';
  history.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'history-entry';
    const d = new Date(entry.time);
    const timeStr = `${d.toLocaleDateString('de-DE')} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    let host = '';
    try { host = new URL(entry.url).hostname; } catch(_) { host = entry.url; }
    row.innerHTML = `
      <img class="h-favicon" src="https://www.google.com/s2/favicons?domain=${host}&sz=20" alt="">
      <div class="h-info">
        <div class="h-title">${escHtml(entry.title || entry.url)}</div>
        <div class="h-url">${escHtml(entry.url)}</div>
      </div>
      <span class="h-time">${timeStr}</span>`;
    row.addEventListener('click', () => {
      parentPanel.classList.add('hidden');
      showBrowser(entry.url);
    });
    list.appendChild(row);
  });
}

document.getElementById('btn-clear-history').addEventListener('click', async () => {
  if (!confirm('Verlauf wirklich löschen?')) return;
  await window.foxiAPI.clearHistory();
  await loadParentHistory();
});

// ── Tab: Nutzungszeit ─────────────────────────────────────────────────────

async function loadParentTime() {
  const settings  = await window.foxiAPI.getSettings();
  const usedSecs  = await window.foxiAPI.getUsageToday();
  const weekData  = await window.foxiAPI.getUsageWeek();
  const limitMins = settings.timeLimitMinutes || 0;

  document.getElementById('usage-today-val').textContent = fmtTime(usedSecs);
  document.getElementById('usage-limit-val').textContent = limitMins > 0 ? fmtTime(limitMins * 60) : 'Kein Limit';

  // Wochengraph
  const maxSecs = Math.max(...weekData.map(d => d.seconds), 1);
  const bars    = document.getElementById('chart-bars');
  const labels  = document.getElementById('chart-labels');
  bars.innerHTML = '';
  labels.innerHTML = '';
  const today = new Date().toISOString().slice(0,10);
  weekData.forEach(d => {
    const bar = document.createElement('div');
    bar.className = 'chart-bar' + (d.date === today ? ' today' : '');
    bar.style.height = Math.max(4, (d.seconds / maxSecs) * 76) + 'px';
    bar.title = `${fmtTime(d.seconds)}`;
    bars.appendChild(bar);
    const label = document.createElement('div');
    label.className = 'chart-label';
    label.textContent = new Date(d.date).toLocaleDateString('de-DE', {weekday:'short'});
    labels.appendChild(label);
  });

  // Limit-Slider
  const slider = document.getElementById('limit-range');
  slider.value = limitMins;
  updateLimitDisplay(limitMins);
  document.querySelectorAll('.preset-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.mins) === limitMins);
  });
}

function updateLimitDisplay(mins) {
  document.getElementById('limit-display').textContent = mins > 0 ? fmtTime(mins * 60) : 'Kein Limit';
}

document.getElementById('limit-range').addEventListener('input', e => {
  updateLimitDisplay(parseInt(e.target.value));
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
});

document.getElementById('limit-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  const mins = parseInt(btn.dataset.mins);
  document.getElementById('limit-range').value = mins;
  updateLimitDisplay(mins);
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b === btn));
});

document.getElementById('btn-save-limit').addEventListener('click', async () => {
  const mins = parseInt(document.getElementById('limit-range').value);
  const settings = await window.foxiAPI.getSettings();
  settings.timeLimitMinutes = mins;
  await window.foxiAPI.setSettings(settings);
  await loadParentTime();
  if (mins > 0) {
    const usedSecs = await window.foxiAPI.getUsageToday();
    if (usedSecs >= mins * 60) showTimeLimitPage();
  }
  alert(`Tages-Limit gespeichert: ${mins > 0 ? fmtTime(mins * 60) : 'Kein Limit'}`);
});

document.getElementById('btn-reset-today').addEventListener('click', async () => {
  if (!confirm('Heutigen Nutzungszähler wirklich zurücksetzen?')) return;
  await window.foxiAPI.resetUsageToday();
  timeLimitReached = false;
  await loadParentTime();
});

// ── Tab: Favoriten-Editor ─────────────────────────────────────────────────

let editingFavorites = [];

function loadParentFavorites() {
  editingFavorites = currentFavorites.map(f => ({ ...f }));
  renderFavEditor();
}

function renderFavEditor() {
  const list = document.getElementById('fav-editor-list');
  list.innerHTML = '';
  editingFavorites.forEach((fav, idx) => {
    const row = document.createElement('div');
    row.className = 'fav-editor-row';
    row.innerHTML = `
      <span class="fav-editor-emoji">${fav.emoji || '🌐'}</span>
      <span class="fav-editor-name">${escHtml(fav.name)}</span>
      <span class="fav-editor-url">${escHtml(fav.url)}</span>
      <button type="button" class="fav-del-btn" data-idx="${idx}" title="Löschen">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.fav-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      editingFavorites.splice(i, 1);
      renderFavEditor();
    });
  });
}

document.getElementById('btn-add-fav').addEventListener('click', () => {
  const name  = document.getElementById('new-fav-name').value.trim();
  const url   = document.getElementById('new-fav-url').value.trim();
  const emoji = document.getElementById('new-fav-emoji').value.trim() || '🌐';
  const errEl = document.getElementById('add-fav-error');

  if (!name) { showAddFavError('Bitte einen Namen eingeben.'); return; }
  if (!url)  { showAddFavError('Bitte eine Adresse eingeben.'); return; }

  const fullUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  editingFavorites.push({ name, url: fullUrl, emoji, color: '#FF6B35' });
  renderFavEditor();
  document.getElementById('new-fav-name').value  = '';
  document.getElementById('new-fav-url').value   = '';
  document.getElementById('new-fav-emoji').value = '';
  errEl.classList.add('hidden');
});

function showAddFavError(msg) {
  const errEl = document.getElementById('add-fav-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

document.getElementById('btn-save-favorites').addEventListener('click', async () => {
  if (!editingFavorites.length) { alert('Bitte mindestens eine Seite behalten.'); return; }
  currentFavorites = editingFavorites.map(f => ({ ...f }));
  await window.foxiAPI.setFavorites(currentFavorites);
  renderFavGrid();
  alert('Startseite gespeichert!');
});

// ── Tab: PIN ändern ───────────────────────────────────────────────────────

document.getElementById('btn-save-pin').addEventListener('click', async () => {
  const current  = document.getElementById('pin-current').value;
  const newPin   = document.getElementById('pin-new').value;
  const confirm2 = document.getElementById('pin-confirm').value;
  const msgEl    = document.getElementById('pin-change-msg');

  const showMsg = (text, type) => {
    msgEl.textContent = text;
    msgEl.className = type;
    msgEl.classList.remove('hidden');
  };

  if (!current || !newPin || !confirm2) { showMsg('Bitte alle Felder ausfüllen.', 'error'); return; }
  if (!/^\d{4}$/.test(newPin))          { showMsg('Die PIN muss genau 4 Ziffern haben.', 'error'); return; }
  if (newPin !== confirm2)               { showMsg('Die neuen PINs stimmen nicht überein.', 'error'); return; }

  const ok = await window.foxiAPI.verifyPin(current);
  if (!ok) { showMsg('Die aktuelle PIN ist falsch.', 'error'); return; }

  const settings = await window.foxiAPI.getSettings();
  settings.pin = newPin;
  await window.foxiAPI.setSettings(settings);

  document.getElementById('pin-current').value = '';
  document.getElementById('pin-new').value     = '';
  document.getElementById('pin-confirm').value = '';
  showMsg('✓ PIN erfolgreich geändert!', 'success');
});

// ── Tab: Kind-Profil ──────────────────────────────────────────────────────

let selectedAge = 'mittel';

async function loadParentProfile() {
  const settings = await window.foxiAPI.getSettings();
  selectedAge = settings.ageProfile || 'mittel';
  document.querySelectorAll('.age-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.age === selectedAge);
  });
  document.getElementById('age-profile-note').classList.add('hidden');
}

document.getElementById('age-profile-cards').addEventListener('click', e => {
  const card = e.target.closest('.age-card');
  if (!card) return;
  selectedAge = card.dataset.age;
  document.querySelectorAll('.age-card').forEach(c => c.classList.toggle('selected', c === card));
  document.getElementById('age-profile-note').classList.remove('hidden');
});

document.getElementById('btn-save-profile').addEventListener('click', async () => {
  const settings = await window.foxiAPI.getSettings();
  const prevAge = settings.ageProfile || 'mittel';
  settings.ageProfile = selectedAge;
  await window.foxiAPI.setSettings(settings);

  applyAgeTheme(selectedAge);

  // Wenn Altersgruppe gewechselt → Favoriten auf Standard zurücksetzen
  if (prevAge !== selectedAge) {
    currentFavorites = [...AGE_PROFILES[selectedAge].favorites];
    await window.foxiAPI.setFavorites(currentFavorites);
    renderFavGrid();
  }
  document.getElementById('age-profile-note').classList.add('hidden');
  alert(`Profil gespeichert: ${AGE_PROFILES[selectedAge].label}`);
});

// ══════════════════════════════════════════════════════════════════════════
// HILFSFUNKTIONEN
// ══════════════════════════════════════════════════════════════════════════

function fmtTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} Std. ${m} Min.`;
  return `${m} Min.`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════════════════════════
// RECHTSKLICK-MENÜ
// ══════════════════════════════════════════════════════════════════════════

const ctxMenu   = document.getElementById('context-menu');
let ctxHasText  = false;
let ctxEditable = false;

function showCtxMenu(x, y, hasText, editable) {
  ctxHasText  = hasText;
  ctxEditable = editable;
  document.getElementById('ctx-copy').disabled    = !hasText;
  document.getElementById('ctx-paste').disabled   = !editable;
  document.getElementById('ctx-back').disabled    = !webview.canGoBack();
  document.getElementById('ctx-forward').disabled = !webview.canGoForward();

  ctxMenu.classList.remove('hidden');

  // Menü bleibt innerhalb des Fensters
  const mw = ctxMenu.offsetWidth  || 180;
  const mh = ctxMenu.offsetHeight || 200;
  ctxMenu.style.left = (x + mw > window.innerWidth  ? x - mw : x) + 'px';
  ctxMenu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';
}

function hideCtxMenu() { ctxMenu.classList.add('hidden'); }

// Rechtsklick: Position kommt vom Hauptprozess (screen.getCursorScreenPoint)
window.foxiAPI.onContextMenu(data => {
  if (isHome) return;
  showCtxMenu(data.x, data.y, !!data.selectionText, !!data.isEditable);
});

// Menü-Aktionen
document.getElementById('ctx-copy').addEventListener('click',    () => { webview.copy();    hideCtxMenu(); });
document.getElementById('ctx-paste').addEventListener('click',   () => { webview.paste();   hideCtxMenu(); });
document.getElementById('ctx-print').addEventListener('click',   () => { webview.print();   hideCtxMenu(); });
document.getElementById('ctx-back').addEventListener('click',    () => { try { webview.goBack();    } catch(_){} hideCtxMenu(); });
document.getElementById('ctx-forward').addEventListener('click', () => { try { webview.goForward(); } catch(_){} hideCtxMenu(); });
document.getElementById('ctx-reload').addEventListener('click',  () => { try { webview.reload();    } catch(_){} hideCtxMenu(); });

// Menü schließen bei Klick außerhalb
document.addEventListener('click',      e => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
document.addEventListener('keydown',    e => { if (e.key === 'Escape') hideCtxMenu(); });
webview.addEventListener('will-navigate', hideCtxMenu);

// ══════════════════════════════════════════════════════════════════════════
// AUTO-UPDATE & VERSION
// ══════════════════════════════════════════════════════════════════════════

const updateBanner = document.getElementById('update-banner');

window.foxiAPI.onUpdateAvailable(info => {
  document.getElementById('update-text').textContent =
    `🦊 Update ${info.version} verfügbar – wird heruntergeladen…`;
  updateBanner.classList.remove('hidden');
});

window.foxiAPI.onUpdateDownloaded(info => {
  document.getElementById('update-text').textContent =
    `✅ Update ${info.version} bereit zum Installieren`;
  updateBanner.classList.remove('hidden');
});

document.getElementById('btn-install-update').addEventListener('click', () => {
  window.foxiAPI.installUpdate();
});
document.getElementById('btn-update-later').addEventListener('click', () => {
  updateBanner.classList.add('hidden');
});

// Version im Eltern-Panel anzeigen
async function showVersionInPanel() {
  const v = await window.foxiAPI.getVersion();
  const el = document.getElementById('parent-version');
  if (el) el.textContent = `FoxiBrowser v${v}`;
}

document.getElementById('btn-check-update').addEventListener('click', () => {
  window.foxiAPI.checkForUpdate();
  document.getElementById('update-text').textContent = '🔄 Suche nach Updates…';
  updateBanner.classList.remove('hidden');
  setTimeout(() => {
    if (document.getElementById('update-text').textContent.startsWith('🔄'))
      updateBanner.classList.add('hidden');
  }, 4000);
});

// ══════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════

loadFavorites();
showHome();
showVersionInPanel();
