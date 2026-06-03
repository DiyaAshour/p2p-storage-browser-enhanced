const fs = require('node:fs');
const path = require('node:path');

const file = path.join('client', 'src', 'NativeP2PAppLive.tsx');
let text = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceAll(from, to) {
  if (!text.includes(from)) return false;
  text = text.split(from).join(to);
  changed = true;
  return true;
}

// audit:record may be installed later than the renderer action. Preview must not fail
// just because audit IPC is temporarily unavailable.
replaceAll(
`      await recordAudit("drive:image-previewed", {
        fileName: file.name,
        rootHash: file.rootHash || file.hash,
      });`,
`      try {
        await recordAudit("drive:image-previewed", {
          fileName: file.name,
          rootHash: file.rootHash || file.hash,
        });
      } catch {
        // Audit is best-effort here; preview must keep working if audit IPC is not ready.
      }`
);

// If the first on-demand thumbnail loader exists, make it timeout and always clear
// loading state. This prevents cards from staying on "Loading thumbnail...".
replaceAll(
`    void api
      .invoke<{ ok?: boolean; thumbnailUrl?: string }>("p2p:getImageThumbnail", {
        hash: file.hash,
        rootHash: file.rootHash,
        name: file.name,
        drivePassword: file.isEncrypted ? password() : null,
        maxSize: 256,
      })
      .then((result) => {`,
`    const thumbnailRequest = api.invoke<{ ok?: boolean; thumbnailUrl?: string }>("p2p:getImageThumbnail", {
      hash: file.hash,
      rootHash: file.rootHash,
      name: file.name,
      drivePassword: file.isEncrypted ? password() : null,
      maxSize: 192,
    });

    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Thumbnail timeout")), 8000);
    });

    void Promise.race([thumbnailRequest, timeout])
      .then((result) => {`
);

replaceAll(
`      .catch(() => {
        // Thumbnail generation is non-blocking. Preview and download still work.
      })`,
`      .catch(() => {
        setThumbnailUrls((prev) => ({ ...prev, [key]: "" }));
      })`
);

// Change stuck text to a useful fallback.
replaceAll('Loading thumbnail...', 'Loading...');
replaceAll('Hover/click to load thumbnail', 'Preview image');

if (changed) {
  fs.writeFileSync(file, text, 'utf8');
  console.log('[fix-thumbnail-stuck-and-audit] patched preview audit and thumbnail loading fallback');
} else {
  console.log('[fix-thumbnail-stuck-and-audit] already patched');
}
