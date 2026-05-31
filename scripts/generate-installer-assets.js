'use strict';
const fs   = require('fs');
const path = require('path');

function writeBmp(filePath, width, height, drawFn) {
  const rowSize   = Math.ceil((width * 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowSize * height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = drawFn(x, y, width, height);
      const idx = (height - 1 - y) * rowSize + x * 3;
      pixelData[idx]     = Math.max(0, Math.min(255, b));
      pixelData[idx + 1] = Math.max(0, Math.min(255, g));
      pixelData[idx + 2] = Math.max(0, Math.min(255, r));
    }
  }
  const fileSize = 54 + pixelData.length;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
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
  console.log(`✅ ${path.basename(filePath)} (${width}x${height})`);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * Math.max(0, Math.min(1, t))); }

// Zeichnet einen gefüllten Kreis, gibt alpha 0..1 zurück
function circle(x, y, cx, cy, r) {
  const d = Math.sqrt((x-cx)**2 + (y-cy)**2);
  return Math.max(0, 1 - d / r);
}

// ── SIDEBAR (164 x 314) ───────────────────────────────────────────────────
// Design: Dunkles Navy oben → Orange unten, 3 dekorative Kreise (Foxi-Palette)
writeBmp(
  path.join(__dirname, '..', 'src', 'assets', 'installer-sidebar.bmp'),
  164, 314,
  (x, y, w, h) => {
    const t = y / h;

    // Hintergrund-Verlauf: Navy (#1A1A2E) → Dunkelorange (#CC4A10)
    let r = lerp(26,  180, t);
    let g = lerp(26,   60, t);
    let b = lerp(46,   10, t);

    // Dezenter diagonaler Lichtstreifen
    const stripe = Math.abs(x / w - (1 - t) * 0.6);
    if (stripe < 0.08) {
      const bright = (0.08 - stripe) / 0.08 * 0.12;
      r = Math.min(255, Math.round(r + 255 * bright));
      g = Math.min(255, Math.round(g + 255 * bright));
      b = Math.min(255, Math.round(b + 255 * bright));
    }

    // Großer Kreis (orange, Mitte oben)
    const c1 = circle(x, y, w * 0.42, h * 0.28, 52);
    if (c1 > 0) {
      const alpha = Math.min(1, c1) * 0.85;
      r = lerp(r, 255, alpha);
      g = lerp(g, 107, alpha);
      b = lerp(b,  53, alpha);
    }

    // Kleiner Kreis (heller, rechts unten vom großen)
    const c2 = circle(x, y, w * 0.68, h * 0.38, 22);
    if (c2 > 0) {
      const alpha = Math.min(1, c2) * 0.7;
      r = lerp(r, 255, alpha);
      g = lerp(g, 140, alpha);
      b = lerp(b,  66, alpha);
    }

    // Mini-Kreis (unten links, akzent)
    const c3 = circle(x, y, w * 0.22, h * 0.72, 14);
    if (c3 > 0) {
      const alpha = Math.min(1, c3) * 0.5;
      r = lerp(r, 255, alpha);
      g = lerp(g, 180, alpha);
      b = lerp(b, 100, alpha);
    }

    // Weißer Balken unten (Text-Bereich Illusion)
    if (y > h * 0.88) {
      const fade = (y - h * 0.88) / (h * 0.12);
      r = lerp(r, 20, fade);
      g = lerp(g, 20, fade);
      b = lerp(b, 20, fade);
    }

    return [r, g, b];
  }
);

// ── HEADER (150 x 57) ─────────────────────────────────────────────────────
// Design: Weiß links → Orange rechts (passend zum NSIS-Header-Bereich)
writeBmp(
  path.join(__dirname, '..', 'src', 'assets', 'installer-header.bmp'),
  150, 57,
  (x, y, w, h) => {
    const t = x / w;
    // Weißer Hintergrund, Orange kommt von rechts rein
    const r = lerp(255, 220, t);
    const g = lerp(255,  80, t);
    const b = lerp(255,  20, t);

    // Kleiner dekorativer Kreis rechts
    const c = circle(x, y, w * 0.88, h * 0.45, 18);
    if (c > 0) {
      const alpha = Math.min(1, c) * 0.25;
      return [
        lerp(r, 255, alpha),
        lerp(g, 255, alpha),
        lerp(b, 255, alpha),
      ];
    }
    return [r, g, b];
  }
);
