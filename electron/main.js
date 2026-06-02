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
const TARGET_REPLICAS = Math.max(4, Number(process.env.P2P_TARGET_REPLICAS || 4));
const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, Number(process.env.P2P_AUTO_REPAIR_INTERVAL_MS || 60_000));
const UPLOAD_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.P2P_UPLOAD_CONCURRENCY || 4)));
const DOWNLOAD_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.P2P_DOWNLOAD_CONCURRENCY || 6)));
const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
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
    walletState = {
      ...walletState,
      ...parsed,
      connected: Boolean(parsed.connected),
      verified: Boolean(parsed.verified),
      address: normalizeWallet(parsed.address),
      accountId: normalizeWallet(parsed.accountId || parsed.address),
      planId: PLANS[parsed.planId] ? parsed.planId : 'free',
      authMode: parsed.authMode || (parsed.username ? 'seed' : parsed.address ? 'wallet' : null),
      username: parsed.username || null,
      seedFingerprint: parsed.seedFingerprint || null,
      encryptionKeySource: parsed.encryptionKeySource || ENCRYPTION_KEY_SOURCE,
    };
  } catch {
    persistWallet();
  }
}

function persistWallet() {
  ensureDataDir();
  fs.writeFileSync(walletPath, JSON.stringify(walletState, null, 2), 'utf8');
}

function currentPlan() { return PLANS[walletState.planId] || PLANS.free; }
function usedBytes(allManifests = manifests, wallet = activeWallet()) { return allManifests.filter((m) => m.ownerWallet === wallet && isUsableManifest(m)).reduce((sum, m) => sum + Number(m.size || 0), 0); }
function remainingBytes() { return Math.max(0, currentPlan().quotaBytes - usedBytes()); }
function quotaBytes(planId = walletState.planId) { return (PLANS[planId] || PLANS.free).quotaBytes; }
