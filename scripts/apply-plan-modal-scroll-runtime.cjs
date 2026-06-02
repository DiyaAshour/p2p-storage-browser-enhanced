#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
let source = fs.readFileSync(rendererPath, 'utf8');
const before = source;

source = source.replace(
  'fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4',
  'fixed inset-0 z-[9998] overflow-y-auto bg-black/70 p-4'
);

source = source.replace(
  '<div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">',
  '<div className="flex min-h-full items-start justify-center py-6">\n              <div className="w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">'
);

const oldEnd = `                <p className="mt-4 text-xs text-zinc-500">
                  Downgrades are allowed only when your used storage fits inside the lower plan.
                </p>
              </div>
            </div>
          )}`;

const newEnd = `                <p className="mt-4 text-xs text-zinc-500">
                  Downgrades are allowed only when your used storage fits inside the lower plan.
                </p>
              </div>
            </div>
          </div>
          )}`;

if (source.includes(oldEnd) && !source.includes('max-h-[90vh]')) {
  source = source.replace(oldEnd, newEnd);
} else if (source.includes(oldEnd) && !source.includes('min-h-full items-start justify-center')) {
  source = source.replace(oldEnd, newEnd);
} else if (source.includes(oldEnd) && !source.includes('\n          </div>\n          )}')) {
  source = source.replace(oldEnd, newEnd);
}

if (before !== source) fs.writeFileSync(rendererPath, source, 'utf8');
console.log('[plan-modal-scroll-runtime] applied', { renderer: before !== source });
