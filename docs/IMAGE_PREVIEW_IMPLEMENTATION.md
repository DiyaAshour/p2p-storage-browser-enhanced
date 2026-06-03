# Chunknet Image Preview Implementation

Date: 2026-06-03
Branch: `big-file-upload-safe`

## Goal

Add image preview support to Chunknet without breaking the big-file-safe upload/download path.

Requested behavior:

- Image files show a preview action in `NativeP2PAppLive.tsx`.
- Double-clicking the image card opens a preview modal.
- Preview does not use renderer memory-heavy file transfer APIs.
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

New disk-first image preview backend.

What it does:

1. Finds the file manifest by `hash` / `rootHash` for the current identity.
2. Validates that the file is an image by MIME type or file extension.
3. Reads chunks from the local binary chunk store, network, or safety peer.
4. Writes encrypted/cipher chunks to a temporary file without returning bytes to React.
5. Decrypts encrypted files to a temporary preview file using stream pipeline.
6. Registers a privileged Electron protocol:

   ```text
   chunknet-preview://<tempId>/<safe-name>
   ```

7. Returns only the preview URL and temp ID to the renderer.
8. Deletes temp preview files when `p2p:clearPreviewTemp` runs or when the app quits.

New IPC handlers:

```text
p2p:previewImageToTemp
p2p:clearPreviewTemp
```

## Files changed

### `electron/ipc-contract.cjs`

Added allowed channels:

```text
p2p:previewImageToTemp
p2p:clearPreviewTemp
```

This prevents the preload bridge from blocking the new preview IPC calls.

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

This makes `pnpm run electron:dev` self-healing and applies preview wiring before Electron launches.

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

4. Add preview state:

   ```ts
   const [preview, setPreview] = useState<{
     open: boolean;
     url: string;
     name: string;
     tempId?: string;
   } | null>(null);
   ```

5. Add `previewImage(file)` action calling:

   ```text
   p2p:previewImageToTemp
   ```

6. Add `closePreview()` action calling:

   ```text
   p2p:clearPreviewTemp
   ```

7. Add Preview button for image files.

8. Add double-click preview on image card.

9. Add modal viewer using:

   ```tsx
   <img src={preview.url} />
   ```

Important: the renderer receives only a `chunknet-preview://...` URL, not file bytes.

## Why no thumbnail image yet?

This change adds safe preview first.

Thumbnail background can be added later by generating small cached thumbnails in Electron. It should also avoid returning raw file bytes to the renderer. Recommended follow-up:

- Add `p2p:getImageThumbnail` or `p2p:ensureImageThumbnail`
- Generate a small temp/cache thumbnail in Electron
- Return `chunknet-preview://thumbnail/<id>` or another safe protocol URL
- Never generate thumbnails in React from `Blob` or `arrayBuffer`

## How to apply locally

From the repo root:

```powershell
git checkout big-file-upload-safe
git pull
pnpm install
pnpm run ensure:image-preview
pnpm run verify:large-files
pnpm run electron:dev
```

## Manual test plan

1. Start the app with `pnpm run electron:dev`.
2. Login with Seed Account or Wallet.
3. Enter Drive Password.
4. Upload a `.jpg`, `.jpeg`, `.png`, or `.webp` file.
5. Confirm the image card shows preview affordance.
6. Double-click the image card.
7. Confirm a modal opens with the image.
8. Close the modal.
9. Confirm no `Blocked unsafe IPC channel` error appears.
10. Download the same file normally and confirm `p2p:downloadToPath` still uses save dialog.
11. Upload a large file and confirm no renderer memory crash.
12. Run:

    ```powershell
    pnpm run verify:large-files
    pnpm run verify
    ```

## Expected logs

During runtime import:

```text
[image-preview] installed disk-first image preview IPC
[main-wrapper] image preview IPC import finished
```

During ensure script:

```text
[ensure-image-preview-ipc] patched ...
```

or:

```text
[ensure-image-preview-ipc] image preview already wired
```

## Known limitation

Preview opens full image through a temporary decoded file. Very large images may still take time to decode/render in Chromium, but transfer/decryption stays disk-first and does not return full file bytes to React.

## Rollback

To disable the feature:

1. Remove the `image-preview-ipc.js` import from runtime.
2. Remove `p2p:previewImageToTemp` and `p2p:clearPreviewTemp` from `electron/ipc-contract.cjs`.
3. Remove `ensure:image-preview` from `package.json` scripts.
4. Remove preview UI blocks from `NativeP2PAppLive.tsx`.
5. Delete `electron/image-preview-ipc.js` and `scripts/ensure-image-preview-ipc.cjs`.

## Commits made during this implementation

- Added `electron/image-preview-ipc.js`
- Added `scripts/ensure-image-preview-ipc.cjs`
- Added preview IPC channels to `electron/ipc-contract.cjs`
- Wired `ensure:image-preview` into package scripts
- Imported image preview IPC in `electron/main-wrapper.js`
- Added this tracking document
