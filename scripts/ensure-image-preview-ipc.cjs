const fs = require('node:fs');
const path = require('node:path');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function patchIpcContract() {
  const file = path.join('electron', 'ipc-contract.cjs');
  let text = read(file);
  let changed = false;

  if (!text.includes("'p2p:previewImageToTemp'")) {
    text = text.replace(
      "  'p2p:downloadToPath',\n",
      "  'p2p:downloadToPath',\n  'p2p:previewImageToTemp',\n  'p2p:clearPreviewTemp',\n"
    );
    changed = true;
  }

  if (changed) write(file, text);
  return changed;
}

function patchMainWrapper() {
  const file = path.join('electron', 'main-wrapper.js');
  let text = read(file);
  let changed = false;

  if (!text.includes("./image-preview-ipc.js")) {
    text = text.replace(
      "    await import('./download-to-path-override.js');\n    console.log('[main-wrapper] download override import finished');",
      "    await import('./download-to-path-override.js');\n    console.log('[main-wrapper] download override import finished');\n    await import('./image-preview-ipc.js');\n    console.log('[main-wrapper] image preview IPC import finished');"
    );
    changed = true;
  }

  if (changed) write(file, text);
  return changed;
}

function patchElectronDev() {
  const file = path.join('scripts', 'electron-dev-cloud.cjs');
  let text = read(file);
  let changed = false;

  if (!text.includes("scripts/ensure-image-preview-ipc.cjs")) {
    text = text.replace(
      "runOptionalScript('scripts/ensure-protection-retry-early-ipc.cjs');\n",
      "runOptionalScript('scripts/ensure-protection-retry-early-ipc.cjs');\nrunOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n"
    );
    changed = true;
  }

  if (changed) write(file, text);
  return changed;
}

function patchRenderer() {
  const file = path.join('client', 'src', 'NativeP2PAppLive.tsx');
  let text = read(file);
  let changed = false;

  if (!text.includes('| "p2p:previewImageToTemp"')) {
    text = text.replace(
      '  | "p2p:downloadToPath"\n',
      '  | "p2p:downloadToPath"\n  | "p2p:previewImageToTemp"\n  | "p2p:clearPreviewTemp"\n'
    );
    changed = true;
  }

  if (!text.includes('mimeType?: string;')) {
    text = text.replace(
      '  name: string;\n  size: number;\n',
      '  name: string;\n  mimeType?: string;\n  size: number;\n'
    );
    changed = true;
  }

  if (!text.includes('function isImageFile(file: P2PFile)')) {
    text = text.replace(
      `function itemIdFor(file: P2PFile) {\n  return file.id || file.rootHash || file.hash;\n}\n`,
      `function itemIdFor(file: P2PFile) {\n  return file.id || file.rootHash || file.hash;\n}\n\nfunction isImageFile(file: P2PFile) {\n  const mime = String(file.mimeType || "").toLowerCase();\n  const name = String(file.name || "").toLowerCase();\n\n  return mime.startsWith("image/") || /\\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);\n}\n`
    );
    changed = true;
  }

  if (!text.includes('const [preview, setPreview]')) {
    text = text.replace(
      '  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());\n',
      '  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());\n  const [preview, setPreview] = useState<{ open: boolean; url: string; name: string; tempId?: string } | null>(null);\n'
    );
    changed = true;
  }

  if (!text.includes('const previewImage = (file: P2PFile) =>')) {
    text = text.replace(
      `  const download = (file: P2PFile) =>\n    run(async () => {\n      await api.invoke("p2p:downloadToPath", {\n        hash: file.hash,\n        rootHash: file.rootHash,\n        name: file.name,\n        isEncrypted: file.isEncrypted,\n        drivePassword: file.isEncrypted ? password() : null,\n      });\n\n      toast.success(\`Download started for \${file.name}\`);\n    });\n`,
      `  const download = (file: P2PFile) =>\n    run(async () => {\n      await api.invoke("p2p:downloadToPath", {\n        hash: file.hash,\n        rootHash: file.rootHash,\n        name: file.name,\n        isEncrypted: file.isEncrypted,\n        drivePassword: file.isEncrypted ? password() : null,\n      });\n\n      toast.success(\`Download started for \${file.name}\`);\n    });\n\n  const previewImage = (file: P2PFile) =>\n    run(async () => {\n      if (!isImageFile(file)) {\n        toast.error("Preview is available only for images");\n        return;\n      }\n\n      const result = await api.invoke<{ ok: boolean; previewUrl: string; tempId: string; file?: P2PFile }>(\n        "p2p:previewImageToTemp",\n        {\n          hash: file.hash,\n          rootHash: file.rootHash,\n          name: file.name,\n          drivePassword: file.isEncrypted ? password() : null,\n        }\n      );\n\n      setPreview({\n        open: true,\n        url: result.previewUrl,\n        name: result.file?.name || file.name,\n        tempId: result.tempId,\n      });\n\n      await recordAudit("drive:image-previewed", {\n        fileName: file.name,\n        rootHash: file.rootHash || file.hash,\n      });\n    });\n\n  const closePreview = () =>\n    run(async () => {\n      const tempId = preview?.tempId;\n      setPreview(null);\n\n      if (tempId) {\n        await api.invoke("p2p:clearPreviewTemp", { tempId });\n      }\n    });\n`
    );
    changed = true;
  }

  const oldThumb = `          <div className="flex h-20 items-center justify-center rounded-2xl bg-zinc-950">\n            <FileCheck2 className="size-9 text-zinc-500" />\n          </div>`;
  const newThumb = `          <button\n            type="button"\n            onDoubleClick={() => {\n              if (isImageFile(file)) void previewImage(file);\n            }}\n            className={\`flex h-28 w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 transition-all \${isImageFile(file) ? "cursor-zoom-in hover:border-blue-500 hover:bg-blue-950/20" : ""}\`}\n            title={isImageFile(file) ? "Double click to preview image" : "File"}\n          >\n            {isImageFile(file) ? (\n              <div className="flex flex-col items-center justify-center gap-2 text-blue-300">\n                <Eye className="size-8" />\n                <span className="text-xs text-zinc-400">Double click to preview</span>\n              </div>\n            ) : (\n              <FileCheck2 className="size-9 text-zinc-500" />\n            )}\n          </button>`;

  if (text.includes(oldThumb) && !text.includes('Double click to preview image')) {
    text = text.replace(oldThumb, newThumb);
    changed = true;
  }

  const downloadButton = `            <Button size="sm" onClick={() => download(file)} disabled={busy} className="text-xs">\n              <Download className="size-3" />\n              Download\n            </Button>`;
  const previewButton = `            {isImageFile(file) && (\n              <Button\n                variant="outline"\n                size="sm"\n                onClick={() => previewImage(file)}\n                disabled={busy}\n                className="text-xs"\n              >\n                <Eye className="size-3" />\n                Preview\n              </Button>\n            )}\n\n${downloadButton}`;

  if (text.includes(downloadButton) && !text.includes('Preview\n              </Button>\n            )}\n\n            <Button size="sm" onClick={() => download(file)}')) {
    text = text.replace(downloadButton, previewButton);
    changed = true;
  }

  if (!text.includes('{preview?.open && (')) {
    text = text.replace(
      `    <div className="min-h-screen bg-zinc-950 text-zinc-50">\n      <header`,
      `    <div className="min-h-screen bg-zinc-950 text-zinc-50">\n      {preview?.open && (\n        <div\n          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"\n          onClick={closePreview}\n        >\n          <div\n            className="max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl"\n            onClick={(event) => event.stopPropagation()}\n          >\n            <div className="flex items-center justify-between border-b border-zinc-800 p-4">\n              <p className="truncate text-sm font-semibold">{preview.name}</p>\n              <Button variant="outline" size="sm" onClick={closePreview}>\n                Close\n              </Button>\n            </div>\n\n            <div className="flex max-h-[80vh] items-center justify-center bg-black p-4">\n              <img\n                src={preview.url}\n                alt={preview.name}\n                className="max-h-[76vh] max-w-full object-contain"\n              />\n            </div>\n          </div>\n        </div>\n      )}\n\n      <header`
    );
    changed = true;
  }

  if (changed) write(file, text);
  return changed;
}

const changes = [];
if (patchIpcContract()) changes.push('electron/ipc-contract.cjs');
if (patchMainWrapper()) changes.push('electron/main-wrapper.js');
if (patchElectronDev()) changes.push('scripts/electron-dev-cloud.cjs');
if (patchRenderer()) changes.push('client/src/NativeP2PAppLive.tsx');

console.log(changes.length ? `[ensure-image-preview-ipc] patched ${changes.join(', ')}` : '[ensure-image-preview-ipc] image preview already wired');
