const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const fail = [];

function read(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    fail.push(`Missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

function requireIncludes(relative, needle, reason) {
  const text = read(relative);
  if (!text.includes(needle)) fail.push(`${relative}: ${reason}`);
}

function requireRegex(relative, regex, reason) {
  const text = read(relative);
  if (!regex.test(text)) fail.push(`${relative}: ${reason}`);
}

const ipcContract = read('electron/ipc-contract.cjs');
const preloadCjs = read('electron/preload.cjs');
const preloadEsm = read('electron/preload.js');
const config = read('electron/core/config.js');
const replication = read('electron/replication-engine.js');
const app = read('client/src/NativeP2PAppLive.tsx');
const companyStore = read('electron/company-workspace-store.js');
const companyObjects = read('electron/company-distributed-objects-ipc.js');
const mainWrapper = read('electron/main-wrapper.js');

requireIncludes('electron/preload.cjs', 'IPC_CHANNELS', 'preload.cjs must allow channels from the shared IPC contract, not a hand-written stale list');
requireIncludes('electron/preload.js', 'IPC_CHANNELS', 'preload.js must allow channels from the shared IPC contract, not a hand-written stale list');
requireIncludes('electron/preload.js', 'invokeWithRuntimeRetry', 'ESM preload must retry retryable runtime channels while Electron handlers are importing');

for (const channel of [
  'paypal:openCheckout',
  'company:joinWorkspace',
  'company:createFolder',
  'company:updateFolder',
  'company:deleteFolder',
  'audit:list',
  'audit:record',
  'audit:clear',
  'audit:listManifests',
]) {
  if (!ipcContract.includes(`'${channel}'`)) fail.push(`electron/ipc-contract.cjs: missing ${channel}`);
  if (!preloadCjs.includes('IPC_CHANNELS')) fail.push(`electron/preload.cjs: ${channel} can drift because IPC_CHANNELS is not used`);
  if (!preloadEsm.includes('IPC_CHANNELS')) fail.push(`electron/preload.js: ${channel} can drift because IPC_CHANNELS is not used`);
}

requireRegex(
  'electron/core/config.js',
  /TARGET_REPLICAS\s*=\s*Math\.max\(4,\s*envNumber\('P2P_TARGET_REPLICAS',\s*4\)\)/,
  'TARGET_REPLICAS must default to 4 and must not allow env overrides below 4'
);

requireRegex(
  'electron/replication-engine.js',
  /DEFAULT_TARGET_REPLICAS\s*=\s*4/,
  'replication engine must default to 4 replicas'
);

if (/Million-user target:\s*3 P2P replicas/i.test(config + replication)) {
  fail.push('Replica comments still mention 3 P2P replicas; this creates release confusion');
}

for (const channel of ['paypal:openCheckout', 'company:joinWorkspace', 'audit:list']) {
  if (!app.includes(`"${channel}"`)) fail.push(`client/src/NativeP2PAppLive.tsx: expected UI channel type ${channel}`);
  if (!ipcContract.includes(`'${channel}'`)) fail.push(`electron/ipc-contract.cjs: expected contract channel ${channel}`);
}

for (const needle of [
  'assertCanManage(workspace)',
  'assertCanDeleteWorkspace(workspace)',
  'roleCanUpload(this.localRole(workspace))',
  'canControlFile(workspace, file)',
  'visibleFiles(workspace)',
]) {
  if (!companyStore.includes(needle)) fail.push(`electron/company-workspace-store.js: missing backend permission guard marker: ${needle}`);
}

for (const needle of [
  'hardenedCompanyState',
  'safeWorkspaceForState',
  'files: store.visibleFiles(workspace)',
  'signedPortableInvite',
  'hardenedJoinWorkspace',
  'assertSignedPayload(invite, \'company invite\')',
  'if (!s.verifyWorkspace(importedWorkspace))',
  'Invite signer is not allowed to manage this workspace',
  'Invite token does not match a pending workspace invitation',
  'hardenedAuditList',
  'hardenedAuditRecord',
  'assertWorkspaceMember(s, workspace)',
  'replicas = 4',
]) {
  if (!companyObjects.includes(needle)) fail.push(`electron/company-distributed-objects-ipc.js: missing company hardening marker: ${needle}`);
}

if (!mainWrapper.includes("company-distributed-objects-ipc.js")) {
  fail.push('electron/main-wrapper.js: company distributed object hardening module is not imported');
}

if (fail.length) {
  console.error('[verify-enterprise-consistency] failed');
  for (const item of fail) console.error(`- ${item}`);
  process.exit(1);
}

console.log('[verify-enterprise-consistency] ok: IPC preload, enterprise channels, replica target, and company backend permissions are consistent');
