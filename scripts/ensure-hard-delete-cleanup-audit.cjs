const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'hard-delete-override.js');
if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);

let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let changed = false;
function mark(message) {
  changed = true;
  console.log(`[ensure-hard-delete-cleanup-audit] ${message}`);
}

if (!src.includes('function replaceTombstone(tombstoneUpdate = {})')) {
  const anchor = `async function removeManifestSync(item) {
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
`;
  const helper = `${anchor}
function replaceTombstone(tombstoneUpdate = {}) {
  if (!tombstoneUpdate?.id) return tombstoneUpdate;
  const current = manifests();
  const next = current.map((candidate) => candidate?.id === tombstoneUpdate.id ? tombstoneUpdate : candidate);
  saveManifests(next);
  return tombstoneUpdate;
}
`;
  if (!src.includes(anchor)) throw new Error('Could not find removeManifestSync helper anchor.');
  src = src.replace(anchor, helper);
  mark('added replaceTombstone helper');
}

if (src.includes('const tombstone = {')) {
  src = src.replace('const tombstone = {', 'let tombstone = {');
  mark('made tombstone mutable so cleanup evidence can be attached');
}

if (!src.includes('safetyCleanup:')) {
  const needle = `    chunkHashes:         hashes,
    originalManifestIds: Array.from(removedIds),
  };`;
  const replacement = `    chunkHashes:         hashes,
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
  };`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone chunkHashes block.');
  src = src.replace(needle, replacement);
  mark('added cleanup evidence fields to tombstone');
}

if (!src.includes('safetyAlreadyMissing:')) {
  src = src.replace(
    `      safetyDeleted:  [],
      safetyErrors:   [],`,
    `      safetyDeleted:  [],
      safetyAlreadyMissing: [],
      safetyErrors:   [],`
  );
  mark('added safetyAlreadyMissing report bucket');
}

if (!src.includes("[tombstone] created")) {
  const needle = `  const after = [...withoutOldTombstone, tombstone];
  saveManifests(after); // ← single write; UI can re-render immediately after this`;
  const replacement = `${needle}
  console.log('[tombstone] created', {
    tombstone: tombstone.id,
    name: item.name,
    fileHash: item.hash,
    rootHash: tombstone.rootHash,
    chunks: hashes.length,
    ownerWallet,
    deletedByPeerId: tombstone.deletedByPeerId,
    removedManifestIds: Array.from(removedIds),
  });`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone creation save block.');
  src = src.replace(needle, replacement);
  mark('added explicit tombstone creation log');
}

if (!src.includes('[hard-delete] AWS safety delete start')) {
  const oldBlock = `      // 4a. AWS safety peer
      try {
        const result = await deleteChunkFromSafetyPeer(hash, n?.peerId || 'desktop-client');
        if (result?.ok) report.safetyDeleted.push(hash);
      } catch (error) {
        report.safetyErrors.push({ hash, error: error?.message || String(error) });
      }`;
  const newBlock = `      // 4a. AWS safety peer
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
      }`;
  if (!src.includes(oldBlock)) throw new Error('Could not find AWS safety delete block.');
  src = src.replace(oldBlock, newBlock);
  mark('added per-chunk AWS safety delete logs');
}

if (!src.includes("[peers-delete] chunk delete sent")) {
  const needle = `        const peerResult = await deleteChunkFromConnectedPeers(hash, ownerWallet);
        report.peerDeleteSent.push(...peerResult.sent.map((peerId) => ({ hash, peerId })));
        report.peerErrors.push(...peerResult.failed.map((entry)  => ({ hash, ...entry })));`;
  const replacement = `${needle}
        console.log('[peers-delete] chunk delete sent', {
          tombstone: tombstone.id,
          chunkHash: hash,
          sent: peerResult.sent,
          failed: peerResult.failed,
        });`;
  if (!src.includes(needle)) throw new Error('Could not find connected peers delete result block.');
  src = src.replace(needle, replacement);
  mark('added explicit connected peers delete log');
}

if (!src.includes('tombstone = replaceTombstone({')) {
  const oldBlock = `    // 4d. Push tombstone online so offline devices receive delete command later
    try {
      report.tombstoneSync = await pushWalletManifest(tombstone);
    } catch (error) {
      report.tombstoneSync = { ok: false, error: error?.message || String(error) };
      console.warn('[hard-delete] tombstone sync failed:', error?.message || error);
    }`;
  const newBlock = `    tombstone = replaceTombstone({
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
    }`;
  if (!src.includes(oldBlock)) throw new Error('Could not find tombstone sync block.');
  src = src.replace(oldBlock, newBlock);
  mark('persisted cleanup result back into tombstone before sync');
}

if (!src.includes("[tombstone] cleanup updated")) {
  const needle = `    tombstone = replaceTombstone({
      ...tombstone,`;
  const replacement = `    console.log('[tombstone] cleanup update start', {
      tombstone: tombstone.id,
      safetyDeleted: report.safetyDeleted.length,
      safetyAlreadyMissing: report.safetyAlreadyMissing.length,
      safetyErrors: report.safetyErrors.length,
      peerDeleteSent: report.peerDeleteSent.length,
      peerErrors: report.peerErrors.length,
      remoteManifestCleanup: report.syncDelete,
    });

${needle}`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone replace block.');
  src = src.replace(needle, replacement);
  mark('added tombstone cleanup update start log');
}

if (!src.includes("[tombstone] cleanup updated")) {
  const needle = `      remoteManifestCleanup: report.syncDelete,
    });`;
  const replacement = `${needle}
    console.log('[tombstone] cleanup updated', {
      tombstone: tombstone.id,
      safetyCleanup: tombstone.safetyCleanup,
      peerCleanup: tombstone.peerCleanup,
      remoteManifestCleanup: tombstone.remoteManifestCleanup,
    });`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone cleanup update end block.');
  src = src.replace(needle, replacement);
  mark('added tombstone cleanup updated log');
}

if (!src.includes("[tombstone] sync pushed")) {
  const needle = `    try {
      report.tombstoneSync = await pushWalletManifest(tombstone);
    } catch (error) {`;
  const replacement = `    try {
      report.tombstoneSync = await pushWalletManifest(tombstone);
      console.log('[tombstone] sync pushed', {
        tombstone: tombstone.id,
        ok: Boolean(report.tombstoneSync?.ok ?? true),
        result: report.tombstoneSync,
      });
    } catch (error) {`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone push block.');
  src = src.replace(needle, replacement);
  mark('added tombstone sync pushed log');
}

if (!src.includes("[tombstone] sync failed")) {
  const needle = `      report.tombstoneSync = { ok: false, error: error?.message || String(error) };
      console.warn('[hard-delete] tombstone sync failed:', error?.message || error);`;
  const replacement = `      report.tombstoneSync = { ok: false, error: error?.message || String(error) };
      console.warn('[hard-delete] tombstone sync failed:', error?.message || error);
      console.warn('[tombstone] sync failed', { tombstone: tombstone.id, error: report.tombstoneSync.error });`;
  if (!src.includes(needle)) throw new Error('Could not find tombstone sync failed block.');
  src = src.replace(needle, replacement);
  mark('added tombstone sync failed log');
}

if (!src.includes('safetyAlreadyMissing: report.safetyAlreadyMissing.length')) {
  src = src.replace(
    `      safetyDeleted:  report.safetyDeleted.length,
      safetyErrors:   report.safetyErrors.length,`,
    `      safetyDeleted:  report.safetyDeleted.length,
      safetyAlreadyMissing: report.safetyAlreadyMissing.length,
      safetyErrors:   report.safetyErrors.length,`
  );
  mark('included already-missing count in cleanup summary log');
}

if (!src.includes("[aws-delete] cleanup summary")) {
  const needle = `    console.log('[hard-delete] background cleanup finished', {`;
  const replacement = `    console.log('[aws-delete] cleanup summary', {
      tombstone: tombstone.id,
      fileHash: item.hash,
      chunks: hashes.length,
      deleted: report.safetyDeleted.length,
      alreadyMissing: report.safetyAlreadyMissing.length,
      errors: report.safetyErrors.length,
      deletedHashes: report.safetyDeleted,
      alreadyMissingHashes: report.safetyAlreadyMissing,
      errorDetails: report.safetyErrors,
    });

${needle}`;
  if (!src.includes(needle)) throw new Error('Could not find background cleanup summary log.');
  src = src.replace(needle, replacement);
  mark('added AWS cleanup summary log');
}

if (changed) fs.writeFileSync(file, src, 'utf8');
console.log('[ensure-hard-delete-cleanup-audit] ok');
