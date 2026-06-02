const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const mainPath = path.join(root, 'electron', 'main.js');
const KNOWN_GOOD_MAIN_REF = '711f799b29e3001b27aa049b659e9e00078222e9:electron/main.js';

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
}

function restoreKnownGoodMain() {
  try {
    return execFileSync('git', ['show', KNOWN_GOOD_MAIN_REF], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }).replace(/\r\n/g, '\n');
  } catch (error) {
    throw new Error(
      'electron/main.js appears truncated and could not be restored from git history. ' +
      'Run: git fetch origin big-file-upload-safe --unshallow if this is a shallow clone, then retry. ' +
      String(error?.message || error)
    );
  }
}

function applyEnterpriseRuntimeConstants(src) {
  let out = src;

  out = out.replace(
    /const TARGET_REPLICAS = Number\(process\.env\.P2P_TARGET_REPLICAS \|\| 3\);/,
    'const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));'
  );

  out = out.replace(
    /const FREE_QUOTA_BYTES = 10 \* 1024 \* 1024 \* 1024;/,
    'const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;'
  );

  return out;
}

function hasRuntimeWalletPaymentMarkers(src) {
  return [
    'function assertWalletUploadAllowed(nextBytes = 0)',
    'Storage quota exceeded. Current plan:',
    "ipcMain.handle('wallet:connect'",
    "ipcMain.handle('wallet:disconnect'",
    "ipcMain.handle('wallet:setPlan'",
    "ipcMain.handle('p2p:upload'",
    'assertWalletUploadAllowed(originalBuffer.length)',
    'planId: walletState.planId',
  ].every((needle) => src.includes(needle));
}

function mainLooksTruncated(src) {
  const lineCount = src.split('\n').length;
  return lineCount < 1000 || !hasRuntimeWalletPaymentMarkers(src);
}

let src = read(mainPath);
let changed = false;

if (mainLooksTruncated(src)) {
  console.log('[ensure-main-runtime-integrity] electron/main.js is incomplete or missing wallet/payment runtime markers; restoring known-good runtime');
  src = restoreKnownGoodMain();
  changed = true;
}

const patched = applyEnterpriseRuntimeConstants(src);
if (patched !== src) {
  src = patched;
  changed = true;
  console.log('[ensure-main-runtime-integrity] applied enterprise runtime constants: target replicas=4, free quota=5GB');
}

if (!hasRuntimeWalletPaymentMarkers(src)) {
  throw new Error('electron/main.js is still missing wallet/payment runtime markers after restoration.');
}

if (!src.includes('const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));')) {
  throw new Error('electron/main.js TARGET_REPLICAS is not locked to minimum 4.');
}

if (!src.includes('const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;')) {
  throw new Error('electron/main.js FREE_QUOTA_BYTES is not the expected 5GB literal.');
}

if (changed) fs.writeFileSync(mainPath, src, 'utf8');
console.log('[ensure-main-runtime-integrity] ok');
