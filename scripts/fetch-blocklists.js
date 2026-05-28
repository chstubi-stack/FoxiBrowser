// Lädt Steven Black's Hosts-Liste und extrahiert blockierte Domains
const https = require('https');
const fs = require('fs');
const path = require('path');

const HOSTS_URL =
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-gambling-porn/hosts';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function fetchAndParse() {
  console.log('Lade Steven Black Hosts-Liste...');
  const raw = await fetchText(HOSTS_URL);

  const domains = raw
    .split('\n')
    .filter(l => l.startsWith('0.0.0.0 '))
    .map(l => l.split(' ')[1]?.trim())
    .filter(l => l && l !== 'localhost' && !l.includes(' ') && l.includes('.'));

  const outPath = path.join(__dirname, '..', 'src', 'blocklists', 'adult.txt');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, domains.join('\n'), 'utf8');
  console.log(`${domains.length} blockierte Domains gespeichert → adult.txt`);
}

fetchAndParse().catch(err => {
  console.error('Fehler beim Laden der Blockliste:', err.message);
  // Erstelle leere Datei damit main.js nicht abstürzt
  const outPath = path.join(__dirname, '..', 'src', 'blocklists', 'adult.txt');
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, '', 'utf8');
  process.exit(1);
});
