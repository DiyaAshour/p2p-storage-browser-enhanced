const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const configPath = path.join(root, 'electron', 'core', 'config.js');
const wrapperPath = path.join(root, 'electron', 'main-wrapper.js');
const cloudDevPath = path.join(root, 'scripts', 'electron-dev-cloud.cjs');

const failures = [];
function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing file: ${path.relative(root, file)}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

const config = read(configPath);
const wrapper = read(wrapperPath);
const cloudDev = read(cloudDevPath);

function mustContain(fileName, text, needle) {
  if (!text.includes(needle)) failures.push(`${fileName} missing: ${needle}`);
}

function mustNotContain(fileName, text, needle) {
  if (text.includes(needle)) failures.push(`${fileName} should not contain: ${needle}`);
}

mustContain('electron/core/config.js', config, "DEFAULT_CHUNK_SIZE_BYTES = envNumber('P2P_CHUNK_SIZE_BYTES', 2 * 1024 * 1024)");
mustContain('electron/core/config.js', config, 'ADAPTIVE_CHUNKING_ENABLED = false');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_SMALL_BYTES = DEFAULT_CHUNK_SIZE_BYTES');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_MEDIUM_BYTES = DEFAULT_CHUNK_SIZE_BYTES');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_LARGE_BYTES = DEFAULT_CHUNK_SIZE_BYTES');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_HUGE_BYTES = DEFAULT_CHUNK_SIZE_BYTES');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES = Number.POSITIVE_INFINITY');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_LARGE_THRESHOLD_BYTES = Number.POSITIVE_INFINITY');
mustContain('electron/core/config.js', config, 'CHUNK_SIZE_HUGE_THRESHOLD_BYTES = Number.POSITIVE_INFINITY');
mustContain('electron/core/config.js', config, 'export function chunkSizeForFile(_fileSizeBytes = 0)');
mustContain('electron/core/config.js', config, 'return DEFAULT_CHUNK_SIZE_BYTES;');

mustNotContain('electron/core/config.js', config, "8 * 1024 * 1024");
mustNotContain('electron/core/config.js', config, "16 * 1024 * 1024");
mustNotContain('electron/core/config.js', config, "100 * 1024 * 1024");
mustNotContain('electron/core/config.js', config, "5 * 1024 ** 3");

mustContain('electron/main-wrapper.js', wrapper, 'P2P_CHUNK_SIZE_BYTES');
mustContain('electron/main-wrapper.js', wrapper, '2 * 1024 * 1024');

if (cloudDev.includes('P2P_CHUNK_SIZE_BYTES') && !cloudDev.includes('2 * 1024 * 1024')) {
  failures.push('scripts/electron-dev-cloud.cjs sets P2P_CHUNK_SIZE_BYTES but not to 2MB');
}

if (failures.length) {
  console.error('[verify-chunk-policy] failed: fixed 2MB chunk policy is not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-chunk-policy] ok: all file sizes use fixed 2MB chunks');
