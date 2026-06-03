# Chunknet Image Preview + Thumbnail Implementation

Date: 2026-06-03
Branch: `big-file-upload-safe`

## Goal

Add image preview and safe thumbnail support to Chunknet without breaking the big-file-safe upload/download path.

Requested behavior:

- Image files show a small thumbnail inside the file card.
- Double-clicking the image card opens a preview modal.
- Preview and thumbnails do not use renderer memory-heavy file transfer APIs.
- Normal downloads continue to use `p2p:downloadToPath`.
- Big file safety rules remain protected.

## Safety rule

Do not use these in the active renderer path:

- `p2p:download`
- `URL.createObjectURL(...)`
- `FileReader`
- `.arrayBuffer()`
- `Buffer.from(...)`
- Blob-based downloads for app file transfers

Reason: `scripts/verify-large-file-safety.cjs` explicitly blocks these patterns for active renderer files.

## Files added

### `electron/image-preview-ipc.js`

Disk-first image preview and thumbnail backend.

What it does:

1. Finds the file manifest by `hash` / `rootHash` for the current identity.
2. Validates that the file is an image by MIME type or file extension.
3. Reads chunks from the local binary chunk store, network, or safety peer.
4. Writes encrypted/cipher chunks to a temporary file without returning bytes to React.
5. Decrypts encrypted files to a temporary image file using stream pipeline.
6. Registers a privileged Electron protocol:

   ```text
   chunknet-preview://<id>/<safe-name>
   ```

7. Returns only safe protocol URLs to the renderer.
8. Deletes temporary preview files when `p2p:clearPreviewTemp` runs or when the app quits.
9. Generates cached PNG thumbnails using Electron `nativeImage` and stores them under:

   ```text
   userData/native-p2p-storage/thumbnails
   ```

New IPC handlers:

```text
p2p:previewImageToTemp
p2p:getImageThumbnail
p2p:clearPreviewTemp
```

## Files changed

### `electron/ipc-contract.cjs`

Added allowed channels:

```text
p2p:previewImageToTemp
p2p:getImageThumbnail
p2p:clearPreviewTemp
```

This prevents the preload bridge from blocking the new preview/thumbnail IPC calls.

### `electron/main-wrapper.js`

Added runtime import:

```js
await import('./image-preview-ipc.js');
```

It runs after `download-to-path-override.js`, so normal download safety remains intact.

### `scripts/electron-dev-cloud.cjs`

Added:

```js
runOptionalScript('scripts/ensure-image-preview-ipc.cjs');
```

This makes `pnpm run electron:dev` self-healing and applies preview/thumbnail wiring before Electron launches.

### `package.json`

Added script:

```json
"ensure:image-preview": "node scripts/ensure-image-preview-ipc.cjs"
```

Wired it into:

- `prepare:final`
- `verify`
- `electron:dev:raw`

### `scripts/ensure-image-preview-ipc.cjs`

Self-healing patch script.

It patches:

- `electron/ipc-contract.cjs`
- `electron/main.js`
- `electron/main-wrapper.js`
- `scripts/electron-dev-cloud.cjs`
- `client/src/NativeP2PAppLive.tsx`

This is intentionally idempotent. Running it multiple times should not duplicate code.

## Renderer changes applied by ensure script

Target file:

```text
client/src/NativeP2PAppLive.tsx
```

Planned/ensured changes:

1. Add IPC channel types:

   ```ts
   | "p2p:previewImageToTemp"
   | "p2p:getImageThumbnail"
   | "p2p:clearPreviewTemp"
   ```

2. Add `mimeType?: string` to `P2PFile`.

3. Add image detection helper:

   ```ts
   function isImageFile(file: P2PFile) {
     const mime = String(file.mimeType || "").toLowerCase();
     const name = String(file.name || "").toLowerCase();

     return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);
   }
   ```

4. Add preview state.

5. Add thumbnail state:

   ```ts
   const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
   const [thumbnailLoadingKeys, setThumbnailLoadingKeys] = useState<Set<string>>(new Set());
   ```

6. Add effect that requests thumbnails for visible image files through:

   ```text
   p2p:getImageThumbnail
   ```

7. Add `previewImage(file)` action calling:

   ```text
   p2p:previewImageToTemp
   ```

8. Add `closePreview()` action calling:

   ```text
   p2p:clearPreviewTemp
   ```

9. Add Preview button for image files.

10. Add double-click preview on image card.

11. Add card thumbnail display:

   ```tsx
   <img src={thumbnailUrls[itemIdFor(file)]} />
   ```

12. Add modal viewer using:

   ```tsx
   <img src={preview.url} />
   ```

Important: the renderer receives only `chunknet-preview://...` URLs, not file bytes.

## How thumbnails work

- The renderer detects visible image files.
- It calls `p2p:getImageThumbnail` with `hash`, `rootHash`, and drive password when needed.
- Electron materializes the image safely on disk, decrypting via stream if encrypted.
- Electron creates a small PNG using `nativeImage.resize`.
- The thumbnail is cached on disk by file root/hash.
- The renderer receives a `chunknet-preview://thumb-.../thumbnail.png` URL.
- Old images also get thumbnails because thumbnails are generated lazily when the card becomes visible.

## How to apply locally

From the repo root:

```powershell
git checkout big-file-upload-safe
git stash push -m "before image preview thumbnails"
git pull
pnpm install
pnpm run ensure:image-preview
pnpm run verify:large-files
pnpm run electron:dev
```

Use `git stash pop` later only after confirming the pulled version works.

## Manual test plan

1. Start the app with `pnpm run electron:dev`.
2. Login with Seed Account or Wallet.
3. Enter Drive Password.
4. Open a folder with old `.jpg`, `.jpeg`, `.png`, or `.webp` files.
5. Confirm image cards show a small real thumbnail.
6. Upload a new image and confirm it also shows a thumbnail.
7. Double-click the image card.
8. Confirm a modal opens with the full image preview.
9. Close the modal.
10. Confirm no `Blocked unsafe IPC channel` error appears.
11. Download the same file normally and confirm `p2p:downloadToPath` still uses save dialog.
12. Upload a large non-image file and confirm no renderer memory crash.
13. Run:

    ```powershell
    pnpm run verify:large-files
    pnpm run verify
    ```

## Expected logs

During runtime import:

```text
[image-preview] installed disk-first image preview + thumbnail IPC
[main-wrapper] image preview IPC import finished
```

During ensure script:

```text
[ensure-image-preview-ipc] patched ...
```

or:

```text
[ensure-image-preview-ipc] image preview + thumbnails already wired
```

## Known limitation

Thumbnail generation still has to decode the image once in Electron. Very large images may take time to decode, but transfer/decryption stays disk-first and no full file bytes are returned to React.

## Rollback

To disable the feature:

1. Remove the `image-preview-ipc.js` import from runtime.
2. Remove `p2p:previewImageToTemp`, `p2p:getImageThumbnail`, and `p2p:clearPreviewTemp` from `electron/ipc-contract.cjs`.
3. Remove `ensure:image-preview` from `package.json` scripts.
4. Remove preview/thumbnail UI blocks from `NativeP2PAppLive.tsx`.
5. Delete `electron/image-preview-ipc.js` and `scripts/ensure-image-preview-ipc.cjs`.

## Commits made during this implementation

- Added `electron/image-preview-ipc.js`
- Added `scripts/ensure-image-preview-ipc.cjs`
- Added preview/thumbnail IPC channels to `electron/ipc-contract.cjs`
- Wired `ensure:image-preview` into package scripts
- Imported image preview IPC in `electron/main-wrapper.js`
- Added safe cached thumbnails through `p2p:getImageThumbnail`
- Updated this tracking document
