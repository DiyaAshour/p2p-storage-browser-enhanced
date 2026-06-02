#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const mainPath = path.join(process.cwd(), 'electron', 'main.js');
let source = fs.readFileSync(mainPath, 'utf8');
const before = source;

if (!source.includes("ipcMain.handle('audit:list'")) {
  const handler = `
function auditLogPath() {
  ensureDataDir();
  return path.join(dataDir, 'audit-log.json');
}

function readAuditLog() {
  try {
    const file = auditLogPath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAuditLog(events = []) {
  fs.mkdirSync(path.dirname(auditLogPath()), { recursive: true });
  fs.writeFileSync(auditLogPath(), JSON.stringify(Array.isArray(events) ? events : [], null, 2), 'utf8');
}

ipcMain.handle('audit:list', async (_event, payload = {}) => {
  const limit = Math.max(1, Math.min(500, Number(payload.limit || 100)));
  return { ok: true, events: readAuditLog().slice(-limit).reverse() };
});

ipcMain.handle('audit:append', async (_event, payload = {}) => {
  const events = readAuditLog();
  const event = {
    auditId: String(payload.auditId || crypto.randomUUID()),
    action: String(payload.action || 'unknown'),
    actor: String(payload.actor || activeWallet() || 'unknown'),
    at: String(payload.at || new Date().toISOString()),
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
  };
  events.push(event);
  writeAuditLog(events.slice(-2000));
  return { ok: true, event };
});
`;

  if (!source.includes("ipcMain.handle('p2p:start'")) {
    throw new Error('Could not find p2p:start IPC handler anchor in electron/main.js');
  }

  source = source.replace("ipcMain.handle('p2p:start'", `${handler}\nipcMain.handle('p2p:start'`);
}

if (before !== source) fs.writeFileSync(mainPath, source, 'utf8');
console.log('[audit-ipc-runtime] applied', { main: before !== source });
