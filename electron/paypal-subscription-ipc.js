import { BrowserWindow, ipcMain } from 'electron';

const DEFAULT_PAYPAL_CHECKOUT_URL = 'http://54.166.171.208:8791';
const DEFAULT_RETURN_URL = 'https://example.com/chunknet-payment-success';
const DEFAULT_CANCEL_URL = 'https://example.com/chunknet-payment-cancel';

function cleanUrl(value = '', fallback = '') {
  try {
    const url = new URL(String(value || fallback).trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function checkoutBaseUrl() {
  return cleanUrl(
    process.env.PAYPAL_CHECKOUT_URL || process.env.P2P_PAYPAL_CHECKOUT_URL || process.env.VITE_PAYPAL_CHECKOUT_URL,
    DEFAULT_PAYPAL_CHECKOUT_URL
  );
}

function returnUrl() {
  return cleanUrl(process.env.PAYPAL_RETURN_URL || process.env.P2P_PAYPAL_RETURN_URL, DEFAULT_RETURN_URL);
}

function cancelUrl() {
  return cleanUrl(process.env.PAYPAL_CANCEL_URL || process.env.P2P_PAYPAL_CANCEL_URL, DEFAULT_CANCEL_URL);
}

function normalizeIdentity(identity = '') {
  return String(identity || '').trim().toLowerCase();
}

function isValidPaidIdentity(identity = '') {
  const value = normalizeIdentity(identity);
  return /^0x[a-f0-9]{40}$/.test(value) || /^seed:[a-z0-9][a-z0-9:_@.\-]{2,191}$/i.test(value);
}

function paidIdentityFromPayload(payload = {}) {
  return normalizeIdentity(payload.wallet || payload.accountId || payload.identity || payload.address || payload.username);
}

async function postJson(pathname, body = {}) {
  const endpoint = `${checkoutBaseUrl()}${pathname}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `PayPal request failed: ${response.status}`);
  return data;
}

async function createSubscription(payload = {}) {
  const identity = paidIdentityFromPayload(payload);
  if (!isValidPaidIdentity(identity)) throw new Error('Valid wallet or seed account identity required');
  const planId = String(payload.planId || '').trim();
  if (!planId) throw new Error('PayPal planId is required');

  return postJson('/paypal/create-subscription', {
    ...payload,
    wallet: identity,
    accountId: identity,
    identity,
  });
}

async function confirmSubscription(payload = {}) {
  const identity = paidIdentityFromPayload(payload);
  if (!isValidPaidIdentity(identity)) throw new Error('Valid wallet or seed account identity required');
  const subscriptionId = String(payload.subscriptionId || payload.orderId || payload.id || '').trim();
  if (!subscriptionId) throw new Error('PayPal subscription id required');

  return postJson('/paypal/confirm-subscription', {
    ...payload,
    subscriptionId,
    orderId: payload.orderId || subscriptionId,
    wallet: identity,
    accountId: identity,
    identity,
  });
}

async function openCheckout(payload = {}) {
  const approveUrl = cleanUrl(payload.approveUrl || payload.approvalUrl || payload.checkoutUrl, '');
  if (!approveUrl) throw new Error('PayPal approveUrl is required');

  const win = new BrowserWindow({
    title: 'Chunknet PayPal Checkout',
    width: 980,
    height: 760,
    show: true,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const successUrl = payload.returnUrl || returnUrl();
  const failUrl = payload.cancelUrl || cancelUrl();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      resolve(result);
    };

    win.on('closed', () => done({ ok: false, cancelled: true }));
    win.webContents.on('will-redirect', (_event, url) => {
      if (String(url || '').startsWith(successUrl)) done({ ok: true, url });
      if (String(url || '').startsWith(failUrl)) done({ ok: false, cancelled: true, url });
    });
    win.webContents.on('did-navigate', (_event, url) => {
      if (String(url || '').startsWith(successUrl)) done({ ok: true, url });
      if (String(url || '').startsWith(failUrl)) done({ ok: false, cancelled: true, url });
    });
    win.loadURL(approveUrl).catch((error) => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      reject(error);
    });
  });
}

function installPayPalSubscriptionIpc() {
  for (const channel of ['paypal:createSubscription', 'paypal:openCheckout', 'paypal:confirmSubscription']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }

  ipcMain.handle('paypal:createSubscription', async (_event, payload = {}) => createSubscription(payload));
  ipcMain.handle('paypal:openCheckout', async (_event, payload = {}) => openCheckout(payload));
  ipcMain.handle('paypal:confirmSubscription', async (_event, payload = {}) => confirmSubscription(payload));
  console.log('[paypal-subscription-ipc] installed: renderer PayPal network requests moved to main process');
}

installPayPalSubscriptionIpc();
