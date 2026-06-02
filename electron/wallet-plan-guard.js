import { ipcMain } from 'electron';
import crypto from 'node:crypto';

const INSTALLED = Symbol.for('chunknet.walletPlanGuardInstalled');
const ORIGINAL_HANDLE = Symbol.for('chunknet.walletPlanGuardOriginalHandle');
const PLAN_UNLOCK_VERSION = 'plan-unlock-hmac-sha256-v1';
const DEFAULT_PAYPAL_CHECKOUT_URL = 'http://54.166.171.208:8791';

function planUnlockSecret() {
  return String(process.env.P2P_PLAN_UNLOCK_SECRET || process.env.PLAN_UNLOCK_SECRET || '').trim();
}

function paypalCheckoutUrl() {
  return String(
    process.env.PAYPAL_CHECKOUT_URL ||
      process.env.VITE_PAYPAL_CHECKOUT_URL ||
      process.env.P2P_PAYPAL_CHECKOUT_URL ||
      DEFAULT_PAYPAL_CHECKOUT_URL
  ).replace(/\r/g, '').trim().replace(/\/+$/, '');
}

function normalizeIdentity(identity = '') {
  return String(identity || '').trim().toLowerCase();
}

function isValidPaidIdentity(identity = '') {
  const value = normalizeIdentity(identity);
  return /^0x[a-f0-9]{40}$/.test(value) || /^seed:[a-z0-9][a-z0-9:_@.\-]{2,191}$/i.test(value);
}

function timingSafeEqualText(a = '', b = '') {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function planUnlockPayload({ wallet, planId, paidUntil, orderId }) {
  return JSON.stringify({
    version: PLAN_UNLOCK_VERSION,
    wallet: normalizeIdentity(wallet),
    planId: String(planId || '').trim(),
    paidUntil: Number(paidUntil || 0),
    orderId: String(orderId || '').trim(),
  });
}

function signPlanUnlock(payload, secret = planUnlockSecret()) {
  if (!secret) throw new Error('Plan unlock secret is not configured');
  return crypto.createHmac('sha256', secret).update(planUnlockPayload(payload)).digest('hex');
}

function paidIdentityFromPayload(payload = {}) {
  return normalizeIdentity(
    payload.wallet ||
      payload.accountId ||
      payload.identity ||
      payload.walletAddress ||
      payload.address ||
      payload.seedAccount ||
      payload.username
  );
}

function basicValidatePaidPayload(payload = {}) {
  const planId = String(payload.planId || 'free').trim();
  if (planId === 'free') return;
  if (planId === 'trial') return null;

  const wallet = paidIdentityFromPayload(payload);
  if (!isValidPaidIdentity(wallet)) throw new Error('Paid plan unlock requires the paid wallet or seed account identity');

  const paidUntil = Number(payload.paidUntil || 0);
  if (!Number.isFinite(paidUntil) || paidUntil <= Math.floor(Date.now() / 1000)) {
    throw new Error('Paid plan unlock requires a future paidUntil timestamp');
  }

  const orderId = String(payload.orderId || payload.paypalOrderId || payload.subscriptionId || payload.captureId || payload.txHash || '').trim();
  if (!orderId) throw new Error('Paid plan unlock requires a PayPal order/subscription id, capture id, or contract tx hash');

  const token = String(payload.planUnlockToken || payload.unlockToken || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Paid plan unlock token is missing or invalid');

  return { wallet, planId, paidUntil, orderId, token };
}

async function verifyPlanUnlockRemotely(payload = {}) {
  const endpoint = `${paypalCheckoutUrl()}/paypal/verify-unlock`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Remote paid plan verification failed: ${response.status}`);
  }
}

async function verifyPlanUnlock(payload = {}) {
  const validated = basicValidatePaidPayload(payload);
  if (!validated) return;

  const secret = planUnlockSecret();
  if (secret) {
    const expected = signPlanUnlock(
      { wallet: validated.wallet, planId: validated.planId, paidUntil: validated.paidUntil, orderId: validated.orderId },
      secret
    );
    if (!timingSafeEqualText(validated.token, expected)) throw new Error('Paid plan unlock token verification failed');
    return;
  }

  await verifyPlanUnlockRemotely({
    wallet: validated.wallet,
    planId: validated.planId,
    paidUntil: validated.paidUntil,
    orderId: validated.orderId,
    planUnlockToken: validated.token,
  });
}

export function installWalletPlanGuard() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  if (!globalThis[ORIGINAL_HANDLE]) {
    globalThis[ORIGINAL_HANDLE] = ipcMain.handle.bind(ipcMain);
  }

  ipcMain.handle = (channel, listener) => {
    if (channel !== 'wallet:setPlan') return globalThis[ORIGINAL_HANDLE](channel, listener);

    return globalThis[ORIGINAL_HANDLE](channel, async (event, payload = {}) => {
      await verifyPlanUnlock(payload);
      return listener(event, payload);
    });
  };

  console.log('[wallet-plan-guard] installed: paid plans require server-verified unlock tokens');
}

installWalletPlanGuard();

export { PLAN_UNLOCK_VERSION, signPlanUnlock, verifyPlanUnlock };
