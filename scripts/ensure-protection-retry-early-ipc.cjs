const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'main-wrapper.js');
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let changed = false;

const staticImport = "import './protection-retry-early-ipc.js';";
if (!src.includes(staticImport)) {
  const firstImport = src.match(/^import .*?;$/m)?.[0];
  if (!firstImport) throw new Error('Could not find first import in electron/main-wrapper.js');
  src = src.replace(firstImport, `${staticImport}\n${firstImport}`);
  changed = true;
  console.log('[ensure-protection-retry-early-ipc] added static protection retry IPC import at module top');
}

// Static import is enough. Remove the dynamic import to avoid confusing duplicate logs.
src = src.replace(
  /\n\s*await import\('\.\/protection-retry-early-ipc\.js'\);\n\s*console\.log\('\[main-wrapper\] protection retry early IPC import finished'\);/,
  () => {
    changed = true;
    console.log('[ensure-protection-retry-early-ipc] removed dynamic protection retry IPC import');
    return '';
  }
);

if (changed) fs.writeFileSync(file, src, 'utf8');
console.log('[ensure-protection-retry-early-ipc] ok');
