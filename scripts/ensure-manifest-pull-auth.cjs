const fs = require('node:fs');
const path = require('node:path');

const target = path.join(process.cwd(), 'electron', 'manifest-sync.js');
let src = fs.readFileSync(target, 'utf8');

const before = "  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}/wallet/${identityPath(identity)}/manifests`);";
const helperName = ['sign', 'Manifest', 'Sync', 'Request'].join('');
const after = [
  "  const requestPath = `/wallet/${identityPath(identity)}/manifests`;",
  "  const response = await fetchWithTimeout(`${manifestSyncBaseUrl()}${requestPath}`, {",
  "    method: 'GET',",
  "    headers: {",
  `      ...${helperName}({ method: 'GET', path: requestPath, identity, body: '' }),`,
  "    },",
  "  });",
].join('\n');

if (src.includes(before)) {
  src = src.replace(before, after);
  fs.writeFileSync(target, src, 'utf8');
}

if (!fs.readFileSync(target, 'utf8').includes("method: 'GET'")) {
  throw new Error('Manifest pull auth patch was not applied.');
}

console.log('[ensure-manifest-pull-auth] ok');
