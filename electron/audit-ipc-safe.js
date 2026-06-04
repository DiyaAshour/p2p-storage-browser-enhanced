import { ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { dataDir } from './core/storage-paths.js';
import { readJson, writeJson, readManifests } from './core/storage-json.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { walletPath } from './core/storage-paths.js';

function auditPath() {
  return path.join(dataDir(), 'audit-events.json');
}

function currentActor() {
  const wallet = readJson(walletPath(), {});
  const identity = activeIdentity(wallet);
  return {
    actor: wallet?.username ? `Seed: ${wallet.username}` : normalizeIdentity(identity || wallet?.accountId || wallet?.address || 'local-user'),
    actorId: normalizeIdentity(identity || wallet?.accountId || wallet?.address || wallet?.username || ''),
    authMode: wallet?.authMode || null,
  };
}

function readAuditEvents() {
  const value = readJson(auditPath(), []);
  return Array.isArray(value) ? value : [];
}

function writeAuditEvents(events) {
  writeJson(auditPath(), Array.isArray(events) ? events.slice(-5000) : []);
}

function safeDetails(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function normalizeWorkspaceId(payload = {}) {
  return String(payload.workspaceId || payload.details?.workspaceId || '').trim();
}

try { ipcMain.removeHandler('audit:record'); } catch {}
ipcMain.handle('audit:record', async (_event, payload = {}) => {
  const now = new Date().toISOString();
  const actor = currentActor();
  const details = safeDetails(payload.details || {});
  const workspaceId = normalizeWorkspaceId(payload);

  const event = {
    auditId: crypto.randomUUID(),
    action: String(payload.action || 'unknown'),
    actor: details.actorLabel || actor.actor,
    actorId: actor.actorId,
    authMode: actor.authMode,
    workspaceId,
    workspaceName: String(details.workspaceName || payload.workspaceName || ''),
    at: now,
    details,
    p2p: {
      local: true,
      storedAt: auditPath(),
    },
  };

  const events = readAuditEvents();
  events.push(event);
  writeAuditEvents(events);

  return { ok: true, event };
});

try { ipcMain.removeHandler('audit:append'); } catch {}
ipcMain.handle('audit:append', async (_event, payload = {}) => {
  return ipcMain.emit ? { ok: true } : { ok: true };
});

try { ipcMain.removeHandler('audit:list'); } catch {}
ipcMain.handle('audit:list', async (_event, payload = {}) => {
  const workspaceId = String(payload.workspaceId || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(payload.limit || 200)));
  let events = readAuditEvents();

  if (workspaceId) {
    events = events.filter((event) => String(event.workspaceId || event.details?.workspaceId || '') === workspaceId);
  }

  events = events
    .slice()
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, limit);

  return { ok: true, events };
});

try { ipcMain.removeHandler('audit:clear'); } catch {}
ipcMain.handle('audit:clear', async (_event, payload = {}) => {
  const workspaceId = String(payload.workspaceId || '').trim();

  if (!workspaceId) {
    writeAuditEvents([]);
    return { ok: true, cleared: 'all' };
  }

  const remaining = readAuditEvents().filter(
    (event) => String(event.workspaceId || event.details?.workspaceId || '') !== workspaceId
  );
  writeAuditEvents(remaining);
  return { ok: true, cleared: workspaceId };
});

try { ipcMain.removeHandler('audit:listManifests'); } catch {}
ipcMain.handle('audit:listManifests', async () => {
  const manifests = readManifests();
  return {
    ok: true,
    manifests: manifests.map((manifest) => ({
      name: manifest.name,
      hash: manifest.hash,
      rootHash: manifest.rootHash,
      uploadedAt: manifest.uploadedAt,
      ownerWallet: manifest.ownerWallet,
      totalChunks: manifest.totalChunks,
      size: manifest.size,
    })),
  };
});

console.log('[audit-ipc-safe] audit IPC handlers registered');
