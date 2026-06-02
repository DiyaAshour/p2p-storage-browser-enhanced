#!/usr/bin/env node
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverIp = process.env.CHUNKNET_SERVER_IP || '54.166.171.208';
const sshUser = process.env.CHUNKNET_SSH_USER || 'ubuntu';
const sshKey = process.env.CHUNKNET_SSH_KEY || 'C:\\aaa\\P2P.pem';

function setDefault(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function parseEnvLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const index = trimmed.indexOf('=');
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
}

function loadLocalEnv(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (!process.env[key]) {
      process.env[key] = value;
      count += 1;
    }
  }
  console.log(`[cloud-dev] Loaded ${count} value(s) from ${fileName}.`);
  return true;
}

function runOptionalScript(scriptPath) {
  const absolutePath = path.resolve(process.cwd(), scriptPath);
  if (!fs.existsSync(absolutePath)) return;
  const result = spawnSync(process.execPath, [absolutePath], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  if (result.status) {
    throw new Error(`${scriptPath} failed with exit code ${result.status}`);
  }
}

loadLocalEnv('.env.local');
loadLocalEnv('.env');

setDefault('P2P_TARGET_REPLICAS', '3');
setDefault('P2P_BOOTSTRAP_URL', `ws://${serverIp}:8788`);
setDefault('P2P_MANIFEST_SYNC_URL', `http://${serverIp}:8790`);
setDefault('P2P_MANIFEST_SYNC_DISABLED', 'false');
setDefault('P2P_SAFETY_PEER_URL', `ws://${serverIp}:8792`);
setDefault('P2P_SAFETY_PEER_MODE', 'emergency');
setDefault('P2P_TRANSPORT_PORT', '8787');
setDefault('P2P_TRANSPORT_HOST', '0.0.0.0');
setDefault('PAYPAL_CHECKOUT_URL', `http://${serverIp}:8791`);
setDefault('VITE_PAYPAL_CHECKOUT_URL', process.env.PAYPAL_CHECKOUT_URL);
setDefault('PAYPAL_RETURN_URL', 'https://example.com/chunknet-payment-success');
setDefault('PAYPAL_CANCEL_URL', 'https://example.com/chunknet-payment-cancel');

runOptionalScript('scripts/apply-paypal-checkout-runtime.cjs');
runOptionalScript('scripts/apply-paypal-subscriptions-runtime.cjs');
runOptionalScript('scripts/apply-audit-ipc-runtime.cjs');

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
console.log('[cloud-dev] PayPal:   ', process.env.PAYPAL_CHECKOUT_URL, process.env.PAYPAL_ENV || 'sandbox', process.env.PAYPAL_CLIENT_ID ? 'configured' : 'remote');

const child = process.platform === 'win32'
  ? spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm run electron:dev:raw'], {
      stdio: 'inherit',
      env: process.env,
      shell: false,
      windowsHide: false,
    })
  : spawn('pnpm', ['run', 'electron:dev:raw'], {
      stdio: 'inherit',
      env: process.env,
      shell: false,
    });

child.on('error', (error) => {
  console.error('[cloud-dev] Failed to start electron:dev:raw:', error.message || error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
