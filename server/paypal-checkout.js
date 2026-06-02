import http from 'node:http';
import crypto from 'node:crypto';

function envText(name, fallback = '') {
  return String(process.env[name] ?? fallback).replace(/\r/g, '').trim();
}

function envBool(name, fallback = false) {
  const value = envText(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function safeUrl(value, fallback) {
  const raw = envText('', value || fallback);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL protocol');
    return url.toString();
  } catch {
    return fallback;
  }
}

const PORT = Number(envText('PAYPAL_CHECKOUT_PORT', process.env.PAYPAL_PORT || '8791'));
const HOST = envText('PAYPAL_CHECKOUT_HOST', '0.0.0.0');
const PAYPAL_ENV = envText('PAYPAL_ENV', 'sandbox').toLowerCase();
const PAYPAL_CLIENT_ID = envText('PAYPAL_CLIENT_ID');
const PAYPAL_CLIENT_SECRET = envText('PAYPAL_CLIENT_SECRET');
const PAYPAL_API = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const RETURN_URL = safeUrl(process.env.PAYPAL_RETURN_URL, 'https://example.com/chunknet-payment-success');
const CANCEL_URL = safeUrl(process.env.PAYPAL_CANCEL_URL, 'https://example.com/chunknet-payment-cancel');
const ALLOW_LOCAL_FALLBACK = envBool('PAYPAL_ALLOW_LOCAL_FALLBACK', false);
const MAX_BODY_BYTES = 1024 * 1024;
const PLAN_UNLOCK_VERSION = 'plan-unlock-hmac-sha256-v1';
const PLAN_UNLOCK_SECRET = envText('P2P_PLAN_UNLOCK_SECRET', process.env.PLAN_UNLOCK_SECRET || '');
const GB = 1024 ** 3;
const TB = 1024 ** 4;

const PLANS = {
  trial: { id: 'trial', name: 'Trial', quotaBytes: 10 * GB, priceUsd: 0, trialDays: 7, locked: false, description: '10 GB trial for 7 days' },
  starter: { id: 'starter', name: 'Starter', quotaBytes: 100 * GB, priceUsd: 2.99, locked: true, description: '100 GB storage plan' },
  personal: { id: 'personal', name: 'Personal', quotaBytes: 1 * TB, priceUsd: 7.99, locked: true, description: '1 TB storage plan' },
  plus: { id: 'plus', name: 'Plus', quotaBytes: 3 * TB, priceUsd: 14.99, locked: true, description: '3 TB storage plan' },
  pro: { id: 'pro', name: 'Pro', quotaBytes: 7 * TB, priceUsd: 24.99, locked: true, description: '7 TB storage plan' },
  ultra: { id: 'ultra', name: 'Ultra', quotaBytes: 10 * TB, priceUsd: 34.99, locked: true, description: '10 TB storage plan' },
};

const PLAN_ALIASES = {
  free: 'trial', trial: 'trial', demo: 'trial',
  starter: 'starter', '100gb': 'starter', '100_gb': 'starter', '100-gb': 'starter',
  personal: 'personal', tb1: 'personal', '1tb': 'personal', '1_tb': 'personal', '1-tb': 'personal', plan1tb: 'personal', 'plan-1tb': 'personal', '1': 'personal',
  plus: 'plus', tb3: 'plus', '3tb': 'plus', '3_tb': 'plus', '3-tb': 'plus', plan3tb: 'plus', 'plan-3tb': 'plus', '3': 'plus',
  pro: 'pro', tb7: 'pro', '7tb': 'pro', '7_tb': 'pro', '7-tb': 'pro', plan7tb: 'pro', 'plan-7tb': 'pro', '7': 'pro',
  ultra: 'ultra', tb10: 'ultra', '10tb': 'ultra', '10_tb': 'ultra', '10-tb': 'ultra', plan10tb: 'ultra', 'plan-10tb': 'ultra', '10': 'ultra',
};

const pendingOrders = new Map();

function normalizeIdentity(identity = '') {
  return String(identity || '').trim().toLowerCase();
}

function isValidPaidIdentity(identity = '') {
  const value = normalizeIdentity(identity);
  return /^0x[a-f0-9]{40}$/.test(value) || /^seed:[a-z0-9][a-z0-9:_@.\-]{2,191}$/i.test(value);
}

function paidIdentityFromPayload(body = {}) {
  return normalizeIdentity(body.wallet || body.accountId || body.identity || body.walletAddress || body.address || body.seedAccount || body.username);
}

function resolvePlan(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  const planId = PLAN_ALIASES[key] || key;
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Subscription plan does not exist: ${value || 'missing'}`);
  return plan;
}

function planUnlockPayload({ wallet, planId, paidUntil, orderId }) {
  return JSON.stringify({ version: PLAN_UNLOCK_VERSION, wallet: normalizeIdentity(wallet), planId: String(planId || '').trim(), paidUntil: Number(paidUntil || 0), orderId: String(orderId || '').trim() });
}

function signPlanUnlock(payload) {
  if (!PLAN_UNLOCK_SECRET) throw new Error('Plan unlock secret is not configured');
  return crypto.createHmac('sha256', PLAN_UNLOCK_SECRET).update(planUnlockPayload(payload)).digest('hex');
}

function timingSafeEqualText(a = '', b = '') {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function verifyPlanUnlockToken({ wallet, planId, paidUntil, orderId, planUnlockToken }) {
  const resolvedPlan = resolvePlan(planId);
  if (Number(resolvedPlan.priceUsd || 0) <= 0) throw new Error('Only paid plans can be unlocked by payment token');
  const identity = normalizeIdentity(wallet);
  if (!isValidPaidIdentity(identity)) throw new Error('Valid paid wallet or seed account identity required');
  const expiry = Number(paidUntil || 0);
  if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new Error('Plan unlock is expired');
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw new Error('PayPal order id required');
  const token = String(planUnlockToken || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Plan unlock token is missing or invalid');
  const expected = signPlanUnlock({ wallet: identity, planId: resolvedPlan.id, paidUntil: expiry, orderId: normalizedOrderId });
  if (!timingSafeEqualText(token, expected)) throw new Error('Plan unlock token verification failed');
  return { wallet: identity, planId: resolvedPlan.id, paidUntil: expiry, orderId: normalizedOrderId };
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8') || '{}'; try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

function approvalLink(order) {
  return order?.links?.find?.((link) => String(link.rel || '').toLowerCase() === 'approve')?.href || '';
}

function hasPayPalCredentials() {
  return Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);
}

async function paypalToken() {
  if (!hasPayPalCredentials()) throw new Error('PayPal credentials are not configured');
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `PayPal token failed: ${response.status}`);
  return data.access_token;
}

async function createRealPayPalOrder(plan, wallet) {
  const token = await paypalToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: plan.id, description: `Chunknet ${plan.name} storage plan for ${wallet}`, custom_id: JSON.stringify({ wallet, planId: plan.id }), amount: { currency_code: 'USD', value: Number(plan.priceUsd).toFixed(2) } }],
      application_context: { brand_name: 'Chunknet', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: RETURN_URL, cancel_url: CANCEL_URL },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[paypal-checkout] create order failed', JSON.stringify({ status: response.status, data }, null, 2));
    throw new Error((data?.message || data?.name || `PayPal create order failed: ${response.status}`) + ' :: ' + JSON.stringify(data));
  }
  return data;
}

async function captureRealPayPalOrder(orderId) {
  const token = await paypalToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[paypal-checkout] capture failed', JSON.stringify({ status: response.status, data }, null, 2));
    throw new Error((data?.message || data?.name || `PayPal capture failed: ${response.status}`) + ' :: ' + JSON.stringify(data));
  }
  return data;
}

function oneMonthFromNowSeconds() {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
}

async function handleCreateOrder(req, res) {
  const body = await readBody(req);
  const plan = resolvePlan(body.planId || body.plan || body.subscriptionPlan || body.selectedPlan);
  if (Number(plan.priceUsd || 0) <= 0) throw new Error(`${plan.name} does not require PayPal checkout`);
  const wallet = paidIdentityFromPayload(body);
  if (!isValidPaidIdentity(wallet)) throw new Error('Valid paid wallet or seed account identity required');
  let order;
  if (hasPayPalCredentials()) {
    order = await createRealPayPalOrder(plan, wallet);
  } else if (ALLOW_LOCAL_FALLBACK) {
    const orderId = `local-paypal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    order = { id: orderId, status: 'CREATED', links: [{ rel: 'approve', href: `https://www.paypal.com/checkoutnow?token=${encodeURIComponent(orderId)}` }], localFallback: true };
  } else {
    throw new Error('PayPal credentials are not configured');
  }
  const orderId = String(order.id || '');
  const approveUrl = approvalLink(order);
  if (!orderId || !approveUrl) throw new Error('PayPal did not return an approval link');
  pendingOrders.set(orderId, { orderId, wallet, planId: plan.id, createdAt: new Date().toISOString(), priceUsd: plan.priceUsd });
  return send(res, 200, { ok: true, orderId, id: orderId, approveUrl, approvalUrl: approveUrl, checkoutUrl: approveUrl, planId: plan.id, plan, wallet, paypal: order });
}

async function handleCaptureOrder(req, res) {
  const body = await readBody(req);
  const orderId = String(body.orderId || body.id || body.token || '').trim();
  if (!orderId) throw new Error('PayPal order id required');
  const requestedPlan = body.planId || body.plan || body.subscriptionPlan;
  const wallet = paidIdentityFromPayload(body);
  const pending = pendingOrders.get(orderId);
  let capture = null;
  if (hasPayPalCredentials() && !orderId.startsWith('local-paypal-')) {
    capture = await captureRealPayPalOrder(orderId);
    const status = String(capture.status || '').toUpperCase();
    if (status && status !== 'COMPLETED') throw new Error(`PayPal payment not completed: ${status}`);
  }
  const plan = resolvePlan(requestedPlan || pending?.planId);
  if (Number(plan.priceUsd || 0) <= 0) throw new Error(`${plan.name} does not require PayPal capture`);
  if (pending?.planId && pending.planId !== plan.id) throw new Error('Subscription plan does not match selected app plan');
  if (pending?.wallet && wallet && pending.wallet !== wallet) throw new Error('Wallet or seed account identity does not match pending PayPal order');
  const paidUntil = oneMonthFromNowSeconds();
  const unlockWallet = wallet || pending?.wallet;
  if (!isValidPaidIdentity(unlockWallet)) throw new Error('Valid paid wallet or seed account identity required');
  const planUnlockToken = signPlanUnlock({ wallet: unlockWallet, planId: plan.id, paidUntil, orderId });
  pendingOrders.delete(orderId);
  return send(res, 200, { ok: true, captured: true, orderId, id: orderId, planId: plan.id, plan, wallet: unlockWallet, paidUntil, planUnlockVersion: PLAN_UNLOCK_VERSION, planUnlockToken, capture });
}

async function handleVerifyUnlock(req, res) {
  const body = await readBody(req);
  const verified = verifyPlanUnlockToken({ wallet: body.wallet || body.accountId || body.identity || body.walletAddress || body.address || body.seedAccount || body.username, planId: body.planId || body.plan || body.subscriptionPlan, paidUntil: body.paidUntil, orderId: body.orderId || body.paypalOrderId || body.subscriptionId || body.captureId || body.txHash, planUnlockToken: body.planUnlockToken || body.unlockToken });
  return send(res, 200, { ok: true, verified, planUnlockVersion: PLAN_UNLOCK_VERSION });
}

function router(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  if (req.method === 'GET' && (route === '/' || route === '/health')) return send(res, 200, { ok: true, service: 'p2p-cloud-paypal-checkout', env: PAYPAL_ENV, api: PAYPAL_API, configured: hasPayPalCredentials(), planUnlockConfigured: Boolean(PLAN_UNLOCK_SECRET), returnUrl: RETURN_URL, cancelUrl: CANCEL_URL, localFallback: ALLOW_LOCAL_FALLBACK, plans: Object.values(PLANS) });
  if (req.method === 'GET' && route === '/plans') return send(res, 200, { ok: true, plans: Object.values(PLANS), aliases: PLAN_ALIASES });
  if (req.method === 'POST' && ['/paypal/create-order', '/create-order', '/paypal/create', '/create'].includes(route)) return handleCreateOrder(req, res);
  if (req.method === 'POST' && ['/paypal/capture-order', '/capture-order', '/paypal/confirm', '/confirm'].includes(route)) return handleCaptureOrder(req, res);
  if (req.method === 'POST' && ['/paypal/verify-unlock', '/verify-unlock', '/paypal/verify', '/verify'].includes(route)) return handleVerifyUnlock(req, res);
  return send(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (error) {
    return send(res, 400, { ok: false, error: error?.message || 'PayPal checkout error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[paypal-checkout] listening on http://${HOST}:${PORT}`);
  console.log(`[paypal-checkout] env=${PAYPAL_ENV} api=${PAYPAL_API} configured=${hasPayPalCredentials()} planUnlockConfigured=${Boolean(PLAN_UNLOCK_SECRET)} localFallback=${ALLOW_LOCAL_FALLBACK}`);
  console.log(`[paypal-checkout] return=${RETURN_URL} cancel=${CANCEL_URL}`);
  console.log(`[paypal-checkout] plans=${Object.keys(PLANS).join(', ')}`);
});
