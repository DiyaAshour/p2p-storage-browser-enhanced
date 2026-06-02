const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const configPath = path.join(root, 'electron', 'core', 'config.js');
const limitsPath = path.join(root, 'electron', 'p2p-network-limits.js');
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
const limits = read(limitsPath);
const wrapper = read(wrapperPath);
const cloudDev = read(cloudDevPath);

const requiredConfigMarkers = [
  "DEFAULT_CHUNK_SIZE_BYTES = envNumber('P2P_CHUNK_SIZE_BYTES', 2 * 1024 * 1024)",
  "CHUNK_SIZE_SMALL_BYTES = envNumber('P2P_CHUNK_SIZE_SMALL_BYTES', 2 * 1024 * 1024)",
  "CHUNK_SIZE_MEDIUM_BYTES = envNumber('P2P_CHUNK_SIZE_MEDIUM_BYTES', 8 * 1024 * 1024)",
  "CHUNK_SIZE_LARGE_BYTES = envNumber('P2P_CHUNK_SIZE_LARGE_BYTES', 16 * 1024 * 1024)",
  "CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES = envNumber('P2P_CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES', 100 * 1024 * 1024)",
  "CHUNK_SIZE_LARGE_THRESHOLD_BYTES = envNumber('P2P_CHUNK_SIZE_LARGE_THRESHOLD_BYTES', 5 * 1024 ** 3)",
];

for (const marker of requiredConfigMarkers) {
  if (!config.includes(marker)) failures.push(`electron/core/config.js missing chunk policy marker: ${marker}`);
}

if (!config.includes('if (size >= CHUNK_SIZE_LARGE_THRESHOLD_BYTES) return CHUNK_SIZE_LARGE_BYTES;')) {
  failures.push('electron/core/config.js does not return 16MB chunks for 5GB+ files');
}
if (!config.includes('if (size >= CHUNK_SIZE_MEDIUM_THRESHOLD_BYTES) return CHUNK_SIZE_MEDIUM_BYTES;')) {
  failures.push('electron/core/config.js does not return 8MB chunks for 100MB+ files');
}
if (!config.includes('return CHUNK_SIZE_SMALL_BYTES;')) {
  failures.push('electron/core/config.js does not return 2MB chunks for small/normal files');
}

if (!wrapper.includes('P2P_CHUNK_SIZE_BYTES') || !wrapper.includes('2 * 1024 * 1024')) {
  failures.push('electron/main-wrapper.js must default P2P_CHUNK_SIZE_BYTES to 2MB');
}
if (/P2P_CHUNK_SIZE_BYTES[^\n]+1024 \* 1024/.test(cloudDev) && !cloudDev.includes('2 * 1024 * 1024')) {
  failures.push('scripts/electron-dev-cloud.cjs appears to force 1MB chunks');
}

const requiredLimitMarkers = [
  'maxMessageBytes: Number(process.env.P2P_MAX_MESSAGE_BYTES || 32 * 1024 * 1024)',
  'maxBufferedBytesPerPeer: Number(process.env.P2P_MAX_BUFFERED_BYTES_PER_PEER || 64 * 1024 * 1024)',
  'peerUploadBurstBytes: Number(process.env.P2P_PEER_UPLOAD_BURST_BYTES || 32 * 1024 * 1024)',
];
for (const marker of requiredLimitMarkers) {
  if (!limits.includes(marker)) failures.push(`electron/p2p-network-limits.js missing large chunk transport marker: ${marker}`);
}

if (failures.length) {
  console.error('[verify-chunk-policy] failed: adaptive chunk policy is not enforced');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-chunk-policy] ok: chunk policy is small=2MB, 100MB+=8MB, 5GB+=16MB with matching P2P transport limits');
