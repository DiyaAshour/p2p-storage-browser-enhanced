import { app, ipcMain, protocol, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getChunkFromSafetyPeer } from './safety-peer.js';
import { ENCRYPTION_ALGORITHM, KDF_ITERATIONS, MIN_DRIVE_PASSWORD_LENGTH } from './core/config.js';
import { activeIdentity, normalizeIdentity } from './core/identity.js';
import { walletPath } from './core/storage-paths.js';
import { readChunkBuffer as readStoredChunkBuffer } from './core/chunk-store.js';
import { readJson, readManifests } from './core/storage-json.js';

const PREVIEW_SCHEME = 'chunknet-preview';
const previewFiles = new Map();
let protocolReady = false;

try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
} catch {
  // The scheme may already be registered when Electron reloads in dev.
}

function currentIdentity() {
  return activeIdentity(readJson(walletPath(), {}));
}

function p2pNode() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeName(name = 'preview') {
  return String(name || 'preview').replace(/[\\/:*?"<>|]/g, '_');
}

function isImageManifest(manifest = {}) {
  const mime = String(manifest.mimeType || '').toLowerCase();
  const name = String(manifest.name || '').toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);
}

function mimeFor(manifest = {}) {
  const explicit = String(manifest.mimeType || '').toLowerCase();
  if (explicit.startsWith('image/')) return explicit;
  const name = String(manifest.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.avif')) return 'image/avif';
  return 'application/octet-stream';
}

function validateDrivePassword(drivePassword) {
  const password = String(drivePassword || '').trim();
  if (password.length < MIN_DRIVE_PASSWORD_LENGTH) {
    throw new Error(`Drive Password required. Use at least ${MIN_DRIVE_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

function pbkdf2Async(password, saltBuffer, iterations, keylen, digest) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, saltBuffer, iterations, keylen, digest, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function deriveDriveKey({ ownerWallet, drivePassword, salt }) {
  const identity = normalizeIdentity(ownerWallet);
  const password = validateDrivePassword(drivePassword);
  const saltBuffer = Buffer.from(String(salt || ''), 'base64');
  return pbkdf2Async(`${identity}:${password}`, saltBuffer, KDF_ITERATIONS, 32, 'sha256');
}

function findManifest(payload = {}) {
  const identity = currentIdentity();
  const hash = String(payload.hash || '');
  const rootHash = String(payload.rootHash || '');
  return readManifests().find((manifest) =>
    normalizeIdentity(manifest.ownerWallet) === identity &&
    (manifest.hash === hash || manifest.rootHash === rootHash)
  ) || null;
}

function dropMemoryChunk(hash) {
  try { p2pNode()?.localChunks?.delete?.(hash); } catch {}
}

function readLocalChunkBuffer(hash) {
  return readStoredChunkBuffer(hash);
}

async function readNetworkChunk(hash) {
  const node = p2pNode();
  if (!node?.fetchChunkFromNetwork) return null;
  const chunk = await node.fetchChunkFromNetwork(hash);
  try { node.storeLocalChunk?.(chunk); } catch {}
  dropMemoryChunk(hash);
  return chunk?.data ? Buffer.from(chunk.data, 'base64') : null;
}

async function readChunkBuffer(hash, peerId = 'desktop-client') {
  const local = readLocalChunkBuffer(hash);
  if (local) return local;

  try {
    const network = await readNetworkChunk(hash);
    if (network) return network;
  } catch (error) {
    console.warn('[image-preview] network fetch failed, trying safety peer:', error?.message || error);
  }

  const remote = await getChunkFromSafetyPeer(hash, peerId);
  if (!remote?.data) throw new Error(`Missing chunk: ${hash}`);
  dropMemoryChunk(hash);
  return Buffer.from(remote.data, 'base64');
}

async function writeChunksToTemp(manifest, tempPath) {
  const ordered = [...(manifest.chunks || [])].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  if (!ordered.length) throw new Error('File manifest has no chunks');
  await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
  const out = fs.createWriteStream(tempPath);

  try {
    for (const meta of ordered) {
      const buffer = await readChunkBuffer(meta.hash, manifest.ownerNodeId || 'desktop-client');
      if (sha256(buffer) !== meta.hash) throw new Error(`Chunk integrity failed: ${meta.hash}`);
      await new Promise((resolve, reject) => out.write(buffer, (error) => (error ? reject(error) : resolve())));
      dropMemoryChunk(meta.hash);
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    try { out.destroy(); } catch {}
    throw error;
  }
}

async function decryptTempToFile(tempPath, finalPath, manifest, drivePassword) {
  const enc = manifest.encryption || {};
  if (enc.algorithm !== ENCRYPTION_ALGORITHM || !enc.salt || !enc.iv || !enc.authTag) {
    throw new Error('Encrypted file metadata is missing or unsupported');
  }

  const key = await deriveDriveKey({ ownerWallet: manifest.ownerWallet, drivePassword, salt: enc.salt });
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  await pipeline(fs.createReadStream(tempPath), decipher, fs.createWriteStream(finalPath));
}

function tempPreviewPath(tempId, name) {
  return path.join(app.getPath('temp'), 'chunknet-previews', `${tempId}-${safeName(name || 'preview')}`);
}

function thumbnailDir() {
  return path.join(app.getPath('userData'), 'native-p2p-storage', 'thumbnails');
}

function thumbnailPathFor(manifest = {}) {
  const id = String(manifest.rootHash || manifest.hash || sha256(Buffer.from(String(manifest.name || 'image'))));
  return path.join(thumbnailDir(), `${id}.png`);
}

function rememberFile({ id, filePath, mime, name, createdAt = Date.now(), persistent = false, cipherPath = null }) {
  previewFiles.set(id, {
    path: filePath,
    cipherPath,
    mime,
    name,
    createdAt,
    persistent,
  });
}

function urlFor(id, name = 'preview') {
  return `${PREVIEW_SCHEME}://${encodeURIComponent(id)}/${encodeURIComponent(safeName(name || 'preview'))}`;
}

function cleanupPreview(tempId) {
  const item = previewFiles.get(String(tempId || ''));
  previewFiles.delete(String(tempId || ''));
  if (!item?.persistent && item?.path) {
    try { fs.unlinkSync(item.path); } catch {}
  }
  if (item?.cipherPath) {
    try { fs.unlinkSync(item.cipherPath); } catch {}
  }
}

function cleanupOldPreviews(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [tempId, item] of previewFiles.entries()) {
    if (!item?.persistent && now - Number(item.createdAt || 0) > maxAgeMs) cleanupPreview(tempId);
  }
}

async function ensurePreviewProtocol() {
  if (protocolReady) return;
  await app.whenReady();

  try {
    protocol.handle(PREVIEW_SCHEME, async (request) => {
      const url = new URL(request.url);
      const tempId = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, '') || '');
      const item = previewFiles.get(tempId);

      if (!item || !item.path || !fs.existsSync(item.path)) {
        return new Response('Preview not found', { status: 404 });
      }

      return new Response(Readable.toWeb(fs.createReadStream(item.path)), {
        headers: {
          'content-type': item.mime || 'application/octet-stream',
          'cache-control': item.persistent ? 'private, max-age=86400' : 'no-store',
        },
      });
    });
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes('already')) throw error;
  }

  protocolReady = true;
}

async function materializeImageToTemp(manifest, drivePassword) {
  const tempId = crypto.randomUUID();
  const finalPath = tempPreviewPath(tempId, manifest.name || 'preview');
  const cipherPath = `${finalPath}.cipher`;

  try {
    await writeChunksToTemp(manifest, manifest.isEncrypted ? cipherPath : finalPath);

    if (manifest.isEncrypted) {
      await decryptTempToFile(cipherPath, finalPath, manifest, drivePassword);
      try { fs.unlinkSync(cipherPath); } catch {}
    }

    return { tempId, finalPath, cipherPath: null };
  } catch (error) {
    try { fs.unlinkSync(finalPath); } catch {}
    try { fs.unlinkSync(cipherPath); } catch {}
    throw error;
  }
}

async function createImagePreview(payload = {}) {
  await ensurePreviewProtocol();
  cleanupOldPreviews();

  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this identity');
  if (!isImageManifest(manifest)) throw new Error('Preview is available only for image files');

  const { tempId, finalPath } = await materializeImageToTemp(manifest, payload.drivePassword);
  const mime = mimeFor(manifest);
  rememberFile({ id: tempId, filePath: finalPath, mime, name: manifest.name || 'preview' });

  return {
    ok: true,
    tempId,
    previewUrl: urlFor(tempId, manifest.name || 'preview'),
    file: { ...manifest, mimeType: mime },
  };
}

async function createImageThumbnail(payload = {}) {
  await ensurePreviewProtocol();
  cleanupOldPreviews();

  const manifest = findManifest(payload);
  if (!manifest) throw new Error('File not found for this identity');
  if (!isImageManifest(manifest)) return { ok: false, skipped: true, reason: 'not-image' };

  const outputPath = thumbnailPathFor(manifest);
  const thumbId = `thumb-${String(manifest.rootHash || manifest.hash || crypto.randomUUID())}`;

  if (fs.existsSync(outputPath)) {
    rememberFile({ id: thumbId, filePath: outputPath, mime: 'image/png', name: manifest.name || 'thumbnail', persistent: true });
    return { ok: true, thumbnailUrl: urlFor(thumbId, 'thumbnail.png'), tempId: thumbId, cached: true };
  }

  const { tempId, finalPath } = await materializeImageToTemp(manifest, payload.drivePassword);

  try {
    const image = nativeImage.createFromPath(finalPath);
    if (image.isEmpty()) throw new Error('Electron could not decode this image for thumbnail');

    const size = image.getSize();
    const maxSize = Math.max(64, Math.min(512, Number(payload.maxSize || 256)));
    const scale = Math.min(maxSize / Math.max(1, size.width), maxSize / Math.max(1, size.height), 1);
    const thumbnail = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best',
    });

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, thumbnail.toPNG());
    rememberFile({ id: thumbId, filePath: outputPath, mime: 'image/png', name: manifest.name || 'thumbnail', persistent: true });

    return { ok: true, thumbnailUrl: urlFor(thumbId, 'thumbnail.png'), tempId: thumbId, cached: false };
  } finally {
    cleanupPreview(tempId);
  }
}

try { ipcMain.removeHandler('p2p:previewImageToTemp'); } catch {}
ipcMain.handle('p2p:previewImageToTemp', async (_event, payload = {}) => createImagePreview(payload));

try { ipcMain.removeHandler('p2p:getImageThumbnail'); } catch {}
ipcMain.handle('p2p:getImageThumbnail', async (_event, payload = {}) => createImageThumbnail(payload));

try { ipcMain.removeHandler('p2p:clearPreviewTemp'); } catch {}
ipcMain.handle('p2p:clearPreviewTemp', async (_event, payload = {}) => {
  cleanupPreview(payload.tempId);
  return { ok: true };
});

app.on('before-quit', () => {
  for (const tempId of Array.from(previewFiles.keys())) cleanupPreview(tempId);
});

ensurePreviewProtocol()
  .then(() => console.log('[image-preview] installed disk-first image preview + thumbnail IPC'))
  .catch((error) => console.warn('[image-preview] protocol install failed:', error?.message || error));
