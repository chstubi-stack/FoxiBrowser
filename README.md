# FoxiBrowser – Sicherer Kinder-Browser für Windows

Ein kindgerechter Desktop-Browser auf Basis von Electron. Gebaut für Windows 11, installierbar als `.exe`.

---

## Projektstruktur

```
FoxiBrowser/
├── main.js                        # Electron Hauptprozess (Fenster, Sicherheit, IPC)
├── preload.js                     # Sichere Brücke zwischen Main und Renderer
├── electron-builder.yml           # Installer-Konfiguration (NSIS für Windows)
├── package.json                   # Abhängigkeiten und Build-Skripte
│
├── src/
│   ├── renderer/
│   │   ├── index.html             # Komplette Browser-UI (alle Overlays, Panels)
│   │   ├── renderer.js            # Gesamte UI-Logik
│   │   └── styles.css             # Alle Styles inkl. Altersprofile
│   ├── blocklists/
│   │   └── adult.txt              # ~167.000 blockierte Domains (Steven Black)
│   └── assets/
│       ├── icon.svg               # Quell-Icon (Fuchs, editierbar)
│       ├── icon.png               # Generiert aus SVG (256×256)
│       └── icon.ico               # Generiert aus SVG (alle Größen)
│
└── scripts/
    ├── fetch-blocklists.js        # Lädt Steven Black Hosts-Liste neu herunter
    ├── generate-icons.js          # Erzeugt icon.png + icon.ico aus icon.svg
    └── after-pack.js              # afterPack-Hook: bettet Icon in EXE ein
```

---

## Technologie-Stack

| Technologie | Version | Zweck |
|---|---|---|
| Electron | 30.x | Desktop-Fenster + Chromium-Engine |
| @ghostery/adblocker-electron | 2.x | Werbeblocker (uBlock-Origin-Basis) |
| electron-store | 10.x | Persistente Einstellungen (JSON) |
| electron-builder | 24.x | Windows NSIS-Installer |
| sharp + to-ico | – | Icon-Generierung aus SVG |
| rcedit | – | Icon in EXE einbetten (afterPack-Hook) |

---

## Sicherheitsschichten (5 Lagen)

1. **Steven Black Hosts-Liste** – 167.000 Adult/Glücksspiel/Fake-News-Domains blockiert (O(1)-Set-Lookup)
2. **Cloudflare for Families DoH** – DNS-Blocking von Adult + Malware (1.1.1.3)
3. **@ghostery/adblocker-electron** – Werbung + Tracker (EasyList, EasyPrivacy, EasyList Germany, uBlock-Listen, Fanboy Annoyances)
4. **webview in separatem Prozess** – `partition="persist:child"`, `contextIsolation=true`
5. **Kein Popup, kein neues Fenster** – `allowpopups="false"`, `setWindowOpenHandler` → deny

---

## Wichtige Konzepte

### PIN-System
- Standard-PIN: `1234` (beim ersten Start gesetzt)
- PIN wird gehasht als Klartext in `electron-store` unter `settings.pin` gespeichert
- Adressleiste ist `readonly` → Klick öffnet PIN-Dialog → Elternteil gibt PIN ein
- Favoriten auf der Startseite benötigen **keine** PIN (explizit erlaubte Seiten)
- Eltern-Bereich öffnet sich nur nach PIN-Eingabe

### Datenspeicherung (`electron-store`)
Alle Daten liegen in `%APPDATA%\FoxiBrowser\config.json`:
```json
{
  "settings": {
    "pin": "1234",
    "timeLimitMinutes": 60,
    "ageProfile": "mittel"
  },
  "favorites": [ ... ],
  "history":   [ ... ],
  "usageData": { "2025-05-24": 3600 }
}
```

### Altersprofile
Definiert in `src/renderer/renderer.js` → `AGE_PROFILES`:

| Profil | Key | Alter | Theme |
|---|---|---|---|
| Klein | `klein` | 3–6 | Pink, sehr große Buttons |
| Mittel | `mittel` | 7–10 | Orange (Standard-Foxi) |
| Groß | `gross` | 11–14 | Indigo/Blau, ruhiger |

Das aktive Profil wird als `data-age="..."` auf `<body>` gesetzt. CSS-Variablen in `styles.css` überschreiben das Theme automatisch.

### Webview-Navigation
- `webview.loadURL(url)` statt `webview.src` – nur so funktioniert Re-Navigation zuverlässig
- Blockierte Domains: `details.resourceType === 'mainFrame'` prüfen, sonst erscheint die Blockiert-Seite auch für Hintergrund-Requests (Bilder, Skripte etc.)

### Werbeblocker-Cache
- Pfad: `%APPDATA%\FoxiBrowser\adblocker-cache.bin`
- Erster Start: lädt alle Filterlisten, serialisiert als Binär-Cache
- Folgestarts: Cache sofort laden, im Hintergrund aktualisieren
- Cache löschen → erzwingt Neu-Download beim nächsten Start

---

## Häufige Anpassungen

### Startseite: Seite hinzufügen oder entfernen
Datei: `src/renderer/renderer.js`, Objekt `AGE_PROFILES`

```js
// Beispiel: Seite bei "Mittel" hinzufügen
{ name: 'ZDFtivi', url: 'https://www.zdf.de/kinder', emoji: '📺', color: '#E53935' },
```

Felder: `name` (Anzeigename), `url` (vollständige URL), `emoji` (Icon), `color` (Akzentfarbe der Karte)

### Neue Altersgruppe oder anderes Design
1. In `src/renderer/renderer.js` → `AGE_PROFILES` neues Objekt anlegen
2. In `src/renderer/styles.css` → `body[data-age="..."]` Block anlegen (CSS-Variablen überschreiben)
3. In `src/renderer/index.html` → `.age-card` im Tab "Kind-Profil" ergänzen
4. In `src/renderer/renderer.js` → `AGE_PROFILES[age]` Referenzen anpassen

### Farben / Design ändern
Datei: `src/renderer/styles.css`, Abschnitt `:root { ... }`

```css
--foxi-orange:  #FF6B35;   /* Hauptfarbe (Buttons, Titelleiste, Navbar) */
--foxi-orange2: #FF8C42;   /* Gradient-Endfarbe */
--foxi-cream:   #FFF8F0;   /* Hintergrundfarbe der App */
--foxi-brown:   #6D4C41;   /* Textfarbe */
--foxi-green:   #4CAF50;   /* "Los!"-Button */
--foxi-red:     #EF5350;   /* Fehler/Blockiert */
```

### Fuchs-Icon ändern
1. `src/assets/icon.svg` editieren (SVG, 256×256)
2. `npm run generate-icons` ausführen → erzeugt `icon.png` + `icon.ico`
3. `npm run build:win` → Icon wird automatisch in EXE eingebettet (afterPack-Hook)

### Domain zur Blockliste hinzufügen
Datei: `src/blocklists/adult.txt` – eine Domain pro Zeile:
```
example-bad-site.com
another-bad-site.de
```
Oder alle Listen neu herunterladen: `npm run fetch-lists`

### Neue Werbeblocker-Filterliste hinzufügen
Datei: `main.js`, Array `AD_FILTER_LISTS` – URL einfach ergänzen:
```js
'https://example.com/meine-filterliste.txt',
```
Danach `adblocker-cache.bin` löschen damit die neue Liste beim nächsten Start geladen wird.

### PIN-Länge ändern
- `src/renderer/index.html`: Anzahl `<span class="pin-dot">` anpassen
- `src/renderer/renderer.js`: `pinBuffer.length < 4` → andere Zahl
- `src/renderer/renderer.js`: `/^\d{4}$/` Regex anpassen
- `src/renderer/styles.css`: `#pin-dots-row` Grid ggf. anpassen

### Nutzungszeit-Tracking deaktivieren
`main.js`: `usageCheckInterval`-Block auskommentieren, `mainWindow.on('focus')` und `mainWindow.on('blur')` entfernen.

---

## Build & Entwicklung

```bash
# Abhängigkeiten installieren
npm install

# App direkt starten (ohne Installer)
npm start

# Blockliste aktualisieren (~167k Domains)
npm run fetch-lists

# Icons neu generieren
npm run generate-icons

# Windows-Installer bauen → build/installer/FoxiBrowser Setup 1.0.0.exe
npm run build:win
```

> **Hinweis:** `npm run build:win` läuft auf Windows ohne Developer Mode. Der `afterPack`-Hook (`scripts/after-pack.js`) bettet das Icon automatisch mit `rcedit` ein.

---

## IPC-Schnittstelle (preload.js ↔ main.js)

Alle Renderer-Aufrufe laufen über `window.foxiAPI`:

| Methode | Richtung | Beschreibung |
|---|---|---|
| `navigate(url)` | Renderer → Main | URL sanitizen + zurückgeben |
| `getFavorites()` | Renderer → Main | Favoriten aus Store laden |
| `setFavorites(favs)` | Renderer → Main | Favoriten speichern |
| `getSettings()` | Renderer → Main | Einstellungen laden (PIN, Limit, Profil) |
| `setSettings(s)` | Renderer → Main | Einstellungen speichern |
| `verifyPin(pin)` | Renderer → Main | PIN prüfen → true/false |
| `addHistory(entry)` | Renderer → Main | Verlaufseintrag speichern |
| `getHistory()` | Renderer → Main | Verlauf laden |
| `clearHistory()` | Renderer → Main | Verlauf löschen |
| `getUsageToday()` | Renderer → Main | Heutige Nutzung in Sekunden |
| `getUsageWeek()` | Renderer → Main | Letzte 7 Tage [{date, seconds}] |
| `resetUsageToday()` | Renderer → Main | Heutigen Zähler zurücksetzen |
| `onBlocked(cb)` | Main → Renderer | Event wenn Domain blockiert wird |
| `onTimeUpdate(cb)` | Main → Renderer | Minütliches Zeitupdate |
| `onTimeLimitReached(cb)` | Main → Renderer | Event wenn Zeitlimit überschritten |

---

## Bekannte Einschränkungen

- **Cosmetic Filtering in Webviews**: CSS-basiertes Ausblenden von Werbeelementen (z.B. Werbebanner die nicht per Netzwerk-Request blockierbar sind) funktioniert in Electron-Webviews eingeschränkt. Netzwerk-basierte Werbung wird zuverlässig blockiert.
- **HTTPS-Zertifikatsfehler**: Werden automatisch akzeptiert (`app.on('certificate-error')`). Für produktiven Einsatz mit strengeren Anforderungen deaktivieren.
- **Offline-Start**: Adblocker-Cache muss mindestens einmal online geladen worden sein. Danach funktioniert der Browser vollständig offline.
- **winCodeSign / rcedit**: electron-builder kann unter Windows ohne Developer Mode keine Symlinks aus 7z-Archiven extrahieren. Workaround: `node_modules/app-builder-lib/out/winPackager.js` ist gepatcht (rcedit-Block auf `!== "win32"` beschränkt). Stattdessen übernimmt `scripts/after-pack.js` das Icon-Einbetten via npm-Paket `rcedit`.
