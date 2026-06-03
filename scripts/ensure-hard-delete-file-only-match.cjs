const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'hard-delete-override.js');
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let changed = false;

function replaceOnce(before, after, label) {
  if (src.includes(after)) return;
  if (!src.includes(before)) throw new Error(`Could not find ${label}`);
  src = src.replace(before, after);
  changed = true;
  console.log(`[ensure-hard-delete-file-only-match] ${label}`);
}

replaceOnce(
  `  const live = manifests().filter((m) => !isDeleteTombstone(m));\n`,
  `  const live = manifests().filter((m) => !isDeleteTombstone(m) && !isFolderManifest(m));\n`,
  'hard delete now searches file manifests only'
);

replaceOnce(
  `  const live = all.filter((m) => !isDeleteTombstone(m));\n`,
  `  const live = all.filter((m) => !isDeleteTombstone(m) && !isFolderManifest(m));\n`,
  'delete diagnostics now counts file manifests only'
);

if (!src.includes("[hard-delete] matched file manifest")) {
  const needle = `  if (isFolderManifest(item)) {\n    throw new Error('Hard delete override handles files only. Delete folders through folder delete flow.');\n  }\n`;
  const replacement = `  if (isFolderManifest(item)) {\n    console.warn('[hard-delete] folder manifest matched unexpectedly; refusing p2p:delete', {\n      id: item.id,\n      hash: item.hash,\n      rootHash: item.rootHash,\n      name: item.name,\n    });\n    throw new Error('Hard delete override handles files only. Delete folders through folder delete flow.');\n  }\n\n  console.log('[hard-delete] matched file manifest', {\n    id: item.id,\n    name: item.name,\n    hash: item.hash,\n    rootHash: item.rootHash,\n    totalChunks: item.totalChunks,\n  });\n`;
  if (!src.includes(needle)) throw new Error('Could not find folder guard block');
  src = src.replace(needle, replacement);
  changed = true;
  console.log('[ensure-hard-delete-file-only-match] added matched file diagnostic log');
}

if (changed) fs.writeFileSync(file, src, 'utf8');
else console.log('[ensure-hard-delete-file-only-match] already patched');
