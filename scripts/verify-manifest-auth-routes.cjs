const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const serverPath = path.join(root, 'server', 'manifest-sync', 'index.js');

if (!fs.existsSync(serverPath)) {
  throw new Error('Missing server/manifest-sync/index.js');
}

const server = fs.readFileSync(serverPath, 'utf8');
const failures = [];

function mustInclude(needle, label) {
  if (!server.includes(needle)) failures.push(`Missing ${label}`);
}

function mustNotInclude(needle, label) {
  if (server.includes(needle)) failures.push(`Forbidden ${label}`);
}

mustInclude('process.env.MANIFEST_SYNC_REQUIRE_AUTH ?? "true"', 'default-on manifest auth guard');
mustInclude('function requireManifestAuth', 'manifest auth middleware');
mustInclude('app.get("/wallet/:address/manifests", requireManifestAuth,', 'protected manifest read route');
mustInclude('app.post("/wallet/:address/manifests", requireManifestAuth,', 'protected manifest write route');
mustInclude('app.delete("/wallet/:address/manifests/:hash", requireManifestAuth,', 'protected manifest delete route');
mustInclude('function normalizeAuthBody', 'shared auth body normalization for GET/DELETE/POST');
mustInclude('crypto.createHmac("sha256",', 'request signature verification');
mustInclude('crypto.timingSafeEqual', 'timing safe comparison');
mustInclude('usedNonces.has(nonceKey)', 'nonce replay protection');
mustInclude('Math.abs(now - ts) > AUTH_MAX_AGE_MS', 'timestamp age guard');
mustInclude('identity !== normalizeIdentity(expectedIdentity)', 'identity ownership guard');
mustInclude('ownerWallet !== address', 'manifest ownership guard');
mustNotInclude('app.get("/wallet/:address/manifests", (req, res)', 'unprotected manifest read route');

if (failures.length) {
  console.error('[verify-manifest-auth-routes] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify-manifest-auth-routes] ok: manifest read/write/delete routes are protected');
