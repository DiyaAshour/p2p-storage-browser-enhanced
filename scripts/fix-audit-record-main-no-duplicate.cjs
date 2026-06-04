const fs = require('node:fs');
const path = require('node:path');

let changed = false;

function patchFile(filePath, patcher) {
  const file = path.join(...filePath.split('/'));
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = patcher(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    changed = true;
    console.log(`[fix-audit-record-main-no-duplicate] patched ${filePath}`);
  }
}

patchFile('electron/main.js', (text) => {
  let next = text
    .replace("import './audit-ipc-safe.js';\n", '')
    .replace("import './audit-ipc-safe.js';\r\n", '');

  if (!next.includes("ipcMain.handle('audit:record'")) {
    const marker = "ipcMain.handle('p2p:start'";
    const insert = `
try { ipcMain.removeHandler('audit:record'); } catch {}
ipcMain.handle('audit:record', async (_event, payload = {}) => {
  const events = readAuditLog();
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
  const event = {
    auditId: String(payload.auditId || crypto.randomUUID()),
    action: String(payload.action || 'unknown'),
    actor: String(details.actorLabel || payload.actor || activeWallet() || 'unknown'),
    workspaceId: String(payload.workspaceId || details.workspaceId || ''),
    workspaceName: String(payload.workspaceName || details.workspaceName || ''),
    at: String(payload.at || new Date().toISOString()),
    details,
  };
  events.push(event);
  writeAuditLog(events.slice(-2000));
  return { ok: true, event };
});

`;

    if (next.includes(marker)) {
      next = next.replace(marker, insert + marker);
    }
  }

  return next;
});

patchFile('electron/main-wrapper.js', (text) => {
  // Do not import the safe audit override inside wrapper for now. main.js owns audit:list
  // and this fix adds audit:record there too.
  return text
    .replace("    await import('./audit-ipc-safe.js');\n", '')
    .replace("    console.log('[main-wrapper] safe audit IPC import finished');\n", '');
});

patchFile('scripts/electron-dev-cloud.cjs', (text) => {
  let next = text;

  if (!next.includes("scripts/fix-audit-record-main-no-duplicate.cjs")) {
    if (next.includes("runOptionalScript('scripts/ensure-audit-ipc-safe.cjs');")) {
      next = next.replace(
        "runOptionalScript('scripts/ensure-audit-ipc-safe.cjs');\n",
        "runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\n"
      );
    } else if (next.includes("runOptionalScript('scripts/ensure-image-preview-ipc.cjs');")) {
      next = next.replace(
        "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n",
        "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\nrunOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\n"
      );
    }
  }

  return next;
});

console.log(changed ? '[fix-audit-record-main-no-duplicate] done' : '[fix-audit-record-main-no-duplicate] already fixed');
