'use strict';
// afterPack-Hook: bettet das Foxi-Icon in die Windows EXE ein (rcedit)
const path = require('path');
const { rcedit } = require('rcedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');
  try {
    await rcedit(exePath, { icon: icoPath });
    console.log('[FoxiBrowser] Icon in EXE eingebettet:', exePath);
  } catch (e) {
    console.warn('[FoxiBrowser] rcedit Fehler:', e.message);
  }
};
