// Generiert icon.png und icon.ico aus icon.svg
// Benötigt: npm install sharp png-to-ico --save-dev
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'src', 'assets');
const svgPath   = path.join(assetsDir, 'icon.svg');
const pngPath   = path.join(assetsDir, 'icon.png');
const icoPath   = path.join(assetsDir, 'icon.ico');

async function generate() {
  try {
    const sharp = require('sharp');

    // PNG 256x256
    await sharp(svgPath)
      .resize(256, 256)
      .png()
      .toFile(pngPath);
    console.log('icon.png erstellt');

    // ICO (mehrere Größen)
    const sizes = [16, 32, 48, 64, 128, 256];
    const buffers = await Promise.all(
      sizes.map(s => sharp(svgPath).resize(s, s).png().toBuffer())
    );

    const toIco = require('to-ico');
    const ico = await toIco(buffers);
    fs.writeFileSync(icoPath, ico);
    console.log('icon.ico erstellt');

  } catch (e) {
    console.warn('Icon-Generierung übersprungen (sharp nicht verfügbar):', e.message);
    console.log('Erstelle Fallback-Icon...');
    // Einfaches weißes 1x1 PNG als Fallback
    if (!fs.existsSync(pngPath)) {
      // Minimales PNG (1x1 orange Pixel)
      const minPng = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000001000000010802000000' +
        '9001 2e00000000c49444154789c62f8cfc00000000200016b84f700000000049454e44ae426082',
        'hex'
      );
      fs.writeFileSync(pngPath, minPng);
    }
    if (!fs.existsSync(icoPath)) {
      fs.copyFileSync(pngPath, icoPath);
    }
  }
}

generate();
