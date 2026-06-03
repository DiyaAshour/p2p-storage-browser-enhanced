const fs = require('node:fs');
const path = require('node:path');

const mainFile = path.join(process.cwd(), 'electron', 'main.js');
const rendererFile = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

for (const file of [mainFile, rendererFile]) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
}

let main = fs.readFileSync(mainFile, 'utf8').replace(/\r\n/g, '\n');
let renderer = fs.readFileSync(rendererFile, 'utf8').replace(/\r\n/g, '\n');
let changed = false;

function mark(message) {
  changed = true;
  console.log(`[ensure-tombstone-hidden-from-listfiles] ${message}`);
}

const helper = `
function isDeleteTombstoneManifest(manifest = {}) {
  const id = String(manifest.id || manifest.hash || manifest.rootHash || '').toLowerCase();
  const kind = String(manifest.kind || manifest.type || '').toLowerCase();
  return (
    id.startsWith('tombstone:') ||
    kind.includes('tombstone') ||
    kind === 'delete' ||
    kind === 'deleted' ||
    manifest.deleted === true ||
    manifest.isDeleted === true ||
    manifest.deleteTombstone === true ||
    manifest.tombstone === true
  );
}

function tombstoneKeysForManifest(manifest = {}) {
  const keys = [];
  for (const value of [manifest.fileHash, manifest.deletedHash, manifest.originalHash, manifest.hash, manifest.rootHash]) {
    const text = String(value || '').trim();
    if (text) keys.push(text, text.replace(/^0x/, ''));
  }
  for (const value of manifest.removedManifestIds || []) {
    const text = String(value || '').trim();
    if (text) keys.push(text, text.replace(/^0x/, ''));
  }
  return Array.from(new Set(keys.filter(Boolean)));
}

function visibleFileManifestsOnly(items = []) {
  const tombstoneKeys = new Set();
  for (const item of items || []) {
    if (!isDeleteTombstoneManifest(item)) continue;
    for (const key of tombstoneKeysForManifest(item)) tombstoneKeys.add(key);
  }
  return (items || []).filter((item) => {
    if (isDeleteTombstoneManifest(item)) return false;
    const keys = [item.id, item.hash, item.rootHash, item.fileId]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .flatMap((value) => [value, value.replace(/^0x/, '')]);
    return !keys.some((key) => tombstoneKeys.has(key));
  });
}
`;

if (!main.includes('function visibleFileManifestsOnly(items = [])')) {
  const marker = `function isFolderManifest(manifest = {}) {`;
  if (!main.includes(marker)) throw new Error('Could not find isFolderManifest marker in main.js');
  main = main.replace(marker, helper + '\n' + marker);
  mark('added tombstone filtering helpers to main.js');
}

const beforeFiles = `const files = typeof walletFileManifests === 'function' ? walletFileManifests() : walletManifests().filter((m) => !(m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));`;
const afterFiles = `const rawFiles = typeof walletFileManifests === 'function' ? walletFileManifests() : walletManifests().filter((m) => !(m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));
  const files = visibleFileManifestsOnly(rawFiles);`;
if (main.includes(beforeFiles) && !main.includes('const rawFiles = typeof walletFileManifests')) {
  main = main.replace(beforeFiles, afterFiles);
  mark('filtered p2p:listFiles files through tombstone visibility guard');
}

if (!main.includes("[p2p:listFiles] hid tombstoned/deleted file manifests")) {
  const marker = `  if (!query) return files;`;
  const replacement = `  if (rawFiles.length !== files.length) {
    console.log('[p2p:listFiles] hid tombstoned/deleted file manifests', {
      rawFiles: rawFiles.length,
      visibleFiles: files.length,
      hidden: rawFiles.length - files.length,
    });
  }
  if (!query) return files;`;
  if (!main.includes(marker)) throw new Error('Could not find p2p:listFiles return marker');
  main = main.replace(marker, replacement);
  mark('added tombstone hidden diagnostic log in main.js');
}

if (!renderer.includes('function isDeleteTombstoneManifest(file: P2PFile): boolean')) {
  const marker = `function isRealFileManifest(file: P2PFile): boolean {`;
  const rendererHelper = `function isDeleteTombstoneManifest(file: P2PFile): boolean {
  const anyFile = file as any;
  const id = String(anyFile.id || file.hash || file.rootHash || '').toLowerCase();
  const kind = String(anyFile.kind || anyFile.type || '').toLowerCase();
  return (
    id.startsWith('tombstone:') ||
    kind.includes('tombstone') ||
    kind === 'delete' ||
    kind === 'deleted' ||
    anyFile.deleted === true ||
    anyFile.isDeleted === true ||
    anyFile.deleteTombstone === true ||
    anyFile.tombstone === true
  );
}

`;
  if (!renderer.includes(marker)) throw new Error('Could not find isRealFileManifest marker in renderer');
  renderer = renderer.replace(marker, rendererHelper + marker);
  mark('added tombstone detector to renderer');
}

const rendererGuard = `  if (isDeleteTombstoneManifest(file)) return false;
`;
if (!renderer.includes(rendererGuard)) {
  const marker = `function isRealFileManifest(file: P2PFile): boolean {
  const anyFile = file as any;
`;
  const replacement = `function isRealFileManifest(file: P2PFile): boolean {
  const anyFile = file as any;

${rendererGuard}`;
  if (!renderer.includes(marker)) throw new Error('Could not find isRealFileManifest body marker');
  renderer = renderer.replace(marker, replacement);
  mark('renderer now hides delete tombstones');
}

fs.writeFileSync(mainFile, main, 'utf8');
fs.writeFileSync(rendererFile, renderer, 'utf8');
if (!changed) console.log('[ensure-tombstone-hidden-from-listfiles] already patched');
