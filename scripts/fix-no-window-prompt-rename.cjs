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

replaceOnce(
`    const name = window.prompt("New file name", oldName)?.trim();
    if (!name || name === oldName) return;`,
`    const name = (
      await askText({
        title: "Rename Company File",
        message: ` + '`Rename "${oldName}"`' + `,
        defaultValue: oldName,
        placeholder: "New file name",
        confirmText: "Rename",
      })
    )?.trim();

    if (!name || name === oldName) return;`
);

// Guard against any future accidental prompt usage in the active renderer.
if (text.includes('window.prompt(')) {
  console.warn('[fix-no-window-prompt-rename] warning: another window.prompt remains in NativeP2PAppLive.tsx');
}

if (changed) {
  fs.writeFileSync(file, text, 'utf8');
  console.log('[fix-no-window-prompt-rename] replaced unsupported window.prompt rename with askText modal');
} else {
  console.log('[fix-no-window-prompt-rename] no unsupported rename prompt found');
}
