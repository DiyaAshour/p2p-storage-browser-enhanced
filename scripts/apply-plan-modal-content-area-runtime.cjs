#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
let source = fs.readFileSync(rendererPath, 'utf8');
const before = source;

const overlayVariants = [
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4',
  'fixed inset-0 z-[9998] overflow-y-auto bg-black/70 p-4',
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4 pt-6',
  'fixed inset-0 z-[9998] flex items-start justify-center overflow-hidden bg-black/70 p-4 pt-6',
];

const contentAreaOverlay = 'fixed z-[9998] flex items-start justify-center overflow-hidden bg-black/70 p-4';

for (const item of overlayVariants) {
  source = source.replaceAll(item, contentAreaOverlay);
}

source = source.replaceAll(
  '<div className="fixed z-[9998] flex items-start justify-center overflow-hidden bg-black/70 p-4">',
  '<div className="fixed z-[9998] flex items-start justify-center overflow-hidden bg-black/70 p-4" style={{ top: "96px", left: "260px", right: "0px", bottom: "0px" }}>'
);

source = source.replaceAll(
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-5xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" style={{ maxHeight: "calc(100vh - 140px)" }}>'
);

source = source.replaceAll(
  '<div className="w-full max-w-6xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" style={{ maxHeight: "calc(100vh - 4rem)" }}>',
  '<div className="w-full max-w-5xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" style={{ maxHeight: "calc(100vh - 140px)" }}>'
);

if (before !== source) fs.writeFileSync(rendererPath, source, 'utf8');
console.log('[plan-modal-content-area-runtime] applied', { renderer: before !== source });
