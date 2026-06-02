#!/usr/bin/env node
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');

const serverIp = process.env.CHUNKNET_SERVER_IP || '54.166.171.208';
const sshUser = process.env.CHUNKNET_SSH_USER || 'ubuntu';
const sshKey = process.env.CHUNKNET_SSH_KEY || 'C:\\aaa\\P2P.pem';

function setDefault(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

setDefault('P2P_TARGET_REPLICAS', '3');
setDefault('P2P_BOOTSTRAP_URL', `ws://${serverIp}:8788`);
setDefault('P2P_MANIFEST_SYNC_URL', `http://${serverIp}:8790`);
setDefault('P2P_MANIFEST_SYNC_DISABLED', 'false');
setDefault('P2P_SAFETY_PEER_URL', `ws://${serverIp}:8792`);
setDefault('P2P_SAFETY_PEER_MODE', 'emergency');
setDefault('P2P_TRANSPORT_PORT', '8787');
setDefault('P2P_TRANSPORT_HOST', '0.0.0.0');

if (!process.env.P2P_SAFETY_PEER_DELETE_TOKEN && fs.existsSync(sshKey)) {
  const result = spawnSync('ssh', ['-i', sshKey, `${sshUser}@${serverIp}`, 'cat /data/chunknet-data/storage-delete-token.txt'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const token = String(result.stdout || '').trim();
  if (token) {
    process.env.P2P_SAFETY_PEER_DELETE_TOKEN = token;
    process.env.STORAGE_PEER_ADMIN_TOKEN = token;
    console.log('[cloud-dev] Safety delete token loaded.');
  } else {
    console.warn('[cloud-dev] Safety delete token was not loaded. AWS safety delete may fail.');
  }
} else if (process.env.P2P_SAFETY_PEER_DELETE_TOKEN) {
  process.env.STORAGE_PEER_ADMIN_TOKEN ||= process.env.P2P_SAFETY_PEER_DELETE_TOKEN;
}

console.log('[cloud-dev] Bootstrap:', process.env.P2P_BOOTSTRAP_URL);
console.log('[cloud-dev] Manifest: ', process.env.P2P_MANIFEST_SYNC_URL);
console.log('[cloud-dev] Safety:   ', process.env.P2P_SAFETY_PEER_URL);
console.log('[cloud-dev] Replicas: ', process.env.P2P_TARGET_REPLICAS);

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(command, ['run', 'electron:dev:raw'], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
