const fs = require('node:fs');
const path = require('node:path');

const file = path.join('client', 'src', 'NativeP2PAppLive.tsx');
let text = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceOnce(from, to) {
  if (!text.includes(from)) return false;
  text = text.replace(from, to);
  changed = true;
  return true;
}

// Remove the first thumbnail implementation that generated thumbnails for up to
// 80 visible images as soon as the Drive Password was typed. That could make
// Electron look frozen because each private image needs decrypt + decode + resize.
const autoStart = 'useEffect(() => {\n  if (!api || !identityConnected || !drivePassword.trim()) return;\n\n  const imageFiles = visibleFiles.filter(isImageFile).slice(0, 80);';
const autoIndex = text.indexOf(autoStart);
if (autoIndex >= 0) {
  const endIndex = text.indexOf('const uploaderLabel =', autoIndex);
  if (endIndex > autoIndex) {
    text = text.slice(0, autoIndex) + text.slice(endIndex);
    changed = true;
  }
}

if (text.includes('| "p2p:previewImageToTemp"') && !text.includes('| "p2p:getImageThumbnail"')) {
  replaceOnce('  | "p2p:previewImageToTemp"\n', '  | "p2p:previewImageToTemp"\n  | "p2p:getImageThumbnail"\n');
}

if (text.includes('const [preview, setPreview]') && !text.includes('const [thumbnailUrls, setThumbnailUrls]')) {
  replaceOnce(
    '  const [preview, setPreview] = useState<{ open: boolean; url: string; name: string; tempId?: string } | null>(null);\n',
    '  const [preview, setPreview] = useState<{ open: boolean; url: string; name: string; tempId?: string } | null>(null);\n  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});\n  const [thumbnailLoadingKeys, setThumbnailLoadingKeys] = useState<Set<string>>(new Set());\n'
  );
}

const loadThumbnailBlock = `  const loadThumbnail = (file: P2PFile) => {\n    if (!api || !isImageFile(file) || !drivePassword.trim()) return;\n\n    const key = itemIdFor(file);\n    if (!key || thumbnailUrls[key] || thumbnailLoadingKeys.has(key)) return;\n\n    setThumbnailLoadingKeys((prev) => {\n      const next = new Set(prev);\n      next.add(key);\n      return next;\n    });\n\n    void api\n      .invoke<{ ok?: boolean; thumbnailUrl?: string }>("p2p:getImageThumbnail", {\n        hash: file.hash,\n        rootHash: file.rootHash,\n        name: file.name,\n        drivePassword: file.isEncrypted ? password() : null,\n        maxSize: 256,\n      })\n      .then((result) => {\n        if (result?.thumbnailUrl) {\n          setThumbnailUrls((prev) => ({ ...prev, [key]: result.thumbnailUrl || "" }));\n        }\n      })\n      .catch(() => {\n        // Thumbnail generation is non-blocking. Preview and download still work.\n      })\n      .finally(() => {\n        setThumbnailLoadingKeys((prev) => {\n          const next = new Set(prev);\n          next.delete(key);\n          return next;\n        });\n      });\n  };\n\n`;

if (!text.includes('const loadThumbnail = (file: P2PFile) =>') && text.includes('  const previewImage = (file: P2PFile) =>')) {
  replaceOnce('  const previewImage = (file: P2PFile) =>\n', `${loadThumbnailBlock}  const previewImage = (file: P2PFile) =>\n`);
}

// Make thumbnail generation on-demand by mouse hover, keyboard focus, or click.
if (text.includes('title={isImageFile(file) ? "Double click to preview image" : "File"}') && !text.includes('onMouseEnter={() => {\n              if (isImageFile(file)) loadThumbnail(file);')) {
  replaceOnce(
    '            onDoubleClick={() => {\n              if (isImageFile(file)) void previewImage(file);\n            }}\n',
    '            onMouseEnter={() => {\n              if (isImageFile(file)) loadThumbnail(file);\n            }}\n            onFocus={() => {\n              if (isImageFile(file)) loadThumbnail(file);\n            }}\n            onClick={() => {\n              if (isImageFile(file) && !thumbnailUrls[itemIdFor(file)]) loadThumbnail(file);\n            }}\n            onDoubleClick={() => {\n              if (isImageFile(file)) void previewImage(file);\n            }}\n'
  );

  replaceOnce(
    'title={isImageFile(file) ? "Double click to preview image" : "File"}',
    'title={isImageFile(file) ? "Hover/click to load thumbnail, double click to preview" : "File"}'
  );

  text = text.replace(/Double click to preview/g, 'Hover/click to load thumbnail');
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, text, 'utf8');
  console.log('[fix-thumbnail-on-demand] patched NativeP2PAppLive thumbnail behavior');
} else {
  console.log('[fix-thumbnail-on-demand] thumbnail behavior already on-demand');
}
