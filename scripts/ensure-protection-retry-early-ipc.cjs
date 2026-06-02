const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const targets = [
  path.join(root, 'electron', 'main-wrapper.js'),
  path.join(root, 'electron', 'main.js'),
];

const staticImport = "import './protection-retry-early-ipc.js';";
let changedAny = false;

function ensureStaticImport(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let changed = false;

  if (!src.includes(staticImport)) {
    const firstImport = src.match(/^import .*?;$/m)?.[0];
    if (!firstImport) throw new Error(`Could not find first import in ${path.relative(root, file)}`);
    src = src.replace(firstImport, `${staticImport}\n${firstImport}`);
    changed = true;
    console.log(`[ensure-protection-retry-early-ipc] added static import to ${path.relative(root, file)}`);
  }

  src = src.replace(
    /\n\s*await import\('\.\/protection-retry-early-ipc\.js'\);\n\s*console\.log\('\[main-wrapper\] protection retry early IPC import finished'\);/,
    () => {
      changed = true;
      console.log(`[ensure-protection-retry-early-ipc] removed dynamic import from ${path.relative(root, file)}`);
      return '';
    }
  );

  if (changed) {
    fs.writeFileSync(file, src, 'utf8');
    changedAny = true;
  }
}

for (const file of targets) ensureStaticImport(file);

// Extra safety: make launcher run this guard before spawning Electron, even if scripts are changed later.
const launcher = path.join(root, 'scripts', 'launch-electron.cjs');
if (fs.existsSync(launcher)) {
  let launch = fs.readFileSync(launcher, 'utf8').replace(/\r\n/g, '\n');
  if (!launch.includes('ensure-protection-retry-early-ipc.cjs')) {
    launch = launch.replace(
      "const { spawn } = require('child_process');",
      "const { spawn, execFileSync } = require('child_process');"
    );
    const marker = "const os = require('os');\n";
    const injected = `${marker}\ntry {\n  execFileSync(process.execPath, [path.join(__dirname, 'ensure-protection-retry-early-ipc.cjs')], { stdio: 'inherit', cwd: path.join(__dirname, '..') });\n} catch (error) {\n  console.error('[launch-electron] protection retry IPC guard failed:', error?.message || error);\n  process.exit(1);\n}\n`;
    if (!launch.includes(marker)) throw new Error('Could not find launcher os require marker.');
    launch = launch.replace(marker, injected);
    fs.writeFileSync(launcher, launch, 'utf8');
    changedAny = true;
    console.log('[ensure-protection-retry-early-ipc] wired launcher guard');
  }
}

console.log('[ensure-protection-retry-early-ipc] ok', { changed: changedAny });
