import { WebSocket } from 'ws';

export const SAFETY_PEER_REPLICA_ID = 'aws-safety-peer';

const DEFAULT_SAFETY_PEER_URL = 'ws://54.166.171.208:8792';
const SAFETY_PEER_TIMEOUT_MS = Number(process.env.P2P_SAFETY_PEER_TIMEOUT_MS || 15000);
const SAFETY_PEER_MODE = String(process.env.P2P_SAFETY_PEER_MODE || 'emergency').trim().toLowerCase();

function safetyPeerDeleteToken() {
  return String(
    process.env.P2P_SAFETY_PEER_DELETE_TOKEN ||
    process.env.STORAGE_PEER_ADMIN_TOKEN ||
    ''
  ).trim();
}

export function safetyPeerUrl() {
  return String(
    process.env.P2P_SAFETY_PEER_URL ||
    process.env.STORAGE_PEER_URL ||
    process.env.VITE_STORAGE_PEER_URL ||
    DEFAULT_SAFETY_PEER_URL
  ).trim();
}

export function isSafetyPeerEnabled() {
  return /^wss?:\/\//i.test(safetyPeerUrl()) && SAFETY_PEER_MODE !== 'off' && SAFETY_PEER_MODE !== 'disabled';
}

export function shouldUseSafetyPeer(chunk = {}) {
  if (!isSafetyPeerEnabled()) return false;
  if (SAFETY_PEER_MODE === 'always') return true;
  return Boolean(
    chunk.forceSafetyPeer ||
    chunk.emergencySafety ||
    chunk.safetyRequired ||
    chunk.safetyReason ||
    chunk.reason ||
    chunk.source === 'upload-time-safety' ||
    chunk.source === 'repair-safety'
  );
}

function normalizeSafetyChunk(chunk = {}, reason = 'explicit-safety-call') {
  return {
    ...chunk,
    forceSafetyPeer: true,
    emergencySafety: true,
    safetyRequired: true,
    safetyReason: chunk.safetyReason || chunk.reason || reason,
  };
}

function normalizeChunkHash(chunkHash = '') {
  const hash = String(chunkHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid chunk hash for safety peer');
  return hash;
}

function safetyLog(action, details = {}, level = 'log') {
  const payload = {
    at: new Date().toISOString(),
    replicaId: SAFETY_PEER_REPLICA_ID,
    peerUrl: safetyPeerUrl(),
    mode: SAFETY_PEER_MODE,
    ...details,
  };
  const fn = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log;
  fn(`[safety-peer] ${action}`, payload);
}

function waitForOpen(socket, timeoutMs = SAFETY_PEER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Safety peer connection timed out')), timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage(socket, predicate, timeoutMs = SAFETY_PEER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Safety peer response timed out')), timeoutMs);
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(message);
        }
      } catch {
        // ignore malformed messages
      }
    };
    socket.on('message', onMessage);
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(error);
    });
  });
}

async function withSafetySocket(work) {
  const url = safetyPeerUrl();
  if (!/^wss?:\/\//i.test(url)) return { ok: false, skipped: true, reason: 'safety-peer-not-configured' };
  const socket = new WebSocket(url);
  await waitForOpen(socket);
  try {
    return await work(socket);
  } finally {
    try { socket.close(); } catch {}
  }
}

export async function putChunkToSafetyPeer(chunk, fromPeerId = 'desktop-client') {
  const safetyChunk = normalizeSafetyChunk(chunk, 'explicit-safety-peer-put');
  if (!shouldUseSafetyPeer(safetyChunk)) {
    const skipped = { ok: false, skipped: true, reason: `safety-peer-${SAFETY_PEER_MODE}-not-required` };
    safetyLog('put skipped', { chunkHash: safetyChunk?.hash || '', fromPeerId, reason: skipped.reason }, 'warn');
    return skipped;
  }
  if (!safetyChunk?.hash || !safetyChunk?.data) throw new Error('Invalid chunk for safety peer put');

  const hash = normalizeChunkHash(safetyChunk.hash);
  safetyLog('put start', {
    chunkHash: hash,
    fromPeerId,
    bytesBase64: String(safetyChunk.data || '').length,
    reason: safetyChunk.safetyReason || safetyChunk.reason || (safetyChunk.emergencySafety ? 'emergency' : 'requested'),
  });

  try {
    const result = await withSafetySocket(async (socket) => {
      socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId }));
      socket.send(JSON.stringify({
        id: `put-${hash}-${Date.now()}`,
        type: 'chunk:put',
        fromPeerId,
        createdAt: Date.now(),
        payload: { chunk: { ...safetyChunk, hash } },
      }));
      const message = await waitForMessage(socket, (msg) => {
        if (msg.type === 'chunk:error') return true;
        return msg.type === 'chunk:stored-ack' && msg.payload?.chunkHash === hash;
      });
      if (message.type === 'chunk:error') throw new Error(message.error || 'Safety peer rejected chunk');
      return { ok: true, peerUrl: safetyPeerUrl(), chunkHash: hash, replicaId: SAFETY_PEER_REPLICA_ID };
    });

    if (result?.ok) safetyLog('put stored', { chunkHash: hash, fromPeerId });
    else safetyLog('put finished without store', { chunkHash: hash, fromPeerId, result }, 'warn');
    return result;
  } catch (error) {
    safetyLog('put failed', { chunkHash: hash, fromPeerId, error: error?.message || String(error) }, 'error');
    throw error;
  }
}

export async function getChunkFromSafetyPeer(chunkHash, fromPeerId = 'desktop-client') {
  if (!isSafetyPeerEnabled()) throw new Error('Safety peer is not configured');
  const hash = normalizeChunkHash(chunkHash);
  safetyLog('get start', { chunkHash: hash, fromPeerId });

  try {
    const chunk = await withSafetySocket(async (socket) => {
      socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId }));
      socket.send(JSON.stringify({
        id: `get-${hash}-${Date.now()}`,
        type: 'chunk:get',
        fromPeerId,
        createdAt: Date.now(),
        payload: { chunkHash: hash },
      }));
      const message = await waitForMessage(socket, (msg) => ['chunk:found', 'chunk:not-found', 'chunk:error'].includes(msg.type));
      if (message.type === 'chunk:error') throw new Error(message.error || 'Safety peer failed to read chunk');
      if (message.type === 'chunk:not-found') throw new Error(`Safety peer missing chunk: ${hash}`);
      const found = message.payload?.chunk;
      if (!found?.data || found.hash !== hash) throw new Error('Safety peer returned invalid chunk');
      return found;
    });
    safetyLog('get found', { chunkHash: hash, fromPeerId });
    return chunk;
  } catch (error) {
    safetyLog('get failed', { chunkHash: hash, fromPeerId, error: error?.message || String(error) }, 'error');
    throw error;
  }
}

export async function deleteChunkFromSafetyPeer(chunkHash, fromPeerId = 'desktop-client') {
  if (!isSafetyPeerEnabled()) {
    const skipped = { ok: false, skipped: true, reason: 'safety-peer-disabled' };
    safetyLog('delete skipped', { chunkHash: chunkHash || '', fromPeerId, reason: skipped.reason }, 'warn');
    return skipped;
  }
  const hash = normalizeChunkHash(chunkHash);
  const adminToken = safetyPeerDeleteToken();
  if (!adminToken) {
    const error = 'Safety peer delete token is not configured. Set P2P_SAFETY_PEER_DELETE_TOKEN before starting Electron.';
    safetyLog('delete blocked', { chunkHash: hash, fromPeerId, error }, 'error');
    throw new Error(error);
  }

  safetyLog('delete start', { chunkHash: hash, fromPeerId });

  try {
    const result = await withSafetySocket(async (socket) => {
      socket.send(JSON.stringify({ type: 'peer:hello', fromPeerId }));
      socket.send(JSON.stringify({
        id: `delete-${hash}-${Date.now()}`,
        type: 'chunk:delete',
        fromPeerId,
        createdAt: Date.now(),
        payload: {
          chunkHash: hash,
          adminToken,
        },
      }));
      const message = await waitForMessage(socket, (msg) => ['chunk:deleted', 'chunk:not-found', 'chunk:error'].includes(msg.type));
      if (message.type === 'chunk:error') {
        throw new Error(message.error || 'Safety peer failed to delete chunk');
      }
      if (message.type === 'chunk:not-found') {
        return { ok: true, alreadyMissing: true, peerUrl: safetyPeerUrl(), chunkHash: hash, replicaId: SAFETY_PEER_REPLICA_ID };
      }
      return { ok: true, deleted: true, peerUrl: safetyPeerUrl(), chunkHash: hash, replicaId: SAFETY_PEER_REPLICA_ID };
    });

    safetyLog(result?.alreadyMissing ? 'delete already-missing' : 'delete confirmed', {
      chunkHash: hash,
      fromPeerId,
      alreadyMissing: Boolean(result?.alreadyMissing),
      deleted: Boolean(result?.deleted || (result?.ok && !result?.alreadyMissing)),
    });
    return result;
  } catch (error) {
    safetyLog('delete failed', { chunkHash: hash, fromPeerId, error: error?.message || String(error) }, 'error');
    throw error;
  }
}
