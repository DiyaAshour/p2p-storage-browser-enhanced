/**
 * electron/core/config.js — Single source of truth for Electron runtime constants.
 *
 * Node/Electron modules should import runtime constants from here instead of
 * redefining CHUNK_SIZE_BYTES, encryption settings, quotas, or replica targets.
 */

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ─── App ──────────────────────────────────────────────────────────────────────

export const APP_TITLE = 'Chunknet';

// ─── Storage plans ────────────────────────────────────────────────────────────

export const FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

export const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};

export function quotaBytes(planId = 'free') {
  return PLANS[planId]?.quotaBytes ?? FREE_QUOTA_BYTES;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

export const DEFAULT_CHUNK_SIZE_BYTES = envNumber('P2P_CHUNK_SIZE_BYTES', 2 * 1024 * 1024);
export const CHUNK_SIZE_BYTES = DEFAULT_CHUNK_SIZE_BYTES;

export const ADAPTIVE_CHUNKING_ENABLED = String(process.env.P2P_ADAPTIVE_CHUNKING ?? 'true').toLowerCase() !== 'false';
export const CHUNK_SIZE_SMALL_BYTES = envNumber('P2P_CHUNK_SIZE_SMALL_BYTES', 2 * 1024 * 1024);
export const CHUNK_SIZE_MEDIUM_BYTES = envNumber('P2P_CHUNK_SIZE_MEDIUM_BYTES', 8 * 1024 * 1024);
export const CHUNK_SIZE_LARGE_BYTES = envNumber('P2P_CHUNK_SIZE_LARGE_BYTES', 16 * 1024 * 1024);
export const CHUNK_SIZE_HUGE_BYTES = envNumber('P2P_CHUNK_SIZE_HUGE_BYTES', 16 * 1024 * 1024);
export const CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES = envNumber('P2P_CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES', 100 * 1024 * 1024);
export const CHUNK_SIZE_LARGE_THRESHOLD_BYTES = envNumber('P2P_CHUNK_SIZE_LARGE_THRESHOLD_BYTES', 5 * 1024 ** 3);
export const CHUNK_SIZE_HUGE_THRESHOLD_BYTES = envNumber('P2P_CHUNK_SIZE_HUGE_THRESHOLD_BYTES', 50 * 1024 ** 3);

export function chunkSizeForFile(fileSizeBytes = 0) {
  if (!ADAPTIVE_CHUNKING_ENABLED) return DEFAULT_CHUNK_SIZE_BYTES;
  const size = Number(fileSizeBytes);
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_CHUNK_SIZE_BYTES;
  if (size >= CHUNK_SIZE_HUGE_THRESHOLD_BYTES) return CHUNK_SIZE_HUGE_BYTES;
  if (size >= CHUNK_SIZE_LARGE_THRESHOLD_BYTES) return CHUNK_SIZE_LARGE_BYTES;
  if (size >= CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES) return CHUNK_SIZE_MEDIUM_BYTES;
  return CHUNK_SIZE_SMALL_BYTES;
}

// ─── Replication ──────────────────────────────────────────────────────────────

// Enterprise protection target: 4 P2P replicas. Safety peer remains emergency protection only.
export const TARGET_REPLICAS = Math.max(4, envNumber('P2P_TARGET_REPLICAS', 4));

// ─── Encryption ───────────────────────────────────────────────────────────────

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_SOURCE = 'wallet-password-v1';
export const KDF_ALGORITHM = 'pbkdf2-sha256';
export const KDF_ITERATIONS = envNumber('P2P_KDF_ITERATIONS', 310_000);
export const MIN_DRIVE_PASSWORD_LENGTH = envNumber('P2P_MIN_DRIVE_PASSWORD_LENGTH', 12);

// ─── Transfer concurrency ─────────────────────────────────────────────────────

export const UPLOAD_CONCURRENCY = clamp(envNumber('P2P_UPLOAD_CONCURRENCY', 4), 1, 12);
export const DOWNLOAD_CONCURRENCY = clamp(envNumber('P2P_DOWNLOAD_CONCURRENCY', 6), 1, 16);

// ─── Repair / protection loops ────────────────────────────────────────────────

export const AUTO_REPAIR_INTERVAL_MS = Math.max(30_000, envNumber('P2P_AUTO_REPAIR_INTERVAL_MS', 3 * 60 * 60 * 1000));
export const AUTO_REPAIR_START_DELAY_MS = envNumber('P2P_AUTO_REPAIR_START_DELAY_MS', 5 * 60 * 1000);
export const PROTECTION_RETRY_INTERVAL_MS = envNumber('P2P_PROTECTION_RETRY_INTERVAL_MS', 5 * 60 * 1000);
export const PROTECTION_RETRY_START_DELAY_MS = envNumber('P2P_PROTECTION_RETRY_START_DELAY_MS', 45 * 1000);

// ─── Wallet auth ──────────────────────────────────────────────────────────────

export const WALLET_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
export const WALLET_LOGIN_MAX_FUTURE_MS = 2 * 60 * 1000;

// ─── Manifest kinds ───────────────────────────────────────────────────────────

export const FOLDER_MANIFEST_KIND = 'folder';
export const UI_PREFS_MANIFEST_KIND = 'ui:prefs';
