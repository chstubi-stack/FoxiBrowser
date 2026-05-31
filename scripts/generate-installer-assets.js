'use strict';
// Erzeugt installer-sidebar.bmp (164x314) und installer-header.bmp (150x57)
const fs   = require('fs');
const path = require('path');

function writeBmp(filePath, width, height, drawFn) {
  const rowSize   = Math.ceil((width * 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowSize * height, 0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = drawFn(x, y, width, height);
      const idx = (height - 1 - y) * rowSize + x * 3; // BMP ist bottom-up
      pixelData[idx]     = b;
      pixelData[idx + 1] = g;
      pixelData[idx + 2] = r;
    }
  }

  const fileSize = 54 + pixelData.length;
  const buf = Buffer.alloc(fileSize);

  // File Header
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);

  // DIB Header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width,  18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1,  26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelData.length, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  pixelData.copy(buf, 54);
  fs.writeFileSync(filePath, buf);
  console.log(`✅ ${path.basename(filePath)} (${width}x${height}) erstellt`);
}

// Hilfsfunktionen
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3),16),
    parseInt(hex.slice(3,5),16),
    parseInt(hex.slice(5,7),16),
  ];
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// ── SIDEBAR (164 x 314) ───────────────────────────────────────────────────
const [or, og, ob] = hexToRgb('#FF6B35'); // Foxi-Orange
const [dr, dg, db] = hexToRgb('#1A1A2E'); // Dunkelblau

writeBmp(
  path.join(__dirname, '..', 'src', 'assets', 'installer-sidebar.bmp'),
  164, 314,
  (x, y, w, h) => {
    // Verlauf von oben (orange) nach unten (dunkel)
    const t = y / h;
    const r = lerp(or, dr, t);
    const g = lerp(og, dg, t);
    const b = lerp(ob, db, t);

    // Fuchs-Silhouette (vereinfacht) in der Mitte
    const cx = w / 2, cy = h * 0.38;
    const dx = x - cx, dy = y - cy;

    // Kopf-Kreis
    if (dx*dx + dy*dy < 38*38) {
      const bright = 1 - Math.sqrt(dx*dx+dy*dy)/38 * 0.3;
      return [Math.min(255,Math.round(255*bright)), Math.min(255,Math.round(175*bright)), Math.min(255,Math.round(50*bright))];
    }
    // Ohren links
    const elx = x - (cx - 28), ely = y - (cy - 48);
    if (elx > -5 && elx < 16 && ely > 0 && ely < 28 && elx > ely * 0.1) {
      return [255, 140, 40];
    }
    // Ohren rechts
    const erx = x - (cx + 28), ery = y - (cy - 48);
    if (erx > -16 && erx < 5 && ery > 0 && ery < 28 && -erx > ery * 0.1) {
      return [255, 140, 40];
    }

    // "FoxiBrowser" Text-Bereich (weißer Balken unten)
    if (y > h * 0.72 && y < h * 0.84) {
      const alpha = Math.min(1, Math.min(y - h*0.72, h*0.84 - y) / 8);
      return [
        lerp(r, 255, alpha * 0.15),
        lerp(g, 255, alpha * 0.15),
        lerp(b, 255, alpha * 0.15),
      ];
    }

    return [r, g, b];
  }
);

// ── HEADER (150 x 57) ─────────────────────────────────────────────────────
writeBmp(
  path.join(__dirname, '..', 'src', 'assets', 'installer-header.bmp'),
  150, 57,
  (x, y, w, h) => {
    // Weißer Hintergrund mit orangem rechten Rand
    const t = x / w;
    if (x > w * 0.75) {
      const s = (x - w * 0.75) / (w * 0.25);
      return [
        lerp(255, or, s),
        lerp(255, og, s),
        lerp(255, ob, s),
      ];
    }
    return [255, 255, 255];
  }
);
