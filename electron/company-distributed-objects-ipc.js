import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCompanyWorkspaceStore } from './company-workspace-store.js';

const ROLES = new Set(['owner', 'admin', 'manager', 'editor', 'viewer', 'guest']);
const MANAGE_ROLES = new Set(['owner', 'admin', 'manager']);

function dataDir() { return path.join(app.getPath('userData'), 'native-p2p-storage'); }
function objectDir() { return path.join(dataDir(), 'company-objects'); }
function chunkStoreDir() { return process.env.P2P_CHUNK_STORE_DIR || path.join(dataDir(), 'chunks'); }
function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeHash(hash = '') { return String(hash || '').replace(/[^a-fA-F0-9]/g, ''); }
function objectPath(hash) { return path.join(objectDir(), `${safeHash(hash)}.json`); }
function chunkPath(hash) { return path.join(chunkStoreDir(), `${safeHash(hash)}.json`); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }
function decodeChunknetToken(token = '') { const match = String(token || '').trim().match(/^chunknet:\/\/([^/]+)\/(.+)$/); if (!match) throw new Error('Invalid Chunknet token.'); const [, kind, encoded] = match; return { kind, payload: JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }; }
function encodeChunknetToken(kind, payload) { return `chunknet://${kind}/${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`; }
function unique(values = []) { return Array.from(new Set(values.filter(Boolean))); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function withoutSignature(value = {}) { const { signature, ...rest } = value || {}; return rest; }
function sign(privateKeyPem, value) { return crypto.sign(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64'); }
function verify(publicKeyPem, value, signature) { try { return crypto.verify(null, Buffer.from(canonicalJson(value), 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature || ''), 'base64')); } catch { return false; } }
function roleCanManage(role) { return MANAGE_ROLES.has(role); }

let workspaceStore = null;
function companyStore() {
  if (!workspaceStore) workspaceStore = createCompanyWorkspaceStore({ dataDir: dataDir() });
  return workspaceStore;
}

function transportNode() {
  return globalThis.__p2pTransportNode || globalThis.__p2pNode || globalThis.p2pTransportNode || globalThis.p2pNode || null;
}

function assertWorkspaceMember(store, workspace) {
  const role = store.localRole(workspace);
  if (!role) throw new Error('This device is not a member of this company workspace.');
  return role;
}

function assertWorkspaceManager(store, workspace) {
  const role = assertWorkspaceMember(store, workspace);
  if (!roleCanManage(role)) throw new Error('Your company role cannot manage this workspace.');
  return role;
}

function signedPayload(payload = {}, identity) {
  const unsigned = {
    ...payload,
    signedByDeviceId: identity.deviceId,
    signedByPublicKeyPem: identity.publicKeyPem,
  };
  return { ...unsigned, signature: sign(identity.privateKeyPem, unsigned) };
}

function assertSignedPayload(payload = {}, label = 'token') {
  if (!payload?.signedByPublicKeyPem || !payload?.signature) throw new Error(`Unsigned ${label} is not allowed.`);
  if (!verify(payload.signedByPublicKeyPem, withoutSignature(payload), payload.signature)) throw new Error(`Invalid ${label} signature.`);
}

function memberBySigner(workspace = {}, signed = {}) {
  return (workspace.members || []).find((member) => (
    (signed.signedByDeviceId && member.deviceId === signed.signedByDeviceId) ||
    (signed.signedByPublicKeyPem && member.publicKeyPem === signed.signedByPublicKeyPem)
  )) || null;
}

function normalizeFolders(folders = [], workspaceId = '') {
  const map = new Map();
  for (const raw of Array.isArray(folders) ? folders : []) {
    const folderId = String(raw?.folderId || raw?.id || raw?.hash || raw?.rootHash || '').trim();
    const name = String(raw?.name || '').trim().replace(/\s+/g, ' ');
    if (!folderId || !name) continue;
    map.set(folderId, {
      ...raw,
      id: raw.id || folderId,
      folderId,
      name,
      parentFolderId: String(raw.parentFolderId || '').trim(),
      workspaceId,
      kind: 'company-folder',
      isFolder: true,
      updatedAt: raw.updatedAt || raw.createdAt || now(),
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function safeWorkspaceForState(store, workspace = {}) {
  return {
    ...workspace,
    folders: normalizeFolders(workspace.folders || [], workspace.workspaceId),
    files: store.visibleFiles(workspace),
    totalCompanyFiles: Array.isArray(workspace.files) ? workspace.files.filter((file) => !file.deleted).length : 0,
    visibleCompanyFiles: store.visibleFiles(workspace).length,
  };
}

function hardenedCompanyState() {
  const s = companyStore();
  const base = s.state();
  return {
    ...base,
    workspaces: (base.workspaces || [])
      .filter((workspace) => Boolean(s.localRole(workspace)))
      .map((workspace) => safeWorkspaceForState(s, workspace)),
  };
}

function signedPortableInvite({ workspaceId, email = '', displayName = '', role = 'viewer' } = {}) {
  const s = companyStore();
  const workspace = s.findWorkspace(workspaceId);
  if (!workspace) throw new Error('Workspace not found.');
  assertWorkspaceManager(s, workspace);
  if (!ROLES.has(role) || role === 'owner') throw new Error('Invalid invite role.');

  const result = s.inviteMember({ workspaceId, email, displayName, role });
  const nextWorkspace = result.workspace;
  const identity = s.getOrCreateIdentity();
  const invited = [...(nextWorkspace.members || [])]
    .reverse()
    .find((member) => member.status === 'invited' && (!email || String(member.email || '').toLowerCase() === String(email).toLowerCase()));

  const invite = signedPayload({
    kind: 'chunknet-company-invite',
    version: 3,
    workspaceId: nextWorkspace.workspaceId,
    email: email || invited?.email || '',
    displayName: displayName || invited?.displayName || email || 'Invited member',
    role: role || invited?.role || 'viewer',
    invitedMemberId: invited?.memberId || '',
    workspaceSignature: nextWorkspace.signature,
    createdAt: now(),
    workspace: nextWorkspace,
  }, identity);

  return {
    ...result,
    inviteToken: encodeChunknetToken('invite', invite),
    portableInvite: true,
    signedInvite: true,
  };
}

function hardenedJoinWorkspace({ inviteToken, displayName = '', email = '' } = {}) {
  const parsed = decodeChunknetToken(inviteToken);
  if (parsed.kind !== 'invite') throw new Error('Expected company invite token.');
  const invite = parsed.payload;
  assertSignedPayload(invite, 'company invite');

  const s = companyStore();
  const workspaceId = String(invite.workspaceId || invite.workspace?.workspaceId || '').trim();
  if (!workspaceId) throw new Error('Invite token missing workspaceId.');

  const importedWorkspace = invite.workspace && typeof invite.workspace === 'object' ? invite.workspace : null;
  if (!importedWorkspace) throw new Error('Signed invite token must include workspace data for portable join.');
  if (importedWorkspace.workspaceId !== workspaceId) throw new Error('Invite workspace mismatch.');
  if (!s.verifyWorkspace(importedWorkspace)) throw new Error('Invited workspace signature is invalid.');

  const signer = memberBySigner(importedWorkspace, invite);
  if (!roleCanManage(signer?.role)) throw new Error('Invite signer is not allowed to manage this workspace.');

  const role = ROLES.has(invite.role) && invite.role !== 'owner' ? invite.role : 'viewer';
  const existing = s.findWorkspace(workspaceId, { includeDeleted: true });
  const base = existing || importedWorkspace;
  const identity = s.getOrCreateIdentity({
    displayName: displayName || invite.displayName || email || invite.email || 'Company Member',
    email: email || invite.email || '',
  });

  const invitedMemberId = String(invite.invitedMemberId || '').trim();
  const members = Array.isArray(base.members) ? base.members : [];
  let claimed = false;
  const nextMembers = members.map((member) => {
    const matchingInvite =
      (invitedMemberId && member.memberId === invitedMemberId) ||
      (!member.deviceId && invite.email && String(member.email || '').toLowerCase() === String(invite.email).toLowerCase());

    if (!claimed && matchingInvite) {
      claimed = true;
      return {
        ...member,
        deviceId: identity.deviceId,
        displayName: displayName || member.displayName || identity.displayName || 'Company Member',
        email: email || member.email || identity.email || invite.email || '',
        role: member.role === 'owner' ? 'owner' : (member.role || role),
        status: 'active',
        publicKeyPem: identity.publicKeyPem,
        joinedAt: member.joinedAt || now(),
        updatedAt: now(),
      };
    }

    return member;
  });

  if (!claimed) throw new Error('Invite token does not match a pending workspace invitation. Ask an admin to issue a new invite.');

  const next = s.signWorkspace({
    ...base,
    workspaceId,
    status: 'active',
    folders: normalizeFolders(base.folders || [], workspaceId),
    members: nextMembers,
    audit: [
      ...(Array.isArray(base.audit) ? base.audit : []),
      { at: now(), action: 'workspace:join', byDeviceId: identity.deviceId, role, email: email || invite.email || '' },
    ],
  });

  s.replaceWorkspace(next, { includeDeleted: true });
  return { ok: true, workspace: safeWorkspaceForState(s, next), deviceIdentity: s.publicIdentity() };
}

function workspaceIdFromPayload(payload = {}) { return String(payload.workspaceId || payload.companyId || payload.id || payload.details?.workspaceId || '').trim(); }
function auditIdFor(workspaceId, event = {}, index = 0) { return event.auditId ? String(event.auditId) : sha256(Buffer.from(JSON.stringify({ workspaceId, event, index }))).slice(0, 32); }
function normalizeAuditEvent(workspace = {}, event = {}, index = 0) {
  const workspaceId = String(workspace.workspaceId || workspace.companyId || '').trim();
  const details = event.details && typeof event.details === 'object' ? { ...event.details } : {};
  if (!details.workspaceId) details.workspaceId = workspace.workspaceId;
  if (!details.workspaceName) details.workspaceName = workspace.name;
  return {
    auditId: auditIdFor(workspaceId, event, index),
    action: String(event.action || 'audit:event'),
    actor: String(event.actor || event.byDeviceId || event.byWallet || event.deviceId || event.wallet || workspace.signedByDeviceId || workspace.ownerDeviceId || ''),
    at: event.at || event.createdAt || event.updatedAt || workspace.updatedAt || new Date(0).toISOString(),
    details,
    p2p: event.p2p || null,
  };
}

function hardenedAuditList(payload = {}) {
  const s = companyStore();
  const targetWorkspaceId = workspaceIdFromPayload(payload);
  const limit = Math.max(1, Math.min(1000, Number(payload.limit || 200)));
  const workspaces = targetWorkspaceId
    ? [s.findWorkspace(targetWorkspaceId, { includeDeleted: true })].filter(Boolean)
    : s.listWorkspaces({ includeDeleted: true }).filter((workspace) => Boolean(s.localRole(workspace)));

  if (targetWorkspaceId && !workspaces.length) throw new Error('Company workspace not found.');
  for (const workspace of workspaces) assertWorkspaceMember(s, workspace);

  const events = workspaces
    .flatMap((workspace) => (Array.isArray(workspace.audit) ? workspace.audit : []).map((event, index) => normalizeAuditEvent(workspace, event, index)))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  return { ok: true, events, count: events.length, workspaceId: targetWorkspaceId };
}

function hardenedAuditRecord(payload = {}) {
  const s = companyStore();
  const workspaceId = workspaceIdFromPayload(payload);
  const workspace = workspaceId ? s.findWorkspace(workspaceId, { includeDeleted: true }) : s.listWorkspaces({ includeDeleted: false }).find((item) => Boolean(s.localRole(item)));
  if (!workspace) return { ok: true, skipped: 'no-company-workspace', events: [] };
  assertWorkspaceMember(s, workspace);

  const identity = s.getOrCreateIdentity();
  const event = {
    auditId: `audit_${crypto.randomUUID()}`,
    at: now(),
    action: String(payload.action || 'audit:record'),
    actor: identity.deviceId,
    byDeviceId: identity.deviceId,
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
    p2p: payload.p2p || null,
  };
  const next = s.signWorkspace({ ...workspace, audit: [...(Array.isArray(workspace.audit) ? workspace.audit : []), event] });
  s.replaceWorkspace(next, { includeDeleted: true });
  return { ok: true, event: normalizeAuditEvent(next, event, next.audit.length - 1), ...hardenedAuditList({ workspaceId: next.workspaceId, limit: payload.limit || 200 }) };
}

async function replicateCompanyObjectChunk(chunkPayload, { replicas = 4 } = {}) {
  const node = transportNode();
  if (!node?.putChunkOnNetwork || !node?.selectReplicaTargets) {
    return { attempted: false, reason: 'P2P transport node is not globally exposed yet.' };
  }
  try {
    const targets = node.selectReplicaTargets({ exclude: [], limit: replicas });
    if (!targets?.length) return { attempted: true, ok: false, reason: 'No healthy connected peers available.' };
    const result = await node.putChunkOnNetwork(chunkPayload, targets);
    return { attempted: true, ok: true, targets, result };
  } catch (error) {
    return { attempted: true, ok: false, error: error?.message || String(error) };
  }
}

async function storeCompanyObject({ kind, token, payload = null, workspaceId = '', note = '', replicate = true } = {}) {
  const parsed = token ? decodeChunknetToken(token) : null;
  const objectKind = kind || parsed?.kind || payload?.kind || 'company-object';
  const objectPayload = payload || parsed?.payload || token;
  const resolvedWorkspaceId = workspaceId || objectPayload?.workspaceId || objectPayload?.workspace?.workspaceId || objectPayload?.invite?.workspaceId || '';

  if (resolvedWorkspaceId) {
    const s = companyStore();
    const workspace = s.findWorkspace(resolvedWorkspaceId, { includeDeleted: true });
    if (!workspace) throw new Error('Company workspace not found.');
    assertWorkspaceMember(s, workspace);
  }

  const object = {
    objectType: 'chunknet-company-object-v1',
    kind: objectKind,
    workspaceId: resolvedWorkspaceId,
    token: token || encodeChunknetToken(objectKind, objectPayload),
    payload: objectPayload,
    note,
    createdAt: now(),
  };
  const data = Buffer.from(JSON.stringify(object), 'utf8');
  const hash = sha256(data);
  const chunkPayload = { hash, data: data.toString('base64'), index: 0, size: data.length, ownerWallet: 'company-object', encrypted: false, objectType: object.objectType, kind: object.kind, workspaceId: object.workspaceId };
  writeJson(objectPath(hash), { ...object, hash, size: data.length });
  writeJson(chunkPath(hash), { ...chunkPayload, storedAt: now() });
  const replication = replicate ? await replicateCompanyObjectChunk(chunkPayload) : { attempted: false, reason: 'Replication disabled by caller.' };
  return { ok: true, hash, uri: `chunknet://object/${hash}`, object: { ...object, hash, size: data.length }, chunk: chunkPayload, replication };
}

async function fetchCompanyObjectFromTransport(hash) {
  const node = transportNode();
  if (!node?.fetchChunkFromNetwork) return { attempted: false, reason: 'P2P transport node is not globally exposed yet.' };
  try {
    const chunk = await node.fetchChunkFromNetwork(hash);
    if (chunk?.data) {
      writeJson(chunkPath(hash), { ...chunk, storedAt: now() });
      return { attempted: true, ok: true, chunk };
    }
    return { attempted: true, ok: false, reason: 'No chunk data returned.' };
  } catch (error) {
    return { attempted: true, ok: false, error: error?.message || String(error) };
  }
}

async function readCompanyObject({ hashOrUri, fetchFromPeers = true } = {}) {
  const raw = String(hashOrUri || '').trim();
  const hash = raw.startsWith('chunknet://object/') ? raw.replace('chunknet://object/', '') : raw;
  if (!safeHash(hash)) throw new Error('Object hash is required.');
  const localPath = objectPath(hash);
  if (fs.existsSync(localPath)) return { ok: true, source: 'object-store', object: readJson(localPath) };
  const cp = chunkPath(hash);
  let peerFetch = null;
  if (!fs.existsSync(cp) && fetchFromPeers) peerFetch = await fetchCompanyObjectFromTransport(hash);
  if (!fs.existsSync(cp)) throw new Error(peerFetch?.reason || peerFetch?.error || 'Company object not found locally yet. Connect peers or import token manually.');
  const chunk = readJson(cp);
  const object = JSON.parse(Buffer.from(chunk.data, 'base64').toString('utf8'));
  writeJson(localPath, { ...object, hash, size: chunk.size });
  return { ok: true, source: 'chunk-store', object: { ...object, hash, size: chunk.size }, peerFetch };
}

async function tokenFromCompanyObject({ hashOrUri } = {}) {
  const result = await readCompanyObject({ hashOrUri });
  const workspaceId = result.object?.workspaceId || result.object?.payload?.workspaceId || result.object?.payload?.workspace?.workspaceId || '';
  if (workspaceId) {
    const s = companyStore();
    const workspace = s.findWorkspace(workspaceId, { includeDeleted: true });
    if (!workspace) throw new Error('Company workspace not found.');
    assertWorkspaceMember(s, workspace);
  }
  return { ok: true, token: result.object.token, object: result.object };
}

function installDistributedObjectIpc() {
  for (const channel of [
    'company:state',
    'company:inviteMember',
    'company:joinWorkspace',
    'company:publishObject',
    'company:readObject',
    'company:tokenFromObject',
    'audit:list',
    'audit:record',
  ]) {
    try { ipcMain.removeHandler(channel); } catch {}
  }

  ipcMain.handle('company:state', async () => hardenedCompanyState());
  ipcMain.handle('company:inviteMember', async (_event, payload = {}) => signedPortableInvite(payload));
  ipcMain.handle('company:joinWorkspace', async (_event, payload = {}) => hardenedJoinWorkspace(payload));
  ipcMain.handle('company:publishObject', async (_event, payload = {}) => storeCompanyObject(payload));
  ipcMain.handle('company:readObject', async (_event, payload = {}) => readCompanyObject(payload));
  ipcMain.handle('company:tokenFromObject', async (_event, payload = {}) => tokenFromCompanyObject(payload));
  ipcMain.handle('audit:list', async (_event, payload = {}) => hardenedAuditList(payload));
  ipcMain.handle('audit:record', async (_event, payload = {}) => hardenedAuditRecord(payload));

  console.log('[company] level 3 distributed object IPC installed with backend permission hardening');
}

installDistributedObjectIpc();
