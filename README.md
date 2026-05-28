# FoxiBrowser – Sicherer Kinder-Browser für Windows

Ein kindgerechter Desktop-Browser auf Basis von Electron. Gebaut für Windows 11, installierbar als `.exe`.

---

## Aktuelle Version

| Version | Änderung |
|---|---|
| 1.0.0 | Erstveröffentlichung |
| 1.1.0 | Eltern-PIN, Altersprofile, erweiterter Adblocker, Rechtsklick-Menü, Auto-Updater |
| 1.1.1 | Fix: Rechtsklick-Menü Position (Mauszeiger) |
| 1.1.2 | Fix: Rechtsklick-Position via e.params.x/y |
| 1.1.3 | Fix: Rechtsklick-Position via mousedown |
| 1.1.4 | Fix: Rechtsklick-Position via screen.getCursorScreenPoint() |
| 1.1.5 | Fix: Menü schließt bei Linksklick (Backdrop) |
| 1.1.6 | Fix: Backdrop + Copy/Paste mit Webview-Fokus |
| 1.1.7 | Feature: Tastenkürzel im Rechtsklick-Menü |
| 1.1.8 | Feature: Fenster-Buttons farbig (rot/gelb/grün) |
| 1.1.9 | Fix: Symbole auf Fenster-Buttons sichtbar |
| 1.1.10 | Fix: color:transparent entfernt |
| 1.1.11 | Feature: SVG Schloss-Icon für Eltern-Button |

---

## Projektstruktur

```
FoxiBrowser/
├── main.js                        # Electron Hauptprozess (Fenster, Sicherheit, IPC, Updater)
├── preload.js                     # Sichere Brücke zwischen Main und Renderer
├── electron-builder.yml           # Installer + GitHub-Publish-Konfiguration
├── package.json                   # Abhängigkeiten und Build-Skripte
│
├── src/
│   ├── renderer/
│   │   ├── index.html             # Komplette Browser-UI
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
    └── after-pack.js              # afterPack-Hook: bettet Icon in EXE ein (rcedit)
```

---

## Technologie-Stack

| Technologie | Version | Zweck |
|---|---|---|
| Electron | 30.x | Desktop-Fenster + Chromium-Engine |
| @ghostery/adblocker-electron | 2.x | Werbeblocker (uBlock-Origin-Basis) |
| electron-store | 8.x | Persistente Einstellungen (JSON) |
| electron-updater | 6.x | Auto-Updates via GitHub Releases |
| electron-builder | 24.x | Windows NSIS-Installer + GitHub Publish |
| sharp + to-ico | – | Icon-Generierung aus SVG |
| rcedit | 5.x | Icon in EXE einbetten (afterPack-Hook) |

---

## Sicherheitsschichten (5 Lagen)

1. **Steven Black Hosts-Liste** – 167.000 Adult/Glücksspiel/Fake-News-Domains (O(1)-Set-Lookup)
2. **Cloudflare for Families DoH** – DNS-Blocking von Adult + Malware (1.1.1.3)
3. **@ghostery/adblocker-electron** – Werbung + Tracker (7 Filterlisten, siehe unten)
4. **webview in separatem Prozess** – `partition="persist:child"`, `contextIsolation=true`
5. **Kein Popup, kein neues Fenster** – `allowpopups="false"`, `setWindowOpenHandler` → deny

### Werbeblocker-Filterlisten

| Liste | Blockiert |
|---|---|
| EasyList | Werbebanner weltweit |
| EasyPrivacy | Tracker & Analysetools |
| EasyList Germany | Deutsche Werbung (IQ Digital, Stroeer, etc.) |
| uBlock Origin filters | Umfassende Werberegeln |
| uBlock Privacy | Weitere Tracker |
| uBlock Unbreak | Verhindert Seitenbrüche durch Blocker |
| Fanboy Annoyances | Cookie-Banner, Overlays, Popups |

**Cache:** Filterlisten werden beim ersten Start heruntergeladen und als Binär-Cache gespeichert (`%APPDATA%\FoxiBrowser\adblocker-cache.bin`). Folgestarts laden den Cache sofort, Updates laufen im Hintergrund.

---

## Features

### Eltern-Bereich (PIN-geschützt)
- Standard-PIN: `1234` (bitte beim ersten Start ändern)
- Zugang über 🔒-Button oben rechts in der Titelleiste
- **Verlauf:** alle besuchten Seiten mit Favicon, Uhrzeit, löschbar
- **Nutzungszeit:** Tages-Statistik, Wochendiagramm, Tages-Limit (0–240 Min.)
- **Startseite:** Favoriten hinzufügen, löschen, neu anordnen
- **PIN ändern:** aktuelle PIN bestätigen, neue 4-stellige PIN setzen
- **Kind-Profil:** Altersgruppe wählen → Design + Startseite passen sich automatisch an

### PIN-Gate (Adressleiste)
- Adressleiste ist `readonly` – Kind kann keine URL direkt eingeben
- Klick auf Adressleiste → PIN-Dialog öffnet sich
- Nach PIN-Eingabe: Elternteil gibt URL ein
- **Favoriten** auf der Startseite benötigen **keine** PIN (explizit erlaubte Seiten)

### Altersprofile

| Profil | Key | Alter | Theme | Startseiten |
|---|---|---|---|---|
| Klein | `klein` | 3–6 | Pink, sehr große Buttons | YouTube Kids, KiKA, Die Maus, tivi, Toggo, Sesamstraße |
| Mittel | `mittel` | 7–10 | Orange (Standard-Foxi) | YouTube Kids, KiKA, Maus, logo!, Blinde Kuh, Wikipedia, Scratch |
| Groß | `gross` | 11–14 | Indigo/Blau, ruhiger | Wikipedia, YouTube, Khan Academy, Scratch, Planet Wissen, ZDFtivi |

Das aktive Profil wird als `data-age="..."` auf `<body>` gesetzt. CSS-Variablen in `styles.css` überschreiben das Theme automatisch.

### Rechtsklick-Menü (im Browser)
Erscheint bei Rechtsklick auf eine geöffnete Webseite:

| Aktion | Kürzel | Hinweis |
|---|---|---|
| Kopieren | `Strg+C` | Nur aktiv wenn Text markiert |
| Einfügen | `Strg+V` | Nur aktiv in Eingabefeldern |
| Drucken | `Strg+P` | Öffnet Windows-Druckdialog |
| Zurück | `Alt+←` | Nur aktiv wenn Verlauf vorhanden |
| Vorwärts | `Alt+→` | Nur aktiv wenn Verlauf vorhanden |
| Neu laden | `F5` | – |

Menü schließt sich bei Linksklick irgendwo, Escape oder Navigation.

### Auto-Update (GitHub Releases)
- Prüft 5 Sekunden nach dem Start auf neue Version
- Lädt Update automatisch im Hintergrund herunter
- Zeigt Banner unten rechts: „Update X.X.X bereit"
- „Jetzt installieren" → Browser schließt, installiert, startet neu
- Prüft alle 4 Stunden erneut
- Manuell: Eltern-Panel → Footer → „🔄 Nach Updates suchen"

### Fenster-Buttons
- 🔴 **Rot** (`#FF5F57`) – Schließen
- 🟡 **Gelb** (`#FFBD2E`) – Minimieren
- 🟢 **Grün** (`#28C840`) – Maximieren
- Beim Hover: Symbol wird sichtbarer, Button wird leicht dunkler

---

## Datenspeicherung (`electron-store`)

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

---

## IPC-Schnittstelle (preload.js ↔ main.js)

Alle Renderer-Aufrufe laufen über `window.foxiAPI`:

| Methode | Richtung | Beschreibung |
|---|---|---|
| `navigate(url)` | R→M | URL sanitizen + zurückgeben |
| `getVersion()` | R→M | App-Version aus package.json |
| `checkForUpdate()` | R→M | Manuell nach Update suchen |
| `installUpdate()` | R→M | Update installieren und neu starten |
| `getFavorites()` | R→M | Favoriten aus Store laden |
| `setFavorites(favs)` | R→M | Favoriten speichern |
| `getSettings()` | R→M | Einstellungen laden (PIN, Limit, Profil) |
| `setSettings(s)` | R→M | Einstellungen speichern |
| `verifyPin(pin)` | R→M | PIN prüfen → true/false |
| `addHistory(entry)` | R→M | Verlaufseintrag speichern |
| `getHistory()` | R→M | Verlauf laden |
| `clearHistory()` | R→M | Verlauf löschen |
| `getUsageToday()` | R→M | Heutige Nutzung in Sekunden |
| `getUsageWeek()` | R→M | Letzte 7 Tage [{date, seconds}] |
| `resetUsageToday()` | R→M | Heutigen Zähler zurücksetzen |
| `onContextMenu(cb)` | M→R | Rechtsklick-Position + Kontext |
| `onBlocked(cb)` | M→R | Event wenn Domain blockiert wird |
| `onTimeUpdate(cb)` | M→R | Minütliches Zeitupdate |
| `onTimeLimitReached(cb)` | M→R | Event wenn Zeitlimit überschritten |
| `onUpdateAvailable(cb)` | M→R | Update verfügbar |
| `onUpdateDownloaded(cb)` | M→R | Update heruntergeladen + bereit |

---

## Build & Entwicklung

```bash
# Abhängigkeiten installieren
npm install

# App direkt starten (ohne Installer)
npm start

# Blockliste aktualisieren (~167k Domains)
npm run fetch-lists

# Icons neu generieren (aus icon.svg)
npm run generate-icons

# Windows-Installer lokal bauen
npm run build:win

# Installer bauen + als GitHub Release veröffentlichen
$env:GH_TOKEN = "ghp_DEIN_TOKEN"
npm run build:win -- --publish always
```

### Versionsnummer erhöhen

```bash
npm run version:patch   # 1.1.11 → 1.1.12  (Bugfix)
npm run version:minor   # 1.1.11 → 1.2.0   (Neue Funktion)
npm run version:major   # 1.1.11 → 2.0.0   (Großes Update)
```

### Kompletter Update-Workflow

```powershell
# 1. Änderungen machen
# 2. Version erhöhen
npm run version:patch

# 3. Auf GitHub speichern
git add .
git commit -m "Fix: Beschreibung des Bugfixes"
git push

# 4. Installer bauen + Release veröffentlichen
$env:GH_TOKEN = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
npm run build:win -- --publish always
```

---

## GitHub-Konfiguration

- **Repository:** https://github.com/chstubi-stack/FoxiBrowser
- **Token:** Als Windows-Umgebungsvariable `GH_TOKEN` gespeichert
- **electron-builder.yml:** `publish.owner = chstubi-stack`, `publish.repo = FoxiBrowser`
- **Token erneuern:** github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)

---

## Häufige Anpassungen

### Startseite: Seite hinzufügen oder entfernen
Datei: `src/renderer/renderer.js`, Objekt `AGE_PROFILES`

```js
// Beispiel: Seite bei "Mittel" hinzufügen
{ name: 'ZDFtivi', url: 'https://www.zdf.de/kinder', emoji: '📺', color: '#E53935' },
```

Felder: `name` (Anzeigename), `url` (vollständige URL), `emoji` (Icon), `color` (Akzentfarbe)

### Farben der Fenster-Buttons ändern
Datei: `src/renderer/styles.css`:

```css
#btn-minimize { background: #FFBD2E; }  /* Gelb  */
#btn-maximize { background: #28C840; }  /* Grün  */
#btn-close    { background: #FF5F57; }  /* Rot   */
```

### Neue Werbeblocker-Filterliste hinzufügen
Datei: `main.js`, Array `AD_FILTER_LISTS`:

```js
'https://example.com/meine-filterliste.txt',
```

Danach `%APPDATA%\FoxiBrowser\adblocker-cache.bin` löschen → erzwingt Neu-Download.

### Rechtsklick-Menü: Eintrag hinzufügen
1. `src/renderer/index.html` – neuen `<button class="ctx-item">` eintragen
2. `src/renderer/renderer.js` – Event-Listener für neuen Button ergänzen

### PIN-Länge ändern
- `src/renderer/index.html`: Anzahl `<span class="pin-dot">` anpassen
- `src/renderer/renderer.js`: `pinBuffer.length < 4` → andere Zahl + `/^\d{4}$/` Regex
- `src/renderer/styles.css`: `#pin-dots-row` Grid ggf. anpassen

### Fuchs-Icon ändern
1. `src/assets/icon.svg` editieren (SVG, 256×256 Viewbox)
2. `npm run generate-icons` → erzeugt `icon.png` + `icon.ico`
3. `npm run build:win` → Icon wird automatisch via `after-pack.js` in EXE eingebettet

---

## Bekannte Einschränkungen

- **Cosmetic Filtering:** CSS-basiertes Ausblenden von Werbeelementen funktioniert in Electron-Webviews eingeschränkt. Netzwerk-basierte Werbung wird zuverlässig blockiert.
- **HTTPS-Zertifikatsfehler:** Werden automatisch akzeptiert (`app.on('certificate-error')`). Für strengere Sicherheitsanforderungen deaktivieren.
- **Offline-Start:** Adblocker-Cache muss mindestens einmal online geladen worden sein. Danach vollständig offline nutzbar.
- **winCodeSign / rcedit:** electron-builder kann unter Windows ohne Developer Mode keine Symlinks aus 7z-Archiven extrahieren. Workaround: `node_modules/app-builder-lib/out/winPackager.js` ist gepatcht (rcedit-Block auf `!== "win32"` beschränkt). Stattdessen übernimmt `scripts/after-pack.js` das Icon-Einbetten via npm-Paket `rcedit`.
- **Auto-Update:** Benötigt GitHub-Repository mit öffentlichen Releases und gesetzten `GH_TOKEN`. Ohne Token erscheint nur lokal die Konsolenwarnung, die App startet trotzdem normal.
