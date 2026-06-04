const fs = require('node:fs');
const path = require('node:path');

let changed = false;

function patch(filePath, marker, inserter) {
  const file = path.join(...filePath.split('/'));
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(marker)) return;
  const next = inserter(text);
  if (next && next !== text) {
    fs.writeFileSync(file, next, 'utf8');
    changed = true;
    console.log(`[ensure-audit-ipc-safe] patched ${filePath}`);
  }
}

patch('electron/main.js', "./audit-ipc-safe.js", (text) => {
  if (text.includes("import './protection-retry-early-ipc.js';")) {
    return text.replace(
      "import './protection-retry-early-ipc.js';\n",
      "import './protection-retry-early-ipc.js';\nimport './audit-ipc-safe.js';\n"
    );
  }
  return `import './audit-ipc-safe.js';\n${text}`;
});

patch('electron/main-wrapper.js', "./audit-ipc-safe.js", (text) => {
  if (text.includes("await import('./company-distributed-objects-ipc.js');")) {
    return text.replace(
      "    await import('./company-distributed-objects-ipc.js');\n    console.log('[main-wrapper] company distributed objects IPC import finished');",
      "    await import('./company-distributed-objects-ipc.js');\n    console.log('[main-wrapper] company distributed objects IPC import finished');\n    await import('./audit-ipc-safe.js');\n    console.log('[main-wrapper] safe audit IPC import finished');"
    );
  }
  return text;
});

patch('scripts/electron-dev-cloud.cjs', "scripts/ensure-audit-ipc-safe.cjs", (text) => {
  if (text.includes("runOptionalScript('scripts/ensure-image-preview-ipc.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n",
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\nrunOptionalScript('scripts/ensure-audit-ipc-safe.cjs');\n"
    );
  }
  return text;
});

console.log(changed ? '[ensure-audit-ipc-safe] done' : '[ensure-audit-ipc-safe] audit IPC already wired');
