import { ipcMain } from 'electron';

const STATE_KEY = Symbol.for('chunknet.protectionRetryEarlyState');

const state = globalThis[STATE_KEY] || {
  pausedUntil: 0,
  pauseReason: null,
  lastStatus: {
    active: false,
    installedEarly: true,
    lastRunAt: null,
    repairedChunks: 0,
    checkedChunks: 0,
    error: null,
  },
};
globalThis[STATE_KEY] = state;

function pauseProtectionRetry(ms = 5 * 60 * 1000, reason = 'early-runtime-pause') {
  state.pausedUntil = Math.max(state.pausedUntil, Date.now() + Number(ms || 0));
  state.pauseReason = reason;
  const pausedUntil = new Date(state.pausedUntil).toISOString();
  state.lastStatus = {
    ...state.lastStatus,
    active: false,
    paused: true,
    pausedUntil,
    pauseReason: reason,
    installedEarly: true,
    updatedAt: new Date().toISOString(),
  };
  console.log('[protection-retry-early] paused', { ms, reason, pausedUntil });
  return { ok: true, paused: true, pausedUntil, reason, installedEarly: true };
}

function resumeProtectionRetry(reason = 'early-runtime-resume') {
  state.pausedUntil = 0;
  state.pauseReason = null;
  state.lastStatus = {
    ...state.lastStatus,
    active: false,
    paused: false,
    pausedUntil: null,
    pauseReason: null,
    installedEarly: true,
    updatedAt: new Date().toISOString(),
  };
  console.log('[protection-retry-early] resumed', { reason });
  return { ok: true, paused: false, reason, installedEarly: true };
}

function status() {
  const paused = Date.now() < Number(state.pausedUntil || 0);
  return {
    ...state.lastStatus,
    active: false,
    paused,
    pausedUntil: paused ? new Date(state.pausedUntil).toISOString() : null,
    pauseReason: paused ? state.pauseReason : null,
    installedEarly: true,
  };
}

function installEarlyProtectionRetryIpc() {
  for (const channel of [
    'p2p:pauseProtectionRetry',
    'p2p:resumeProtectionRetry',
    'p2p:protectionRetryStatus',
    'p2p:protectionRetryNow',
  ]) {
    try { ipcMain.removeHandler(channel); } catch {}
  }

  ipcMain.handle('p2p:pauseProtectionRetry', async (_event, payload = {}) => pauseProtectionRetry(Number(payload.ms || 5 * 60 * 1000), String(payload.reason || 'operation')));
  ipcMain.handle('p2p:resumeProtectionRetry', async (_event, payload = {}) => resumeProtectionRetry(String(payload.reason || 'operation-finished')));
  ipcMain.handle('p2p:protectionRetryStatus', async () => status());
  ipcMain.handle('p2p:protectionRetryNow', async () => ({ ...status(), ok: true, skipped: true, reason: 'full-protection-retry-loop-not-loaded-yet' }));

  console.log('[protection-retry-early] IPC fallbacks installed');
}

installEarlyProtectionRetryIpc();
