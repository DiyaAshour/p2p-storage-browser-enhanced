const fs = require('node:fs');
const path = require('node:path');

const mainFile = path.join(process.cwd(), 'electron', 'main.js');
if (!fs.existsSync(mainFile)) throw new Error(`Missing ${mainFile}`);

let src = fs.readFileSync(mainFile, 'utf8').replace(/\r\n/g, '\n');
const marker = "ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); await syncPull(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((m) => !(walletOwnsManifest(m) && m.hash === manifest.hash)); persistManifests(); await syncDelete(activeWallet(), manifest.hash); return { ok: true, summary: networkSummary() }; });";
const injected = `${marker}\nawait import('./hard-delete-override.js');\nconsole.log('[main] hard delete override import finished');`;

if (!src.includes(marker)) {
  console.log('[ensure-hard-delete-entrypoint] legacy p2p:delete marker not found; no patch needed');
  process.exit(0);
}

if (!src.includes("await import('./hard-delete-override.js');")) {
  src = src.replace(marker, injected);
  fs.writeFileSync(mainFile, src, 'utf8');
  console.log('[ensure-hard-delete-entrypoint] patched main.js to install hard-delete override after legacy p2p:delete');
} else {
  console.log('[ensure-hard-delete-entrypoint] already patched');
}
