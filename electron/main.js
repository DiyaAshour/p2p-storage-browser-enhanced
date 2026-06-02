import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { verifyMessage } from 'viem';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree, getMerkleProof } from './merkle-engine.js';
import { startP2PTransport } from './p2p-transport.js';
import { isManifestSyncEnabled, pullWalletManifests, pushWalletManifest, deleteWalletManifest } from './manifest-sync.js';
import { replicateChunk, repairManifests, countUnderReplicatedChunks } from './replication-engine.js';
import { putChunkToSafetyPeer, getChunkFromSafetyPeer, safetyPeerUrl } from './safety-peer.js';
import './seed-auth-cooldown-ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'p2p.cloud';
const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const CHUNK_SIZE_BYTES = Number(process.env.P2P_CHUNK_SIZE_BYTES || 1024 * 1024);
const TARGET_REPLICAS = Number(process.env.P2P_TARGET_REPLICAS || 3);
const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60_000));
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.P2P_UPLOAD_CONCURRENCY || 4)));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.P2P_DOWNLOAD_CONCURRENCY || 6)));
const FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const TRIAL_DAYS = 7;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
function keySourceForIdentity() { return ENCRYPTION_KEY_SOURCE; }
const KDF_ALGORITHM = 'pbkdf2-sha256';
const KDF_ITERATIONS = 310000;
const MIN_DRIVE_PASSWORD_LENGTH = Number(process.env.P2P_MIN_DRIVE_PASSWORD_LENGTH || 12);
const WALLET_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;
const FOLDER_MANIFEST_KIND = 'folder';

const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};

let mainWindow = null;
let transportNode = null;
let autoRepairTimer = null;
let autoRepairRunning = false;
let lastAutoRepairStatus = { ok: true, active: false, intervalMs: AUTO_REPAIR_INTERVAL_MS, lastRunAt: null, repairedChunks: 0, underReplicatedChunks: 0, skippedReason: 'not-started', error: null };
let transferProgress = { upload: null, download: null };
let dataDir = null;
let manifestsPath = null;
let walletPath = null;
let manifests = [];
let walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
let lastSyncStatus = { ok: false, lastPulledAt: null, lastPushedAt: null, error: null, remoteFiles: 0 };

function normalizeWallet(address = '') { return String(address || '').trim().toLowerCase(); }
function activeWallet() { return normalizeWallet(walletState.accountId || walletState.address); }
function isValidWallet(address = '') { return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim()); }
function isVerifiedSeedIdentity() {
  const accountId = String(walletState.accountId || walletState.address || '');
  return Boolean(
    walletState.connected &&
    walletState.verified &&
    walletState.authMode === 'seed' &&
    accountId.startsWith('seed:')
  );
}

function assertVerifiedWallet() {
  if (isVerifiedSeedIdentity()) return;

  if (!walletState.connected || !walletState.verified || !activeWallet()) {
    throw new Error('Verified identity required. Connect wallet or sign in with Seed Account first.');
  }
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function hashBufferHex(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function firstLanAddress() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const net of list || []) if (net && !net.internal && net.family === 'IPv4' && !net.address.startsWith('169.254.')) return net.address; return '127.0.0.1'; }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks'); }
function publicPeerUrl(node) { return process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${node.port}`; }
function validateDrivePassword(drivePassword) { const password = String(drivePassword || '').trim(); if (password.length < MIN_DRIVE_PASSWORD_LENGTH) throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`); return password; }
function drivePasswordFromPayload(payload = {}) { return validateDrivePassword(payload.drivePassword); }
function splitIntoChunks(buffer) { const chunks = []; for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE_BYTES) { const data = buffer.slice(offset, offset + CHUNK_SIZE_BYTES); chunks.push({ index: chunks.length, size: data.length, data, hash: hashBufferHex(data) }); } return chunks; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function hasEncryptionMetadata(manifest = {}) { return Boolean(manifest.encryption && manifest.encryption.algorithm && manifest.encryption.keySource && manifest.encryption.salt && manifest.encryption.iv && manifest.encryption.authTag); }
function isUsableManifest(manifest = {}) { return !(manifest.isEncrypted === true && !hasEncryptionMetadata(manifest)); }
function clampConcurrency(value, fallback, max) { return Math.max(1, Math.min(max, Number(value || fallback))); }

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function createProgress(kind, { fileName, totalBytes, totalChunks, concurrency }) {
  const now = Date.now();
  transferProgress[kind] = {
    active: true,
    phase: 'running',
    fileName,
    totalBytes,
    transferredBytes: 0,
    percent: 0,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    chunksDone: 0,
    totalChunks,
    concurrency,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    error: null,
  };
}

function updateProgress(kind, { bytesDelta = 0, chunkDelta = 0, phase = 'running', error = null } = {}) {
  const progress = transferProgress[kind];
  if (!progress) return;
  const now = Date.now();
  const started = new Date(progress.startedAt).getTime() || now;
  const elapsedSeconds = Math.max(0.001, (now - started) / 1000);
  const transferredBytes = Math.min(progress.totalBytes, Number(progress.transferredBytes || 0) + Number(bytesDelta || 0));
  const chunksDone = Math.min(progress.totalChunks, Number(progress.chunksDone || 0) + Number(chunkDelta || 0));
  const speedBytesPerSecond = transferredBytes / elapsedSeconds;
  const remainingBytes = Math.max(0, progress.totalBytes - transferredBytes);
  transferProgress[kind] = {
    ...progress,
    phase,
    transferredBytes,
    percent: progress.totalBytes ? (transferredBytes / progress.totalBytes) * 100 : 100,
    speedBytesPerSecond,
    etaSeconds: speedBytesPerSecond > 0 && remainingBytes > 0 ? remainingBytes / speedBytesPerSecond : 0,
    chunksDone,
    updatedAt: new Date(now).toISOString(),
    error,
  };
}

function finishProgress(kind, phase = 'complete', error = null) {
  const progress = transferProgress[kind];
  if (!progress) return;
  updateProgress(kind, { bytesDelta: 0, chunkDelta: 0, phase, error });
  transferProgress[kind] = { ...transferProgress[kind], active: false, phase, error };
}

function parseLoginMessageTime(message = '') {
  const match = String(message).match(/^Time:\s*(.+)$/im);
  if (!match) throw new Error('Wallet login message is missing timestamp');
  const time = new Date(match[1]);
  if (Number.isNaN(time.getTime())) throw new Error('Wallet login timestamp is invalid');
  return time;
}

async function verifyWalletLoginPayload(payload = {}, address = '') {
  const normalizedAddress = normalizeWallet(address);
  const message = String(payload.loginMessage || '');
  const signature = String(payload.signature || '');

  if (!message || !signature) throw new Error('Missing wallet signature. Reconnect wallet.');
  if (!message.startsWith('p2p.cloud login\n')) throw new Error('Unsupported wallet login message');
  if (!message.toLowerCase().includes(`wallet: ${normalizedAddress}`)) throw new Error('Wallet login message does not match connected address');

  const signedAt = parseLoginMessageTime(message);
  const age = Date.now() - signedAt.getTime();
  if (age > WALLET_LOGIN_MAX_AGE_MS) throw new Error('Wallet login signature expired. Reconnect wallet.');
  if (age < -WALLET_LOGIN_MAX_FUTURE_MS) throw new Error('Wallet login timestamp is too far in the future');

  const valid = await verifyMessage({ address: normalizedAddress, message, signature });
  if (!valid) throw new Error('Wallet signature verification failed');

  return { message, signature, signedAt: signedAt.toISOString() };
}

function isValidStorageIdentity(identity = '') {
  const value = normalizeWallet(identity);
  return isValidWallet(value) || value.startsWith('seed:');
}

async function deriveDriveKey({ ownerWallet = activeWallet(), drivePassword, salt }) {
  const identity = normalizeWallet(ownerWallet);

  if (!isValidStorageIdentity(identity)) {
    throw new Error('Valid wallet or seed identity required for private file encryption.');
  }

  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64');

  // async pbkdf2 — does NOT block the main thread (was pbkdf2Sync with 310k iterations)
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256',
      (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function encryptPrivateBuffer(plainBuffer, ownerWallet = activeWallet(), drivePassword) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveDriveKey({ ownerWallet, drivePassword, salt });
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return { ciphertext, encryption: { version: 4, algorithm: ENCRYPTION_ALGORITHM, keySource: ENCRYPTION_KEY_SOURCE, kdf: KDF_ALGORITHM, kdfIterations: KDF_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), originalHash: hashBufferHex(plainBuffer), originalSize: plainBuffer.length } };
}

async function decryptPrivateBuffer(ciphertext, manifest, drivePassword) {
  if (!manifest?.encryption || manifest.encryption.algorithm !== ENCRYPTION_ALGORITHM) throw new Error('Encrypted file metadata is missing or unsupported');
  if (manifest.encryption.keySource !== ENCRYPTION_KEY_SOURCE) throw new Error(`This file was encrypted with an older key source (${manifest.encryption.keySource || 'unknown'}). Re-upload it with Drive Password encryption.`);
  const key = await deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: manifest.encryption.salt });
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(manifest.encryption.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.encryption.authTag, 'base64'));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (manifest.encryption.originalHash && hashBufferHex(plain) !== manifest.encryption.originalHash) throw new Error('Private file integrity failed after decrypt');
  return plain;
}

function ensureDataDir() {
  if (dataDir && manifestsPath && walletPath) return;
  dataDir = path.join(app.getPath('userData'), 'native-p2p-storage');
  manifestsPath = path.join(dataDir, 'manifests.json');
  walletPath = path.join(dataDir, 'wallet.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(chunkStoreDir(), { recursive: true });
  if (!fs.existsSync(manifestsPath)) fs.writeFileSync(manifestsPath, '[]', 'utf8');
  if (!fs.existsSync(walletPath)) fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');
}

function loadWallet() {
  ensureDataDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
    walletState = { ...walletState, ...parsed, planId: PLANS[parsed?.planId] ? parsed.planId : 'free', encryptionSecret: undefined, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
    if (walletState.planId !== 'free' && (!walletState.paidUntil || Number(walletState.paidUntil) < nowSeconds())) walletState = { ...walletState, planId: 'free', paidUntil: null, subscriptionTx: null };
  } catch {
    walletState = { connected: false, verified: false, address: '', planId: 'free', connectedAt: null, verifiedAt: null, paidUntil: null, subscriptionTx: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE };
  }
}

function persistWallet() { ensureDataDir(); const { encryptionSecret, loginSignature, ...safeWallet } = walletState; fs.writeFileSync(walletPath, JSON.stringify({ ...safeWallet, encryptionKeySource: ENCRYPTION_KEY_SOURCE }, null, 2), 'utf8'); }
function loadManifests() { ensureDataDir(); try { const parsed = JSON.parse(fs.readFileSync(manifestsPath, 'utf8')); manifests = Array.isArray(parsed) ? parsed.filter(isUsableManifest) : []; persistManifests(); } catch { manifests = []; } }
function persistManifests() { ensureDataDir(); fs.writeFileSync(manifestsPath, JSON.stringify(manifests.filter(isUsableManifest), null, 2), 'utf8'); }
function walletOwnsManifest(manifest) { return normalizeWallet(manifest.ownerWallet) === activeWallet(); }
function walletManifests() { return walletState.connected ? manifests.filter(walletOwnsManifest).filter(isUsableManifest) : []; }
function sanitizeFolderManifest(folder = {}) { Object.assign(folder, { kind: 'folder', isFolder: true, isEncrypted: false, visibility: 'private', isPublic: false, size: 0, storedSize: 0, totalChunks: 0, chunkSize: 0, chunks: [], encryption: null, replicas: Array.isArray(folder.replicas) ? folder.replicas : [] }); return folder; }
function walletFileManifests() { return walletManifests().filter((m) => m.kind !== FOLDER_MANIFEST_KIND && !m.isFolder); }
function walletFolderManifests() { return walletManifests().filter((m) => m.kind === FOLDER_MANIFEST_KIND || m.isFolder === true || String(m.hash || '').startsWith('folder:')).map(sanitizeFolderManifest); }
function folderOwnerIdentity() { return typeof activeIdentity === 'function' ? activeIdentity() : activeWallet(); }
function assertFolderIdentity() { if (typeof assertVerifiedIdentity === 'function') return assertVerifiedIdentity(); return assertVerifiedWallet(); }
function sanitizeFolderName(name = '') { const clean = String(name || '').trim().replace(/\s+/g, ' '); if (!clean) throw new Error('Folder name is required'); if (clean.length > 80) throw new Error('Folder name is too long'); if (['all files', 'uncategorized'].includes(clean.toLowerCase())) throw new Error('Reserved folder name'); return clean; }
function folderIdFromName(name = '') { return crypto.createHash('sha256').update(folderOwnerIdentity() + ':folder:' + String(name || '').trim().toLowerCase() + ':' + Date.now() + ':' + crypto.randomBytes(8).toString('hex')).digest('hex'); }
function findFolderById(folderId = '') { return walletFolderManifests().find((folder) => folder.folderId === String(folderId || '')); }
function findFolderByName(name = '') { return walletFolderManifests().find((folder) => String(folder.name || '').toLowerCase() === String(name || '').toLowerCase()); }
function assertFolderNotDescendant(folderId, parentFolderId) { let cursor = String(parentFolderId || ''); const seen = new Set(); while (cursor) { if (cursor === folderId) throw new Error('Cannot move folder inside itself or its child'); if (seen.has(cursor)) throw new Error('Folder tree cycle detected'); seen.add(cursor); const parent = findFolderById(cursor); cursor = parent?.parentFolderId || ''; } }
function totalStoredBytesForWallet() { return walletFileManifests().reduce((sum, file) => sum + Number(file.size || 0), 0); }
function visiblePlans() { return Object.values(PLANS).filter((plan) => !plan.hidden && !plan.aliasFor); }
function canonicalPlanId(planId = 'free') { return PLANS[planId]?.aliasFor || planId; }
function walletSummary() { const canonicalId = canonicalPlanId(walletState.planId); const plan = PLANS[canonicalId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, planId: canonicalId, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: visiblePlans(), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }
function assertWalletUploadAllowed(nextBytes = 0) { assertVerifiedWallet(); const plan = PLANS[walletState.planId] || PLANS.free; if (totalStoredBytesForWallet() + nextBytes > plan.quotaBytes) throw new Error(`Storage quota exceeded. Current plan: ${plan.name}.`); }
function findManifest(payload = {}) { const hash = String(payload.hash || ''); const rootHash = String(payload.rootHash || ''); return walletFileManifests().find((m) => m.hash === hash || m.rootHash === rootHash); }

async function syncPull() {
  const identity = activeWallet();

  if (!isManifestSyncEnabled() || !walletState.connected || !identity) {
    return { ok: false, skipped: true };
  }

  try {
    const remote = await pullWalletManifests(identity);

    if (!Array.isArray(remote)) return { ok: false, skipped: true };

    const map = new Map(
      manifests
        .filter(isUsableManifest)
        .map((m) => [`${normalizeWallet(m.ownerWallet)}:${m.hash}`, m])
    );

    for (const m of remote.filter(isUsableManifest)) {
      const key = `${normalizeWallet(m.ownerWallet)}:${m.hash}`;
      const local = map.get(key);

      map.set(key, {
        ...(local || {}),
        ...m,
        ownerWallet: normalizeWallet(m.ownerWallet),
        encryption: m.encryption || local?.encryption || null,
      });
    }

    manifests = Array.from(map.values()).filter(isUsableManifest);
    persistManifests();

    lastSyncStatus = {
      ...lastSyncStatus,
      ok: true,
      lastPulledAt: new Date().toISOString(),
      error: null,
      remoteFiles: remote.length,
    };

    return { ok: true, remoteFiles: remote.length };
  } catch (e) {
    lastSyncStatus = {
      ...lastSyncStatus,
      ok: false,
      error: e?.message || String(e),
    };

console.warn('[manifest-sync] pull failed (non-fatal):', e?.message || e);
return { ok: false, skipped: false, error: e?.message || String(e) };
  }
}
async function syncPush(manifest) {
  if (!isManifestSyncEnabled()) return { ok: false, skipped: true };
  try {
    const result = await pushWalletManifest(manifest);
    lastSyncStatus = { ...lastSyncStatus, ok: true, lastPushedAt: new Date().toISOString(), error: null };
    return result || { ok: true };
  } catch (e) {
    lastSyncStatus = { ...lastSyncStatus, ok: false, error: e?.message || String(e) };
    console.warn('[manifest-sync] push failed:', e?.message || e);
    throw new Error(`File was saved locally, but cross-device sync failed: ${e?.message || e}`);
  }
}
async function syncDelete(ownerWallet, hash) { try { if (isManifestSyncEnabled()) await deleteWalletManifest(ownerWallet, hash); } catch (e) { console.warn('[manifest-sync] delete failed:', e?.message || e); } }

function ensureTransport(options = {}) {
  if (!transportNode) {
    const port = Number(process.env.P2P_TRANSPORT_PORT || 8787);
    const publicUrl = process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || `ws://${firstLanAddress()}:${port}`;
    transportNode = startP2PTransport({ ...options, publicUrl, chunkStoreDir: chunkStoreDir() });
  }
  return transportNode;
}

async function runAutoRepair(reason = 'interval') {
  if (autoRepairRunning) {
    lastAutoRepairStatus = {
      ...lastAutoRepairStatus,
      active: true,
      skippedReason: 'already-running',
    };
    return lastAutoRepairStatus;
  }

  if (!walletState.connected || !walletState.verified || !activeWallet()) {
    lastAutoRepairStatus = {
      ...lastAutoRepairStatus,
      active: Boolean(autoRepairTimer),
      skippedReason: 'identity-not-verified',
      error: null,
    };
    return lastAutoRepairStatus;
  }

  const node = ensureTransport({});
  const own = walletManifests();

  // Skip repair if no peers available (P2P peers OR safety peer)
  const connectedPeers = node.connectedPeerIds?.() || [];
  const hasSafetyPeer = Boolean(safetyPeerUrl());
  if (connectedPeers.length === 0 && !hasSafetyPeer) {
    lastAutoRepairStatus = {
      ...lastAutoRepairStatus,
      active: Boolean(autoRepairTimer),
      skippedReason: 'no-peers',
      error: null,
    };
    console.log('[auto-repair] skipped: no peers connected (will retry on next interval)');
    return lastAutoRepairStatus;
  }

  const underReplicatedChunks = countUnderReplicatedChunks(node, own, TARGET_REPLICAS);

  if (underReplicatedChunks <= 0) {
    lastAutoRepairStatus = {
      ok: true,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks: 0,
      underReplicatedChunks: 0,
      skippedReason: 'healthy',
      error: null,
    };
    return lastAutoRepairStatus;
  }

  autoRepairRunning = true;

  try {
    console.log(`[auto-repair] ${reason}: repairing ${underReplicatedChunks} under-replicated chunk(s)`);

    const result = await repairManifests({
      node,
      manifests: own,
      configuredTargetReplicas: TARGET_REPLICAS,
      persistManifests,
      syncPush,
    });

    const repairedChunks = (result.report || []).filter((entry) => entry.repaired).length;

    lastAutoRepairStatus = {
      ok: true,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks,
      underReplicatedChunks,
      skippedReason: null,
      error: null,
    };

    return lastAutoRepairStatus;
  } catch (error) {
    lastAutoRepairStatus = {
      ok: false,
      active: Boolean(autoRepairTimer),
      intervalMs: AUTO_REPAIR_INTERVAL_MS,
      lastRunAt: new Date().toISOString(),
      repairedChunks: 0,
      underReplicatedChunks,
      skippedReason: null,
      error: error?.message || String(error),
    };

    console.warn('[auto-repair] failed:', error?.message || error);
    return lastAutoRepairStatus;
  } finally {
    autoRepairRunning = false;
  }
}

function startAutoRepairLoop() {
  if (autoRepairTimer) return;
  autoRepairTimer = setInterval(() => {
    runAutoRepair('interval').catch((error) => console.warn('[auto-repair] unhandled:', error?.message || error));
  }, AUTO_REPAIR_INTERVAL_MS);
  autoRepairTimer.unref?.();
  lastAutoRepairStatus = { ...lastAutoRepairStatus, active: true, intervalMs: AUTO_REPAIR_INTERVAL_MS, skippedReason: 'waiting' };
  // Delay startup repair by 5 minutes to let peers connect first
  setTimeout(() => {
    runAutoRepair('startup-delayed').catch((error) => console.warn('[auto-repair] startup-delayed failed:', error?.message || error));
  }, 300_000);
  console.log('[auto-repair] startup repair scheduled in 5 minutes (skips automatically if no peers)');
}

function stopAutoRepairLoop() {
  if (!autoRepairTimer) return;
  clearInterval(autoRepairTimer);
  autoRepairTimer = null;
  lastAutoRepairStatus = { ...lastAutoRepairStatus, active: false, skippedReason: 'stopped' };
}

function safePeerList(node) {
  return Array.from(node.peerInfo?.values?.() || []).slice(0, 50).map((peer) => ({ peerId: String(peer.peerId || ''), url: peer.url || null, status: peer.status || null, direction: peer.direction || null, lastSeen: peer.lastSeen || null }));
}

function networkSummary() {
  const node = ensureTransport({});
  const own = walletManifests();
  const connectedPeers = node.connectedPeerIds?.() || [];
  return { ok: true, peerId: node.peerId, port: node.port, host: node.host, listenUrl: `ws://127.0.0.1:${node.port}`, publicPeerUrl: publicPeerUrl(node), safetyPeerUrl: safetyPeerUrl(), connectedPeers: connectedPeers.length, peerCount: connectedPeers.length, peers: safePeerList(node), targetReplicas: TARGET_REPLICAS, totalFiles: own.length, encryptedFiles: own.filter((f) => f.isEncrypted).length, publicFiles: own.filter((f) => !f.isEncrypted).length, totalBytes: own.reduce((s, f) => s + Number(f.size || 0), 0), totalChunks: own.reduce((s, f) => s + Number(f.chunks?.length || 0), 0), underReplicatedChunks: countUnderReplicatedChunks(node, own, TARGET_REPLICAS), transferProgress, transferSettings: { uploadConcurrency: UPLOAD_CONCURRENCY, downloadConcurrency: DOWNLOAD_CONCURRENCY }, autoRepair: lastAutoRepairStatus, wallet: walletSummary(), sync: lastSyncStatus };
}

function resolvePreloadPath() { const preloadPath = path.join(__dirname, 'preload.cjs'); if (!fs.existsSync(preloadPath)) throw new Error(`Missing Electron preload file: ${preloadPath}`); return preloadPath; }
function resolveRendererIndexPath() { const candidates = [path.join(app.getAppPath(), 'dist', 'public', 'index.html'), path.join(app.getAppPath(), 'public', 'index.html'), path.join(__dirname, '..', 'dist', 'public', 'index.html'), path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html')]; for (const c of candidates) if (c && fs.existsSync(c)) return c; throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`); }
function createMainWindow() { mainWindow = new BrowserWindow({ title: APP_TITLE, width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#09090b', show: false, webPreferences: { preload: resolvePreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false } }); mainWindow.once('ready-to-show', () => mainWindow?.show()); mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); if (IS_DEV) mainWindow.loadURL(DEV_SERVER_URL); else mainWindow.loadFile(resolveRendererIndexPath()); mainWindow.on('closed', () => { mainWindow = null; }); }

ipcMain.handle('wallet:status', async () => {
  loadWallet();
  loadManifests();

  if (walletState.connected && walletState.verified) {
    try {
      await syncPull();
    } catch (error) {
      lastSyncStatus = {
        ...lastSyncStatus,
        ok: false,
        error: error?.message || String(error),
      };
    }
  }

  return walletSummary();
});

ipcMain.handle('wallet:connect', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();

  const address = normalizeWallet(payload.address);

  if (!isValidWallet(address)) {
    throw new Error('Invalid wallet address. Expected 0x + 40 hex characters.');
  }

  const login = await verifyWalletLoginPayload(payload, address);
  const sameWallet = address === activeWallet();

  walletState = {
    ...walletState,
    connected: true,
    verified: true,
    authMode: 'wallet',
    address,
    accountId: address,
    username: null,
    seedFingerprint: null,
    planId: sameWallet && PLANS[walletState.planId] ? walletState.planId : 'free',
    connectedAt: new Date().toISOString(),
    verifiedAt: login.signedAt,
    loginMessage: login.message,
    loginSignature: undefined,
    encryptionSecret: undefined,
    encryptionKeySource: ENCRYPTION_KEY_SOURCE,
  };

  persistWallet();

  try {
    await syncPull();
  } catch (error) {
    lastSyncStatus = {
      ...lastSyncStatus,
      ok: false,
      error: error?.message || String(error),
    };
  }

  startAutoRepairLoop();

  return walletSummary();
});

ipcMain.handle('wallet:disconnect', async () => {
  stopAutoRepairLoop();

  walletState = {
    ...walletState,
    connected: false,
    verified: false,
    authMode: null,
    address: '',
    accountId: '',
    username: null,
    seedFingerprint: null,
    planId: 'free',
    connectedAt: null,
    verifiedAt: null,
    paidUntil: null,
    subscriptionTx: null,
    loginMessage: null,
    loginSignature: undefined,
    encryptionSecret: undefined,
    encryptionKeySource: ENCRYPTION_KEY_SOURCE,
  };

  persistWallet();
  return walletSummary();
});
ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const requestedPlanId = String(payload.planId || 'free'); const planId = canonicalPlanId(requestedPlanId); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });

function checkoutUrlMatches(currentUrl = '', targetUrl = '') {
  try {
    const current = new URL(String(currentUrl || ''));
    const target = new URL(String(targetUrl || ''));
    return current.origin === target.origin && current.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function isPayPalApproveUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'paypal.com' || host.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}

ipcMain.handle('paypal:openCheckout', async (_event, payload = {}) => {
  const approveUrl = String(payload.approveUrl || '').trim();
  const returnUrl = String(payload.returnUrl || 'https://example.com/chunknet-payment-success').trim();
  const cancelUrl = String(payload.cancelUrl || 'https://example.com/chunknet-payment-cancel').trim();

  if (!isPayPalApproveUrl(approveUrl)) throw new Error('Invalid PayPal checkout URL');

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      minWidth: 420,
      minHeight: 620,
      title: 'Chunknet PayPal Checkout',
      parent: parent || undefined,
      modal: Boolean(parent),
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: true,
        partition: 'persist:chunknet-paypal-checkout',
      },
    });

    try {
      win.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
    } catch {}

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      resolve(result);
    };

    const inspect = (url) => {
      if (checkoutUrlMatches(url, returnUrl)) {
        finish({ ok: true, url });
        return true;
      }
      if (checkoutUrlMatches(url, cancelUrl)) {
        finish({ ok: false, cancelled: true, url });
        return true;
      }
      return false;
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (inspect(url)) return { action: 'deny' };
      try {
        const next = new URL(url);
        const host = next.hostname.toLowerCase();
        if (next.protocol === 'https:' && (host === 'paypal.com' || host.endsWith('.paypal.com'))) {
          win.loadURL(url).catch(() => {});
          return { action: 'deny' };
        }
      } catch {}
      return { action: 'deny' };
    });

    win.webContents.on('will-redirect', (event, url) => { if (inspect(url)) event.preventDefault(); });
    win.webContents.on('will-navigate', (event, url) => { if (inspect(url)) event.preventDefault(); });
    win.webContents.on('did-navigate', (_event, url) => inspect(url));
    win.webContents.on('did-navigate-in-page', (_event, url) => inspect(url));

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, cancelled: true, closed: true });
      }
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (settled) return;
      // PayPal often aborts an internal navigation while redirecting between checkout pages.
      // This is not a failed payment, so do not reject the checkout promise.
      if (errorCode === -3 || String(errorDescription || '').includes('ERR_ABORTED')) return;
      console.warn('[paypal-window] did-fail-load', { errorCode, errorDescription, validatedURL });
    });

    win.loadURL(approveUrl).catch((error) => {
      if (settled) return;
      if (error?.code === 'ERR_ABORTED' || String(error?.message || '').includes('ERR_ABORTED')) {
        console.warn('[paypal-window] ignored ERR_ABORTED during PayPal redirect');
        return;
      }
      settled = true;
      reject(error);
    });
  });
});


function uiPrefsPath() {
  ensureDataDir();
  return path.join(dataDir, 'ui-prefs.json');
}

function readUiPrefs() {
  try {
    const filePath = uiPrefsPath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeUiPrefs(prefs = {}) {
  const next = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  fs.mkdirSync(path.dirname(uiPrefsPath()), { recursive: true });
  fs.writeFileSync(uiPrefsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

ipcMain.handle('p2p:getUiPrefs', async () => ({ ok: true, prefs: readUiPrefs() }));
ipcMain.handle('p2p:setUiPrefs', async (_event, payload = {}) => {
  const incoming = payload?.prefs && typeof payload.prefs === 'object' && !Array.isArray(payload.prefs)
    ? payload.prefs
    : payload;
  const { ok: _ok, prefs: _prefs, ...cleanIncoming } = incoming || {};
  const prefs = writeUiPrefs({ ...readUiPrefs(), ...cleanIncoming });
  return { ok: true, prefs };
});

ipcMain.handle('p2p:start', async (_event, options = {}) => { ensureDataDir(); loadWallet(); loadManifests(); ensureTransport(options); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } return networkSummary(); });
ipcMain.handle('p2p:listFolders', async () => {
  if (!walletState.connected || !walletState.verified) return [];
  await syncPull();
  return walletFolderManifests().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
});

ipcMain.handle('p2p:createFolder', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const ownerWallet = folderOwnerIdentity();
  const name = sanitizeFolderName(payload.name);
  const parentFolderId = String(payload.parentFolderId || '');
  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Parent folder not found');
  if (walletFolderManifests().some((folder) => String(folder.parentFolderId || '') === parentFolderId && String(folder.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');
  const folderId = folderIdFromName(name);
  const folder = { kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, id: ownerWallet + ':folder:' + folderId, hash: 'folder:' + folderId, rootHash: 'folder:' + folderId, folderId, name, parentFolderId, ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, storedSize: 0, totalChunks: 0, chunks: [], replicas: [], isEncrypted: false, visibility: 'private', isPublic: false, isFolder: true };
  manifests.push(folder);
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});

ipcMain.handle('p2p:renameFolder', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const folderId = String(payload.folderId || '');
  const name = sanitizeFolderName(payload.name);
  const folder = findFolderById(folderId) || findFolderByName(payload.oldName || '');
  if (!folder) throw new Error('Folder not found');
  if (walletFolderManifests().some((candidate) => candidate.folderId !== folder.folderId && String(candidate.parentFolderId || '') === String(folder.parentFolderId || '') && String(candidate.name || '').toLowerCase() === name.toLowerCase())) throw new Error('Folder already exists here');
  Object.assign(folder, { name, updatedAt: new Date().toISOString(), visibility: 'private', isPublic: false });
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});

ipcMain.handle('p2p:moveFolder', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const folderId = String(payload.folderId || '');
  const parentFolderId = String(payload.parentFolderId || '');
  const folder = findFolderById(folderId) || findFolderByName(payload.name || '');
  if (!folder) throw new Error('Folder not found');
  if (parentFolderId && !findFolderById(parentFolderId)) throw new Error('Target folder not found');
  assertFolderNotDescendant(folder.folderId, parentFolderId);
  Object.assign(folder, { parentFolderId, updatedAt: new Date().toISOString(), visibility: 'private', isPublic: false });
  persistManifests();
  await syncPush(folder);
  await syncPull();
  return { ok: true, folder, folders: walletFolderManifests() };
});

ipcMain.handle('p2p:deleteFolder', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const folder = findFolderById(String(payload.folderId || '')) || findFolderByName(payload.name || '');
  if (!folder) throw new Error('Folder not found');
  const removed = new Set([folder.folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of walletFolderManifests()) if (!removed.has(child.folderId) && removed.has(String(child.parentFolderId || ''))) { removed.add(child.folderId); changed = true; }
  }
  const changedFiles = [];
  for (const file of walletFileManifests()) {
    if (removed.has(String(file.folderId || ''))) {
      file.folderId = '';
      file.folderName = '';
      file.folder = '';
      file.updatedAt = new Date().toISOString();
      changedFiles.push(file);
    }
  }
  const removedFolders = walletFolderManifests().filter((candidate) => removed.has(candidate.folderId));
  manifests = manifests.filter((m) => !(m.kind === FOLDER_MANIFEST_KIND && removed.has(m.folderId)));
  persistManifests();
  for (const file of changedFiles) await syncPush(file);
  for (const removedFolder of removedFolders) await syncDelete(folderOwnerIdentity(), removedFolder.hash);
  await syncPull();
  return { ok: true, removed: removed.size, folders: walletFolderManifests() };
});

ipcMain.handle('p2p:moveFile', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this identity');
  const folderId = String(payload.folderId || '');
  const folder = folderId ? findFolderById(folderId) : (payload.folderName ? findFolderByName(payload.folderName) : null);
  if (folderId && !folder) throw new Error('Target folder not found');
  manifest.folderId = folder?.folderId || '';
  manifest.folderName = folder?.name || String(payload.folderName || '');
  manifest.folder = manifest.folderName;
  manifest.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(manifest);
  await syncPull();
  return { ok: true, file: manifest };
});


ipcMain.handle('p2p:updateFile', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const hash = String(payload.hash || payload.rootHash || '');
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
  const manifest = walletFileManifests().find((file) => file.hash === hash || file.rootHash === hash);
  if (!manifest) throw new Error('File not found for this identity');

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nextName = String(patch.name || '').trim();
    if (!nextName) throw new Error('File name is required');
    manifest.name = nextName;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'folder')) {
    const folderName = String(patch.folder || '').trim();
    if (!folderName) {
      manifest.folderId = '';
      manifest.folderName = '';
      manifest.folder = '';
    } else {
      let folder = findFolderByName(folderName);
      if (!folder) {
        const ownerWallet = folderOwnerIdentity();
        const folderId = folderIdFromName(folderName);
        folder = { kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, id: ownerWallet + ':folder:' + folderId, hash: 'folder:' + folderId, rootHash: 'folder:' + folderId, folderId, name: folderName, parentFolderId: '', ownerWallet, ownerNodeId: ensureTransport({}).peerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 0, storedSize: 0, totalChunks: 0, chunks: [], replicas: [], isEncrypted: false, visibility: 'private', isPublic: false, isFolder: true };
        manifests.push(folder);
        await syncPush(folder);
      }
      manifest.folderId = folder.folderId;
      manifest.folderName = folder.name;
      manifest.folder = folder.name;
    }
  }

  manifest.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(manifest);
  await syncPull();
  return { ok: true, file: manifest };
});

ipcMain.handle('p2p:listFiles', async (_event, payload = {}) => {
  if (!walletState.connected || !walletState.verified) return [];
  await syncPull();
  const query = String(payload.query || '').trim().toLowerCase();
  const folders = typeof walletFolderManifests === 'function' ? walletFolderManifests() : walletManifests().filter((m) => m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:'));
  const files = typeof walletFileManifests === 'function' ? walletFileManifests() : walletManifests().filter((m) => !(m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:')));
  const folderById = new Map();
  const folderByName = new Map();
  for (const folder of folders) {
    const name = String(folder.name || '').trim();
    if (name) folderByName.set(name.toLowerCase(), folder);
    for (const id of [folder.folderId, folder.id, folder.hash, folder.rootHash].filter(Boolean)) folderById.set(String(id), folder);
  }
  const changed = [];
  for (const file of files) {
    const rawId = String(file.parentFolderId || file.folderId || '').trim();
    const rawName = String(file.folderName || file.folder || '').trim();
    const folder = (rawId && folderById.get(rawId)) || (rawName && folderByName.get(rawName.toLowerCase())) || null;
    const nextFolderId = folder ? String(folder.folderId || '') : '';
    const nextFolderName = folder ? String(folder.name || '') : '';
    if (String(file.folderId || '') !== nextFolderId || String(file.parentFolderId || '') !== nextFolderId || String(file.folderName || '') !== nextFolderName || String(file.folder || '') !== nextFolderName) {
      file.folderId = nextFolderId;
      file.parentFolderId = nextFolderId;
      file.folderName = nextFolderName;
      file.folder = nextFolderName;
      file.updatedAt = new Date().toISOString();
      changed.push(file);
    }
  }
  if (changed.length) {
    persistManifests();
    for (const file of changed) await syncPush(file);
    console.log('[p2p:listFiles] normalized stale folder labels', changed.length);
  }
  if (!query) return files;
  return files.filter((f) => [f.name, f.hash, f.rootHash, f.ownerWallet || '', f.folderName || '', f.folder || ''].some((v) => String(v || '').toLowerCase().includes(query)));
});

ipcMain.handle('p2p:upload', async (_event, payload = {}) => {
  const node = ensureTransport({});
  if (!payload.bytes) throw new Error('File bytes are required');
  const originalBuffer = Buffer.from(payload.bytes);
  assertWalletUploadAllowed(originalBuffer.length);
  const ownerWallet = activeWallet();
  const privateFile = Boolean(payload.isEncrypted);
  const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
  const secured = privateFile ? await encryptPrivateBuffer(originalBuffer, ownerWallet, drivePassword) : { ciphertext: originalBuffer, encryption: null };
  const storedBuffer = secured.ciphertext;
  const chunks = splitIntoChunks(storedBuffer);
  const tree = buildMerkleTree(chunks.map((c) => c.hash));
  const storedHash = hashBufferHex(storedBuffer);
  const fileReplicas = new Set([node.peerId]);
  const chunkResults = new Array(chunks.length);
  const uploadConcurrency = clampConcurrency(payload.uploadConcurrency, UPLOAD_CONCURRENCY, 12);
  createProgress('upload', { fileName: String(payload.name || 'file'), totalBytes: storedBuffer.length, totalChunks: chunks.length, concurrency: uploadConcurrency });

  try {
    await mapWithConcurrency(chunks, uploadConcurrency, async (chunk) => {
      const chunkPayload = { hash: chunk.hash, data: chunk.data.toString('base64'), index: chunk.index, size: chunk.size, ownerWallet, encrypted: privateFile };
      const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);
      try {
        await putChunkToSafetyPeer(chunkPayload, node.peerId);
        replicas.push('aws-safety-peer');
      } catch (error) {
        throw new Error(`Safety peer upload failed for chunk ${chunk.hash}: ${error?.message || error}`);
      }
      chunkResults[chunk.index] = { index: chunk.index, hash: chunk.hash, size: chunk.size, replicas: unique(replicas), proof: getMerkleProof(tree, chunk.index) };
      updateProgress('upload', { bytesDelta: chunk.size, chunkDelta: 1 });
    });
  } catch (error) {
    finishProgress('upload', 'error', error?.message || String(error));
    throw error;
  }

  const targetFolderId = String(payload.folderId || '');
  const targetFolder = targetFolderId ? findFolderById(targetFolderId) : (payload.folderName ? findFolderByName(payload.folderName) : null);
  if (targetFolderId && !targetFolder) throw new Error('Target folder not found');
  const manifest = { id: `${ownerWallet}:${storedHash}`, name: String(payload.name || 'file'), size: originalBuffer.length, storedSize: storedBuffer.length, hash: storedHash, rootHash: tree.root, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isEncrypted: privateFile, visibility: privateFile ? 'private' : 'public', isPublic: !privateFile, encryption: secured.encryption, mimeType: payload.mimeType ? String(payload.mimeType) : 'application/octet-stream', folderId: targetFolder?.folderId || '', folderName: targetFolder?.name || String(payload.folderName || ''), folder: targetFolder?.name || String(payload.folderName || ''), chunkSize: CHUNK_SIZE_BYTES, totalChunks: chunks.length, ownerNodeId: node.peerId, ownerWallet, planId: walletState.planId, replicas: [node.peerId], chunks: chunkResults };

  for (const chunkMeta of manifest.chunks) {
    for (const peerId of chunkMeta.replicas || []) fileReplicas.add(peerId);
  }

  manifest.replicas = unique(Array.from(fileReplicas));
  manifests = manifests.filter((m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash));
  manifests.push(manifest);
  persistManifests();
  persistWallet();
  await syncPush(manifest);
  await syncPull();
  finishProgress('upload');
  return { ok: true, file: manifest, summary: networkSummary(), sync: lastSyncStatus, progress: transferProgress.upload };
});

ipcMain.handle('p2p:download', async (_event, payload = {}) => {
  assertVerifiedWallet();
  await syncPull();
  const node = ensureTransport({});
  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this wallet');
  // Guard: files >100MB should use save-to-disk to avoid heap exhaustion
  const IN_MEMORY_MAX_BYTES = 100 * 1024 * 1024;
  if (Number(manifest.size || manifest.storedSize || 0) > IN_MEMORY_MAX_BYTES) {
    throw new Error('File is too large for in-memory download (>100 MB). Use "Download to file" instead.');
  }
  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  const buffers = new Array(orderedChunks.length);
  const downloadConcurrency = clampConcurrency(payload.downloadConcurrency, DOWNLOAD_CONCURRENCY, 16);
  createProgress('download', { fileName: manifest.name, totalBytes: Number(manifest.storedSize || manifest.size || 0), totalChunks: orderedChunks.length, concurrency: downloadConcurrency });

  try {
    await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {
      const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
      let chunk = local;
      if (!chunk) {
        try {
          chunk = await node.fetchChunkFromNetwork(meta.hash);
        } catch (error) {
          console.warn('[p2p:download] network fetch failed, trying safety peer:', error?.message || error);
          chunk = await getChunkFromSafetyPeer(meta.hash, node.peerId);
        }
      }
      node.storeLocalChunk?.(chunk);
      const buffer = Buffer.from(chunk.data, 'base64');
      if (hashBufferHex(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`);
      buffers[meta.index] = buffer;
      updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
    });
  } catch (error) {
    finishProgress('download', 'error', error?.message || String(error));
    throw error;
  }

  const storedBuffer = Buffer.concat(buffers);
  if (hashBufferHex(storedBuffer) !== manifest.hash) throw new Error('File integrity failed');
  const drivePassword = manifest.isEncrypted ? drivePasswordFromPayload(payload) : null;
  const outputBuffer = manifest.isEncrypted ? await decryptPrivateBuffer(storedBuffer, manifest, drivePassword) : storedBuffer;
  finishProgress('download');
  return { ok: true, file: manifest, bytes: Array.from(outputBuffer), progress: transferProgress.download };
});
ipcMain.handle('p2p:delete', async (_event, payload = {}) => { assertVerifiedWallet(); await syncPull(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); manifests = manifests.filter((m) => !(walletOwnsManifest(m) && m.hash === manifest.hash)); persistManifests(); await syncDelete(activeWallet(), manifest.hash); return { ok: true, summary: networkSummary() }; });
for (const channel of [
  'p2p:uploadFiles',
  'p2p:downloadToPath',
  'p2p:moveItem',
  'p2p:renameItem',
  'p2p:deleteItem',
]) {
  try { ipcMain.removeHandler(channel); } catch {}
}

function safeOutputName(name = 'download') {
  return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_');
}

function isFolderManifest(manifest = {}) {
  return (
    manifest.kind === 'folder' ||
    manifest.type === 'folder' ||
    manifest.isFolder === true ||
    manifest.name === '.p2p-folder' ||
    Boolean(manifest.folderId && !manifest.chunks?.length) ||
    Boolean(manifest.folderId && String(manifest.hash || '').startsWith('folder:'))
  );
}

function manifestItemId(manifest = {}) {
  return String(manifest.folderId || manifest.id || manifest.rootHash || manifest.hash || '');
}

function canTouchManifest(manifest = {}) {
  const owner = normalizeWallet(manifest.ownerWallet || manifest.owner || manifest.wallet || '');
  return !owner || owner === activeWallet();
}

function ownedManifestCandidates() {
  return manifests
    .filter(isUsableManifest)
    .filter(canTouchManifest);
}

function manifestValues(manifest = {}) {
  const hash = String(manifest.hash || '').trim();
  const rootHash = String(manifest.rootHash || '').trim();

  return unique([
    manifest.id,
    manifest.fileId,
    manifest.folderId,
    manifest.itemId,
    hash,
    rootHash,
    hash.replace(/^folder:/, ''),
    rootHash.replace(/^folder:/, ''),
    manifest.name,
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function payloadIds(payload = {}) {
  return unique([
    payload.itemId,
    payload.folderId,
    payload.fileId,
    payload.id,
    payload.rootHash,
    payload.hash,
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function folderFromPayload(payload = {}) {
  const folderId = String(payload.folderId || payload.itemId || payload.id || '').trim();

  if (!folderId) return null;

  return {
    kind: 'folder',
    type: 'folder',
    isFolder: true,
    folderId,
    id: folderId,
    hash: `folder:${folderId}`,
    rootHash: `folder:${folderId}`,
    ownerWallet: activeWallet(),
    name: String(payload.name || ''),
    parentFolderId: String(payload.parentFolderId || ''),
    updatedAt: new Date().toISOString(),
  };
}

function findAnyItem(payload = {}) {
  const ids = payloadIds(payload);

  if (!ids.length) return null;

  return ownedManifestCandidates().find((manifest) => {
    const values = manifestValues(manifest);
    return ids.some((id) => values.includes(id));
  }) || null;
}

function findFolderByAny(value = '') {
  const id = String(value || '').trim();

  if (!id) return null;

  return ownedManifestCandidates().find((manifest) => {
    if (!isFolderManifest(manifest)) return false;
    return manifestValues(manifest).includes(id);
  }) || null;
}

function folderDisplayName(folder) {
  return folder?.name || '';
}

function ensureManifestTracked(item) {
  if (!item) return null;

  const existing = findAnyItem({
    itemId: item.folderId || item.id || item.hash || item.rootHash,
    hash: item.hash,
    rootHash: item.rootHash,
  });

  if (existing) return existing;

  if (!item.ownerWallet) item.ownerWallet = activeWallet();

  if (isFolderManifest(item)) {
    const folderId = String(item.folderId || item.id || item.hash || crypto.randomUUID())
      .replace(/^folder:/, '')
      .trim();

    item.folderId = folderId;
    item.id = item.id || folderId;
    item.hash = item.hash || `folder:${folderId}`;
    item.rootHash = item.rootHash || item.hash;
    item.kind = item.kind || 'folder';
    item.type = item.type || 'folder';
    item.isFolder = true;
    item.updatedAt = new Date().toISOString();
  }

  manifests.push(item);
  return item;
}

function assertFolderMoveSafe(folderId, targetFolderId) {
  const source = String(folderId || '').replace(/^folder:/, '').trim();
  const target = String(targetFolderId || '').replace(/^folder:/, '').trim();

  if (!source || !target) return;

  if (source === target) {
    throw new Error('Cannot move folder into itself');
  }

  const folders = ownedManifestCandidates().filter(isFolderManifest);
  let cursor = target;
  const seen = new Set();

  while (cursor) {
    if (cursor === source) {
      throw new Error('Cannot move folder inside its child');
    }

    if (seen.has(cursor)) {
      throw new Error('Folder tree cycle detected');
    }

    seen.add(cursor);

    const parent = folders.find((folder) => {
      const id = String(folder.folderId || manifestItemId(folder) || '')
        .replace(/^folder:/, '')
        .trim();

      return id === cursor;
    });

    cursor = String(parent?.parentFolderId || '')
      .replace(/^folder:/, '')
      .trim();
  }
}

function descendantFolderIds(rootFolderId) {
  const root = String(rootFolderId || '').replace(/^folder:/, '').trim();
  const removed = new Set();

  if (root) removed.add(root);

  const folders = ownedManifestCandidates().filter(isFolderManifest);

  let changed = true;

  while (changed) {
    changed = false;

    for (const folder of folders) {
      const id = String(folder.folderId || manifestItemId(folder) || '')
        .replace(/^folder:/, '')
        .trim();

      const parent = String(folder.parentFolderId || '')
        .replace(/^folder:/, '')
        .trim();

      if (id && parent && removed.has(parent) && !removed.has(id)) {
        removed.add(id);
        changed = true;
      }
    }
  }

  return removed;
}

function findOrFallbackManifestItem(payload = {}) {
  const lookupId = String(
    payload.itemId ||
    payload.id ||
    payload.hash ||
    payload.rootHash ||
    payload.folderId ||
    payload.folderPath ||
    payload.name ||
    ''
  ).trim();

  let item = findOwnedManifestItemById(lookupId);

  if (item) return item;

  const cleanId = lookupId.replace(/^folder:/, '').trim();

  if (!cleanId) return null;

  return {
    kind: typeof FOLDER_MANIFEST_KIND !== 'undefined' ? FOLDER_MANIFEST_KIND : 'folder',
    type: 'folder',
    isFolder: true,
    folderId: cleanId,
    id: cleanId,
    hash: `folder:${cleanId}`,
    rootHash: `folder:${cleanId}`,
    ownerWallet: typeof folderOwnerIdentity === 'function' ? folderOwnerIdentity() : activeWallet(),
    name: String(payload.name || payload.folderPath || cleanId),
    visibility: 'private',
    isPublic: false,
    isEncrypted: false,
    chunks: [],
    chunkSize: 0,
    totalChunks: 0,
    size: 0,
    storedSize: 0,
    updatedAt: new Date().toISOString(),
  };
}


function manifestItemIsFolder(item = {}) {
  if (typeof isFolderManifest === 'function') return isFolderManifest(item);

  return (
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    item.name === '.p2p-folder' ||
    Boolean(item.folderId && !item.chunks?.length) ||
    String(item.hash || '').startsWith('folder:')
  );
}

function manifestItemIds(item = {}) {
  const hash = String(item.hash || '').trim();
  const rootHash = String(item.rootHash || '').trim();

  return Array.from(new Set([
    item.itemId,
    item.id,
    item.fileId,
    item.folderId,
    hash,
    rootHash,
    hash.replace(/^folder:/, ''),
    rootHash.replace(/^folder:/, ''),
    item.name,
  ].map((value) => String(value || '').trim()).filter(Boolean)));
}

function manifestItemMatchesAnyId(item = {}, ids = new Set()) {
  const normalized = new Set(
    Array.from(ids || [])
      .map((value) => String(value || '').replace(/^folder:/, '').trim())
      .filter(Boolean)
  );

  return manifestItemIds(item).some((id) => {
    const clean = String(id || '').replace(/^folder:/, '').trim();
    return normalized.has(id) || normalized.has(clean);
  });
}

function manifestOwnNameLower(item = {}) {
  return String(item.name || '').trim().toLowerCase();
}

function normalizeParentFolderId(value = '') {
  return String(value || '').replace(/^folder:/, '').trim();
}

function manifestFolderNameLower(item = {}) {
  return String(item.folderName || item.folder || '').trim().toLowerCase();
}

function manifestDeleteOwnerIdentity() {
  return typeof folderOwnerIdentity === 'function' ? folderOwnerIdentity() : activeWallet();
}


function assertValidMoveTarget(item = {}, targetFolderId = null) {
  const targetId = String(targetFolderId || '').replace(/^folder:/, '').trim();

  // empty target = root / uncategorized
  if (!targetId) return null;

  const folders =
    typeof walletFolderManifests === 'function'
      ? walletFolderManifests()
      : walletManifests().filter((m) =>
          typeof manifestItemIsFolder === 'function'
            ? manifestItemIsFolder(m)
            : (m.kind === 'folder' || m.isFolder === true || String(m.hash || '').startsWith('folder:'))
        );

  const targetFolder = folders.find((folder) => {
    const ids =
      typeof manifestItemIds === 'function'
        ? manifestItemIds(folder)
        : [folder.folderId, folder.id, folder.hash, folder.rootHash];

    return ids
      .map((id) => String(id || '').replace(/^folder:/, '').trim())
      .includes(targetId);
  });

  if (!targetFolder) {
    throw new Error(`Target folder not found: ${targetId}`);
  }

  const sourceIsFolder =
    typeof manifestItemIsFolder === 'function'
      ? manifestItemIsFolder(item)
      : (item.kind === 'folder' || item.isFolder === true || String(item.hash || '').startsWith('folder:'));

  if (!sourceIsFolder) {
    return targetFolder;
  }

  const sourceIds =
    typeof manifestItemIds === 'function'
      ? manifestItemIds(item)
      : [item.folderId, item.id, item.hash, item.rootHash];

  const sourceSet = new Set(
    sourceIds
      .map((id) => String(id || '').replace(/^folder:/, '').trim())
      .filter(Boolean)
  );

  if (sourceSet.has(targetId)) {
    throw new Error('Cannot move folder into itself');
  }

  let cursor = String(targetFolder.parentFolderId || '')
    .replace(/^folder:/, '')
    .trim();

  const seen = new Set();

  while (cursor) {
    if (sourceSet.has(cursor)) {
      throw new Error('Cannot move folder inside its child');
    }

    if (seen.has(cursor)) {
      throw new Error('Folder tree cycle detected');
    }

    seen.add(cursor);

    const parent = folders.find((folder) => {
      const ids =
        typeof manifestItemIds === 'function'
          ? manifestItemIds(folder)
          : [folder.folderId, folder.id, folder.hash, folder.rootHash];

      return ids
        .map((id) => String(id || '').replace(/^folder:/, '').trim())
        .includes(cursor);
    });

    cursor = String(parent?.parentFolderId || '')
      .replace(/^folder:/, '')
      .trim();
  }

  return targetFolder;
}

ipcMain.handle('p2p:moveItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOrFallbackManifestItem(payload);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);
  const targetFolder = assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? payload.folderId ?? null);
  const nextParentId = targetFolder ? String(targetFolder.folderId || targetFolder.id) : '';
  item.parentFolderId = nextParentId;
  if (!manifestItemIsFolder(item)) {
    item.folderId = nextParentId;
    item.folderName = targetFolder?.name || '';
    item.folder = item.folderName;
  }
  item.updatedAt = new Date().toISOString();
  persistManifests();
  await syncPush(item);
  await syncPull();
  return { ok: true, item };
});

ipcMain.handle('p2p:renameItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOrFallbackManifestItem(payload);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);
  const name = sanitizeFolderName(payload.name);
  const oldName = String(item.name || '').trim();
  const oldNameLower = oldName.toLowerCase();
  item.name = name;
  item.updatedAt = new Date().toISOString();
  const changedFiles = [];
  if (manifestItemIsFolder(item)) {
    Object.assign(item, { kind: FOLDER_MANIFEST_KIND, isFolder: true, visibility: 'private', isPublic: false, isEncrypted: false, chunks: [], chunkSize: 0, totalChunks: 0, size: 0, storedSize: 0 });
    const folderId = String(item.folderId || item.id || '');
    for (const candidate of walletManifests()) {
      if (manifestItemIsFolder(candidate)) continue;
      const candidateParentId = normalizeParentFolderId(candidate.parentFolderId || candidate.folderId);
      const candidateParentIdLower = candidateParentId.toLowerCase();
      const candidateFolderName = manifestFolderNameLower(candidate);
      if ((folderId && candidateParentId === folderId) || (oldNameLower && (candidateFolderName === oldNameLower || candidateParentIdLower === oldNameLower))) {
        candidate.folderId = folderId;
        candidate.parentFolderId = folderId;
        candidate.folderName = name;
        candidate.folder = name;
        candidate.updatedAt = new Date().toISOString();
        changedFiles.push(candidate);
      }
    }
  }
  persistManifests();
  await syncPush(item);
  for (const file of changedFiles) await syncPush(file);
  await syncPull();
  return { ok: true, item, renamedFiles: changedFiles.length };
});

function findOwnedManifestItemById(itemId = '') {
  const id = String(itemId || '').trim();

  if (!id) return null;

  const cleanId = id.replace(/^folder:/, '').trim();

  const list = Array.isArray(manifests) ? manifests : [];

  const candidates = list
    .filter(isUsableManifest)
    .filter((manifest) => {
      if (typeof canTouchManifest === 'function') return canTouchManifest(manifest);
      return walletOwnsManifest(manifest);
    });

  const found = candidates.find((manifest) => {
    const hash = String(manifest.hash || '').trim();
    const rootHash = String(manifest.rootHash || '').trim();

    const values = [
      manifest.id,
      manifest.fileId,
      manifest.folderId,
      manifest.itemId,
      hash,
      rootHash,
      hash.replace(/^folder:/, ''),
      rootHash.replace(/^folder:/, ''),
      manifest.name,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    return values.includes(id) || values.includes(cleanId);
  });

  if (found) return found;

  // Folder fallback: بعض الفولدرات القديمة بتطلع في الواجهة بس مش محفوظة كـ manifest كامل.
  return {
    kind: 'folder',
    type: 'folder',
    isFolder: true,
    folderId: cleanId,
    id: cleanId,
    hash: `folder:${cleanId}`,
    rootHash: `folder:${cleanId}`,
    ownerWallet: activeWallet(),
    name: '',
    updatedAt: new Date().toISOString(),
  };
}

ipcMain.handle('p2p:deleteItem', async (_event, payload = {}) => {
  assertFolderIdentity();
  await syncPull();
  const item = findOrFallbackManifestItem(payload);
  if (!item) throw new Error(`Item not found. payload=${JSON.stringify(payload)}`);

  if (!manifestItemIsFolder(item)) {
    const removedIds = new Set(manifestItemIds(item));
    const beforeCount = manifests.length;
    manifests = manifests.filter((candidate) => !manifestItemMatchesAnyId(candidate, removedIds));
    persistManifests();
    await syncDelete(manifestDeleteOwnerIdentity(), item.hash || item.rootHash || item.folderId);
    return { ok: true, deleted: beforeCount - manifests.length, movedFiles: 0, deletedFiles: 1, removedIds: Array.from(removedIds) };
  }

  const rootIds = manifestItemIds(item);
  const removedFolderIds = new Set(rootIds);
  const removedFolderNames = new Set([manifestOwnNameLower(item)].filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of walletFolderManifests()) {
      const folderIds = manifestItemIds(folder);
      const parentId = normalizeParentFolderId(folder.parentFolderId);
      const parentIdLower = parentId.toLowerCase();
      if ((parentId && removedFolderIds.has(parentId)) || (parentIdLower && removedFolderNames.has(parentIdLower))) {
        for (const id of folderIds) {
          if (!removedFolderIds.has(id)) { removedFolderIds.add(id); changed = true; }
        }
        const folderName = manifestOwnNameLower(folder);
        if (folderName && !removedFolderNames.has(folderName)) { removedFolderNames.add(folderName); changed = true; }
      }
    }
  }

  const foldersToRemove = [];
  const filesInside = [];
  for (const candidate of walletManifests()) {
    if (manifestItemIsFolder(candidate)) {
      if (manifestItemIds(candidate).some((id) => removedFolderIds.has(id)) || removedFolderNames.has(manifestOwnNameLower(candidate))) foldersToRemove.push(candidate);
      continue;
    }
    const candidateParentId = normalizeParentFolderId(candidate.parentFolderId || candidate.folderId);
    const candidateParentIdLower = candidateParentId.toLowerCase();
    const candidateFolderName = manifestFolderNameLower(candidate);
    if ((candidateParentId && removedFolderIds.has(candidateParentId)) || (candidateFolderName && removedFolderNames.has(candidateFolderName)) || (candidateParentIdLower && removedFolderNames.has(candidateParentIdLower))) {
      filesInside.push(candidate);
    }
  }

  const disposition = String(payload.fileDisposition || 'move').trim().toLowerCase();
  const deleteFiles = disposition === 'delete';
  const targetFolder = deleteFiles ? null : assertValidMoveTarget(item, payload.targetFolderId ?? payload.parentFolderId ?? null);
  if (targetFolder && manifestItemIds(targetFolder).some((id) => removedFolderIds.has(id))) throw new Error('Cannot move files into a folder that is being deleted');

  const removedItems = deleteFiles ? [...foldersToRemove, ...filesInside] : foldersToRemove;
  const removedIds = new Set(removedItems.flatMap((removed) => manifestItemIds(removed)));
  const beforeCount = manifests.length;
  manifests = manifests.filter((candidate) => !manifestItemMatchesAnyId(candidate, removedIds));

  let movedFiles = 0;
  if (!deleteFiles) {
    const targetFolderId = targetFolder ? String(targetFolder.folderId || targetFolder.id || '') : '';
    const targetFolderName = targetFolder?.name || '';
    for (const file of filesInside) {
      file.parentFolderId = targetFolderId;
      file.folderId = targetFolderId;
      file.folderName = targetFolderName;
      file.folder = targetFolderName;
      file.updatedAt = new Date().toISOString();
      movedFiles += 1;
    }
  }

  persistManifests();
  for (const removed of removedItems) await syncDelete(manifestDeleteOwnerIdentity(), removed.hash || removed.rootHash || removed.folderId);
  if (!deleteFiles) for (const file of filesInside) await syncPush(file);

  return {
    ok: true,
    deleted: beforeCount - manifests.length,
    movedFiles,
    deletedFiles: deleteFiles ? filesInside.length : 0,
    removedIds: Array.from(removedIds),
    targetFolderId: targetFolder ? String(targetFolder.folderId || targetFolder.id || '') : '',
  };
});

ipcMain.handle('p2p:uploadFiles', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();

  const picked = await dialog.showOpenDialog({
    title: 'Upload files',
    properties: ['openFile', 'multiSelections'],
  });

  if (picked.canceled || !picked.filePaths?.length) {
    return { ok: true, cancelled: true, files: [] };
  }

  const uploaded = [];

  for (const filePath of picked.filePaths) {
    const buffer = fs.readFileSync(filePath);
    const node = ensureTransport({});
    const originalBuffer = Buffer.from(buffer);

    assertWalletUploadAllowed(originalBuffer.length);

    const ownerWallet = activeWallet();
    const privateFile = Boolean(payload.isEncrypted);
    const drivePassword = privateFile ? drivePasswordFromPayload(payload) : null;
    const secured = privateFile
      ? await encryptPrivateBuffer(originalBuffer, ownerWallet, drivePassword)
      : { ciphertext: originalBuffer, encryption: null };

    const storedBuffer = secured.ciphertext;
    const chunks = splitIntoChunks(storedBuffer);
    const tree = buildMerkleTree(chunks.map((c) => c.hash));
    const storedHash = hashBufferHex(storedBuffer);
    const fileReplicas = new Set([node.peerId]);
    const chunkResults = new Array(chunks.length);
    const uploadConcurrency = clampConcurrency(payload.uploadConcurrency, UPLOAD_CONCURRENCY, 12);

    createProgress('upload', {
      fileName: path.basename(filePath),
      totalBytes: storedBuffer.length,
      totalChunks: chunks.length,
      concurrency: uploadConcurrency,
    });

    try {
      await mapWithConcurrency(chunks, uploadConcurrency, async (chunk) => {
        const chunkPayload = {
          hash: chunk.hash,
          data: chunk.data.toString('base64'),
          index: chunk.index,
          size: chunk.size,
          ownerWallet,
          encrypted: privateFile,
        };

        const replicas = replicateChunk(node, chunkPayload, [node.peerId], TARGET_REPLICAS);

        try {
          await putChunkToSafetyPeer(chunkPayload, node.peerId);
          replicas.push('aws-safety-peer');
        } catch (error) {
          throw new Error(`Safety peer upload failed for chunk ${chunk.hash}: ${error?.message || error}`);
        }

        chunkResults[chunk.index] = {
          index: chunk.index,
          hash: chunk.hash,
          size: chunk.size,
          replicas: unique(replicas),
          proof: getMerkleProof(tree, chunk.index),
        };

        updateProgress('upload', { bytesDelta: chunk.size, chunkDelta: 1 });
      });
    } catch (error) {
      finishProgress('upload', 'error', error?.message || String(error));
      throw error;
    }

    const targetFolderId = String(payload.folderId || '');
    const targetFolder = targetFolderId ? findFolderByAny(targetFolderId) : null;

    if (targetFolderId && !targetFolder) throw new Error(`Target folder not found: ${targetFolderId}`);

    const manifest = {
      id: `${ownerWallet}:${storedHash}`,
      name: path.basename(filePath),
      size: originalBuffer.length,
      storedSize: storedBuffer.length,
      hash: storedHash,
      rootHash: tree.root,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isEncrypted: privateFile,
      visibility: privateFile ? 'private' : 'public',
      isPublic: !privateFile,
      encryption: secured.encryption,
      mimeType: 'application/octet-stream',
      folderId: targetFolder?.folderId || '',
      parentFolderId: targetFolder?.folderId || '',
      folderName: targetFolder?.name || String(payload.folderPath || ''),
      folder: targetFolder?.name || String(payload.folderPath || ''),
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: chunks.length,
      ownerNodeId: node.peerId,
      ownerWallet,
      planId: walletState.planId,
      replicas: [node.peerId],
      chunks: chunkResults,
    };

    for (const chunkMeta of manifest.chunks) {
      for (const peerId of chunkMeta.replicas || []) fileReplicas.add(peerId);
    }

    manifest.replicas = unique(Array.from(fileReplicas));

    manifests = manifests.filter(
      (m) => !(normalizeWallet(m.ownerWallet) === ownerWallet && m.hash === manifest.hash)
    );

    manifests.push(manifest);
    persistManifests();
    persistWallet();

    await syncPush(manifest);
    uploaded.push(manifest);

    finishProgress('upload');
  }

  await syncPull();

  return { ok: true, cancelled: false, files: uploaded, summary: networkSummary(), sync: lastSyncStatus };
});

ipcMain.handle('p2p:downloadToPath', async (_event, payload = {}) => {
  loadWallet();
  loadManifests();
  assertVerifiedWallet();
  await syncPull();

  const node = ensureTransport({});
  const manifest = findManifest(payload);

  if (!manifest) throw new Error('File not found for this wallet');

  const save = await dialog.showSaveDialog({
    title: 'Download file',
    defaultPath: path.join(app.getPath('downloads'), safeOutputName(manifest.name || 'download')),
  });

  if (save.canceled || !save.filePath) {
    return { ok: true, cancelled: true };
  }

  const orderedChunks = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index);
  const downloadConcurrency = clampConcurrency(payload.downloadConcurrency, DOWNLOAD_CONCURRENCY, 16);

  createProgress('download', {
    fileName: manifest.name,
    totalBytes: Number(manifest.storedSize || manifest.size || 0),
    totalChunks: orderedChunks.length,
    concurrency: downloadConcurrency,
  });

  // Helper: fetch one chunk from local cache / network / safety peer
  async function fetchChunk(meta) {
    const local = node.getLocalChunk?.(meta.hash) || node.localChunks?.get(meta.hash);
    if (local) return local;
    try { return await node.fetchChunkFromNetwork(meta.hash); }
    catch (err) {
      console.warn('[p2p:downloadToPath] network fetch failed, trying safety peer:', err?.message || err);
      return getChunkFromSafetyPeer(meta.hash, node.peerId);
    }
  }

  try {
    if (!manifest.isEncrypted) {
      // ── STREAMING PATH (non-encrypted): write each chunk at its disk offset ──
      // Peak RAM = one chunk (~2MB), not the whole file.
      const fd = await fs.promises.open(save.filePath, 'w');
      try {
        await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {
          const chunk = await fetchChunk(meta);
          node.storeLocalChunk?.(chunk);
          const buffer = Buffer.from(chunk.data, 'base64');
          if (hashBufferHex(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`);
          await fd.write(buffer, 0, buffer.length, meta.index * CHUNK_SIZE_BYTES);
          updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
        });
      } finally {
        await fd.close();
      }
    } else {
      // ── BUFFERED PATH (encrypted): AES-GCM needs full ciphertext in memory ──
      const buffers = new Array(orderedChunks.length);
      await mapWithConcurrency(orderedChunks, downloadConcurrency, async (meta) => {
        const chunk = await fetchChunk(meta);
        node.storeLocalChunk?.(chunk);
        const buffer = Buffer.from(chunk.data, 'base64');
        if (hashBufferHex(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`);
        buffers[meta.index] = buffer;
        updateProgress('download', { bytesDelta: buffer.length, chunkDelta: 1 });
      });
      const storedBuffer = Buffer.concat(buffers);
      if (hashBufferHex(storedBuffer) !== manifest.hash) throw new Error('File integrity failed');
      const drivePassword = drivePasswordFromPayload(payload);
      const outputBuffer = await decryptPrivateBuffer(storedBuffer, manifest, drivePassword);
      fs.writeFileSync(save.filePath, outputBuffer);
    }
  } catch (error) {
    finishProgress('download', 'error', error?.message || String(error));
    // Remove incomplete file on error
    try { fs.unlinkSync(save.filePath); } catch { /* ignore */ }
    throw error;
  }

  finishProgress('download');

  return { ok: true, cancelled: false, path: save.filePath, file: manifest, progress: transferProgress.download };
});

ipcMain.handle('p2p:networkSummary', async () => {
  loadWallet();
  loadManifests();

  if (walletState.connected && walletState.verified) {
    await syncPull();
    startAutoRepairLoop();
  }

  return networkSummary();
});


ipcMain.handle('p2p:bootstrapNow', async () => ({ ok: true, summary: networkSummary() }));
ipcMain.handle('p2p:connectPeer', async (_event, payload = {}) => { const peerId = String(payload.peerId || '').trim(); const url = String(payload.url || '').trim(); if (!peerId || !/^wss?:\/\//i.test(url)) throw new Error('peerId and ws:// URL are required'); const result = ensureTransport({}).connectPeer({ peerId, url }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:repair', async () => { assertFolderIdentity(); const node = ensureTransport({}); const own = walletFileManifests(); const result = await repairManifests({ node, manifests: own, configuredTargetReplicas: TARGET_REPLICAS, persistManifests, syncPush }); return { ok: true, ...result, summary: networkSummary() }; });
ipcMain.handle('p2p:prepareProof', async (_event, payload = {}) => { assertVerifiedWallet(); const manifest = findManifest(payload); if (!manifest) throw new Error('File not found for this wallet'); const chunk = manifest.chunks?.[0]; if (!chunk) throw new Error('No chunks available for proof'); return { ok: true, proof: { ownerWallet: activeWallet(), rootHash: manifest.rootHash, chunkIndex: chunk.index, leaf: chunk.hash, merkleProof: chunk.proof, encrypted: Boolean(manifest.isEncrypted), keySource: manifest.encryption?.keySource || null, preparedAt: new Date().toISOString() } }; });

app.whenReady().then(async () => { app.setName(APP_TITLE); ensureDataDir(); loadWallet(); loadManifests(); ensureTransport({}); if (walletState.connected && walletState.verified) { await syncPull(); startAutoRepairLoop(); } createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); }).catch((error) => { console.error('Electron failed:', error); app.exit(1); });
app.on('before-quit', () => { stopAutoRepairLoop(); persistWallet(); persistManifests(); if (transportNode) transportNode.stop(); });
app.on('window-all-closed', () => {});





