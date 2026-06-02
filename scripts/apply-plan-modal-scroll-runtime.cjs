#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
let source = fs.readFileSync(rendererPath, 'utf8');
const before = source;

// Keep the overlay fixed to the viewport. The previous version made the whole
// page scroll and pushed the modal partly above the visible window.
source = source.replaceAll(
  'fixed inset-0 z-[9998] overflow-y-auto bg-black/70 p-4',
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4'
);

source = source.replaceAll(
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4',
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4'
);

// Remove the extra wrapper inserted by the first scroll patch.
source = source.replaceAll(
  '<div className="flex min-h-full items-start justify-center py-6">\n              <div className="w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

source = source.replaceAll(
  '<div className="flex min-h-full items-start justify-center py-6">\n              <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

// Upgrade the original modal card to a scrollable card without adding wrappers.
source = source.replaceAll(
  '<div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

source = source.replaceAll(
  '<div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

source = source.replaceAll(
  '<div className="w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="w-full max-w-6xl max-h-[82vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

// If the old wrapper added a third closing div, remove it.
const wrappedEnd = `                <p className="mt-4 text-xs text-zinc-500">
                  Downgrades are allowed only when your used storage fits inside the lower plan.
                </p>
              </div>
            </div>
          </div>
          )}`;

const cleanEnd = `                <p className="mt-4 text-xs text-zinc-500">
                  Downgrades are allowed only when your used storage fits inside the lower plan.
                </p>
              </div>
            </div>
          )}`;

source = source.replaceAll(wrappedEnd, cleanEnd);

if (before !== source) fs.writeFileSync(rendererPath, source, 'utf8');
console.log('[plan-modal-scroll-runtime] applied', { renderer: before !== source });
