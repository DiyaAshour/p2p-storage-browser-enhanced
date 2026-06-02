import { ipcMain } from 'electron';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { deleteWalletManifest, pushWalletManifest } from './manifest-sync.js';
import { deleteChunkFromSafetyPeer } from './safety-peer.js';
import { activeIdentity, assertVerifiedIdentity, normalizeIdentity } from './core/identity.js';
import { chunkPath } from './core/storage-paths.js';
import { readWallet, readManifests, writeManifests } from './core/storage-json.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function wallet()               { return readWallet(); }
function identity(w = wallet()) { return activeIdentity(w); }
function manifests()            { return readManifests(); }
function saveManifests(v)       { writeManifests(v); }
function node()                 { return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null; }
function unique(values = [])    { return Array.from(new Set(values.filter(Boolean))); }

function comparableIds(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const noFolderPrefix = raw.replace(/^folder:/i, '').trim();
  const noHexPrefix = noFolderPrefix.replace(/^0x/i, '').trim();
  const lower = noFolderPrefix.toLowerCase();
  const lowerNoHex = noHexPrefix.toLowerCase();
  const parts = raw.split(':').map((part) => part.trim()).filter(Boolean);

  return unique([
    raw,
    noFolderPrefix,
    noHexPrefix,
    lower,
    lowerNoHex,
    ...parts,
    ...parts.map((part) => part.replace(/^folder:/i, '').replace(/^0x/i, '').trim()),
    ...parts.map((part) => part.toLowerCase()),
  ]);
}

function expandIds(values = []) {
  return unique(values.flatMap((value) => comparableIds(value)));
}

function isFolderManifest(item = {}) {
  return (
    item.kind === 'folder' ||
    item.type === 'folder' ||
    item.isFolder === true ||
    String(item.hash || '').startsWith('folder:')
  );
}

function manifestIds(item = {}) {
  const hash     = String(item.hash     || '').trim();
  const rootHash = String(item.rootHash || '').trim();
  return expandIds([
    item.id,
    item.itemId,
    item.fileId,
    item.folderId,
    item.cid,
    item.root,
    hash,
    rootHash,
    hash.replace(/^folder:/, ''),
    rootHash.replace(/^folder:/, ''),
    item.name,
  ]);
}

function payloadIds(payload = {}) {
  return expandIds([
    payload.itemId,
    payload.id,
    payload.fileId,
    payload.folderId,
    payload.cid,
    payload.root,
    payload.hash,
    payload.rootHash,
    payload.name,
  ]);
}

function matchesAnyId(item = {}, ids = []) {
  const wanted = new Set(expandIds(ids));
  return manifestIds(item).some((id) => wanted.has(id));
}

function walletOwns(item = {}, owner = identity()) {
  const itemOwner = normalizeIdentity(item.ownerWallet || item.owner || item.wallet || '');
  return !itemOwner || itemOwner === owner;
}

function isDeleteTombstone(item = {}) {
  return (
    item.type    === 'delete-tombstone-v1' ||
    item.kind    === 'delete-tombstone'    ||
    item.isTombstone === true              ||
    String(item.id || '').startsWith('tombstone:')
  );
}

function findItem(payload = {}) {
  const owner = identity();
  const ids = payloadIds(payload);
  const live = manifests().filter((m) => !isDeleteTombstone(m));

  const ownedMatch = live
    .filter((m) => walletOwns(m, owner))
    .find((m) => matchesAnyId(m, ids));

  if (ownedMatch) return ownedMatch;

  // Safety fallback for UI-visible legacy records whose owner field is missing or
  // whose identifier is packed as wallet:hash / wallet:rootHash.
  const anyMatch = live.find((m) => matchesAnyId(m, ids));
  if (anyMatch && walletOwns(anyMatch, owner)) return anyMatch;

  return null;
}

function chunkHashesOf(item = {}) {
  return unique(
    (item.chunks || [])
      .map((c) => String(c?.hash || '').trim().toLowerCase())
      .filter((h) => /^[a-f0-9]{64}$/.test(h))
  );
}

function deleteDiagnostics(payload = {}) {
  const owner = identity();
  const ids = payloadIds(payload);
  const all = manifests();
  const live = all.filter((m) => !isDeleteTombstone(m));
  const matchingLive = live.filter((m) => matchesAnyId(m, ids));
  const matchingTombstones = all.filter((m) => isDeleteTombstone(m) && matchesAnyId(m, ids));

  return {
    owner,
    payloadIds: ids,
    totalManifests: all.length,
    liveManifests: live.length,
    matchingLive: matchingLive.length,
    matchingOwnedLive: matchingLive.filter((m) => walletOwns(m, owner)).length,
    matchingTombstones: matchingTombstones.length,
    firstLiveOwner: matchingLive[0]?.ownerWallet || matchingLive[0]?.owner || matchingLive[0]?.wallet || null,
  };
}

// ─── Low-level chunk deletion ────────────────────────────────────────────────

function deleteLocalChunk(hash) {
  const n = node();
  try { n?.localChunks?.delete?.(hash);   } catch {}
  try { n?.chunkReplicas?.delete?.(hash); } catch {}
  const file = chunkPath(hash);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

async function deleteChunkFromConnectedPeers(hash, ownerWallet) {
  const n     = node();
  const peers = n?.connectedPeerIds?.() || [];
  const sent  = [];
  const failed = [];

  for (const peerId of peers) {
    const socket = n?.peerSockets?.get?.(peerId);
    if (!socket) continue;
    const ok = n.send?.(socket, {
      id:         crypto.randomUUID(),
      type:       'chunk:delete',
      fromPeerId: n.peerId,
      toPeerId:   peerId,
      createdAt:  Date.now(),
      payload:    { chunkHash: hash, ownerWallet, reason: 'owner-hard-delete' },
    });
    if (ok) sent.push(peerId);
    else    failed.push({ peerId, error: 'send-failed' });
  }

  return { sent, failed };
}

async function removeManifestSync(item) {
  const ownerWallet = identity();
  const hash        = item.hash || item.rootHash || item.folderId;
  try {
    await deleteWalletManifest(ownerWallet, hash);
    return { ok: true };
  } catch (error) {
    console.warn('[hard-delete] manifest sync delete failed:', error?.message || error);
    return { ok: false, error: error?.message || String(error) };
  }
}

function replaceTombstone(tombstoneUpdate = {}) {
  if (!tombstoneUpdate?.id) return tombstoneUpdate;
  const current = manifests();
  const next = current.map((candidate) => candidate?.id === tombstoneUpdate.id ? tombstoneUpdate : candidate);
  saveManifests(next);
  return tombstoneUpdate;
}

// ─── Main: Local-first hard delete + Tombstone propagation ──────────────────
//
// Flow:
//   1. Remove file manifest locally → UI refreshes immediately (no waiting)
//   2. Save tombstone locally       → prevents file from coming back via sync
//   3. Delete local chunks immediately
//   4. Background cleanup (setTimeout 0):
//        a. Delete chunks from AWS safety peer
//        b. Send chunk:delete to all connected peers
//        c. Remove remote manifest via manifest-sync
//
// Offline peers: when they come back online, syncPull / bootstrap / peer-hello
// will encounter the tombstone and must delete any matching chunks they hold.
// (Wire that logic in manifest-sync.js → syncPull once this file is stable.)

async function hardDeleteItem(payload = {}) {
  const w = wallet();
  assertVerifiedIdentity(w);

  const item = findItem(payload);
  if (!item) {
    const diagnostics = deleteDiagnostics(payload);
    console.log('[hard-delete] item not found in live manifests; treating delete as already applied', diagnostics);
    return {
      ok: true,
      hardDelete: true,
      deleteMode: 'idempotent-already-deleted-or-stale-ui',
      alreadyDeleted: true,
      deleted: 0,
      deletedFiles: 0,
      movedFiles: 0,
      removedIds: diagnostics.payloadIds,
      diagnostics,
      tombstone: null,
      chunkHashes: [],
      localDeleted: [],
      peerErrors: [],
      remoteCleanupScheduled: false,
    };
  }

  if (isFolderManifest(item)) {
    throw new Error('Hard delete override handles files only. Delete folders through folder delete flow.');
  }

  const ownerWallet = identity(w);
  const n           = node();
  const hashes      = chunkHashesOf(item);
  const removedIds  = new Set(manifestIds(item));

  // ── Build tombstone ────────────────────────────────────────────────────────
  let tombstone = {
    type:                'delete-tombstone-v1',
    id:                  `tombstone:${item.hash || item.rootHash || crypto.randomUUID()}`,
    hash:                item.hash     || '',
    rootHash:            item.rootHash || item.hash || '',
    name:                item.name     || 'file',
    ownerWallet,
    deletedAt:           new Date().toISOString(),
    deletedByPeerId:     n?.peerId || 'desktop-client',
    reason:              'owner-hard-delete',
    chunkHashes:         hashes,
    originalManifestIds: Array.from(removedIds),
    safetyCleanup: {
      status: 'pending',
      replicaId: 'aws-safety-peer',
      deleted: [],
      alreadyMissing: [],
      errors: [],
      updatedAt: null,
    },
    peerCleanup: {
      status: 'pending',
      sent: [],
      errors: [],
      updatedAt: null,
    },
  };

  // ── Step 1: Remove file manifest → UI updates instantly ───────────────────
  const before             = manifests();
  const afterWithoutFile   = before.filter((candidate) => !matchesAnyId(candidate, Array.from(removedIds)));

  // ── Step 2: Replace any stale tombstone for same file, then add new one ───
  const withoutOldTombstone = afterWithoutFile.filter((candidate) => {
    if (candidate?.type !== 'delete-tombstone-v1') return true;
    return !(
      candidate.hash     === tombstone.hash     ||
      candidate.rootHash === tombstone.rootHash ||
      candidate.id       === tombstone.id
    );
  });

  const after = [...withoutOldTombstone, tombstone];
  saveManifests(after); // ← single write; UI can re-render immediately after this

  // ── Step 3: Delete local chunks (fast, synchronous) ───────────────────────
  const localDeleted = [];
  const localErrors  = [];

  for (const hash of hashes) {
    try {
      deleteLocalChunk(hash);
      localDeleted.push(hash);
    } catch (error) {
      localErrors.push({ hash, phase: 'local', error: error?.message || String(error) });
    }
  }

  // ── Step 4: Background cleanup — never blocks the user ────────────────────
  setTimeout(async () => {
    const report = {
      safetyDeleted:  [],
      safetyAlreadyMissing: [],
      safetyErrors:   [],
      peerDeleteSent: [],
      peerErrors:     [],
      syncDelete:     null,
      tombstoneSync:  null,
    };

    for (const hash of hashes) {
      // 4a. AWS safety peer
      try {
        console.log('[hard-delete] AWS safety delete start', {
          name: item.name,
          fileHash: item.hash,
          chunkHash: hash,
          tombstone: tombstone.id,
        });
        const result = await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client');
        if (result?.ok) {
          if (result.alreadyMissing) report.safetyAlreadyMissing.push(hash);
          else report.safetyDeleted.push(hash);
          console.log('[hard-delete] AWS safety delete confirmed', {
            name: item.name,
            fileHash: item.hash,
            chunkHash: hash,
            tombstone: tombstone.id,
            alreadyMissing: Boolean(result.alreadyMissing),
          });
        }
      } catch (error) {
        const entry = { hash, error: error?.message || String(error) };
        report.safetyErrors.push(entry);
        console.warn('[hard-delete] AWS safety delete failed', {
          name: item.name,
          fileHash: item.hash,
          chunkHash: hash,
          tombstone: tombstone.id,
          error: entry.error,
        });
      }

      // 4b. Connected peers
      try {
        const peerResult = await deleteChunkFromConnectedPeers(hash, ownerWallet);
        report.peerDeleteSent.push(...peerResult.sent.map((peerId) => ({ hash, peerId })));
        report.peerErrors.push(...peerResult.failed.map((entry)  => ({ hash, ...entry })));
      } catch (error) {
        report.peerErrors.push({ hash, phase: 'peers', error: error?.message || String(error) });
      }
    }

    // 4c. Remove old file manifest from remote sync
    try {
      report.syncDelete = await removeManifestSync(item);
    } catch (error) {
      report.syncDelete = { ok: false, error: error?.message || String(error) };
    }

    tombstone = replaceTombstone({
      ...tombstone,
      cleanupCompletedAt: new Date().toISOString(),
      safetyCleanup: {
        status: report.safetyErrors.length ? 'completed-with-errors' : 'completed',
        replicaId: 'aws-safety-peer',
        deleted: report.safetyDeleted,
        alreadyMissing: report.safetyAlreadyMissing,
        errors: report.safetyErrors,
        updatedAt: new Date().toISOString(),
      },
      peerCleanup: {
        status: report.peerErrors.length ? 'completed-with-errors' : 'completed',
        sent: report.peerDeleteSent,
        errors: report.peerErrors,
        updatedAt: new Date().toISOString(),
      },
      remoteManifestCleanup: report.syncDelete,
    });

    // 4d. Push tombstone online so offline devices receive delete command later
    try {
      report.tombstoneSync = await pushWalletManifest(tombstone);
    } catch (error) {
      report.tombstoneSync = { ok: false, error: error?.message || String(error) };
      console.warn('[hard-delete] tombstone sync failed:', error?.message || error);
    }

    console.log('[hard-delete] background cleanup finished', {
      name:           item.name,
      hash:           item.hash,
      chunks:         hashes.length,
      safetyDeleted:  report.safetyDeleted.length,
      safetyAlreadyMissing: report.safetyAlreadyMissing.length,
      safetyErrors:   report.safetyErrors.length,
      peerDeleteSent: report.peerDeleteSent.length,
      syncDelete:     report.syncDelete,
      tombstoneSync:  report.tombstoneSync,
    });
  }, 0);

  console.log('[hard-delete] local-first delete completed; tombstone created', {
    name:             item.name,
    hash:             item.hash,
    chunks:           hashes.length,
    localDeleted:     localDeleted.length,
    removedManifests: before.length - afterWithoutFile.length,
    tombstone:        tombstone.id,
  });

  return {
    ok:                      true,
    hardDelete:              true,
    deleteMode:              'local-first-tombstone-background-cleanup',
    deleted:                 before.length - afterWithoutFile.length,
    deletedFiles:            1,
    movedFiles:              0,
    removedIds:              Array.from(removedIds),
    tombstone,
    chunkHashes:             hashes,
    localDeleted,
    peerErrors:              localErrors,
    remoteCleanupScheduled:  true,
  };
}

// ─── IPC registration ────────────────────────────────────────────────────────
//
// p2p:delete     → file hard delete (this file)
// p2p:deleteItem → folder delete flow in main.js — DO NOT override here

try { ipcMain.removeHandler('p2p:delete'); } catch {}
ipcMain.handle('p2p:delete', async (_event, payload = {}) => hardDeleteItem(payload));

console.log('[hard-delete] installed file hard delete override for p2p:delete only');
