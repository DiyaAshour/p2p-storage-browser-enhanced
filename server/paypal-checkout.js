import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
const PAYPAL_WEBHOOK_ID = envText('PAYPAL_WEBHOOK_ID');
const PAYPAL_API = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const RETURN_URL = safeUrl(process.env.PAYPAL_RETURN_URL, 'https://example.com/chunknet-payment-success');
const CANCEL_URL = safeUrl(process.env.PAYPAL_CANCEL_URL, 'https://example.com/chunknet-payment-cancel');
const ALLOW_LOCAL_FALLBACK = envBool('PAYPAL_ALLOW_LOCAL_FALLBACK', false);
const MAX_BODY_BYTES = 1024 * 1024;
const PLAN_UNLOCK_VERSION = 'plan-unlock-hmac-sha256-v1';
const PLAN_UNLOCK_SECRET = envText('P2P_PLAN_UNLOCK_SECRET', process.env.PLAN_UNLOCK_SECRET || '');
const STATE_DIR = envText('PAYPAL_STATE_DIR', path.join(process.cwd(), 'paypal-state'));
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

function statePath(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, name);
}

function readState(name, fallback) {
  try {
    const file = statePath(name);
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeState(name, value) {
  const file = statePath(name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  return value;
}

function planCache() {
  return readState('paypal-plan-cache.json', { productId: '', planIds: {} });
}

function savePlanCache(cache) {
  return writeState('paypal-plan-cache.json', cache);
}

function subscriptionStore() {
  return readState('paypal-subscriptions.json', { subscriptions: {} });
}

function saveSubscriptionStore(store) {
  return writeState('paypal-subscriptions.json', store);
}

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
  if (!normalizedOrderId) throw new Error('PayPal order/subscription id required');
  const token = String(planUnlockToken || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Plan unlock token is missing or invalid');
  const expected = signPlanUnlock({ wallet: identity, planId: resolvedPlan.id, paidUntil: expiry, orderId: normalizedOrderId });
  if (!timingSafeEqualText(token, expected)) throw new Error('Plan unlock token verification failed');
  return { wallet: identity, planId: resolvedPlan.id, paidUntil: expiry, orderId: normalizedOrderId };
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,paypal-auth-algo,paypal-cert-url,paypal-transmission-id,paypal-transmission-sig,paypal-transmission-time' });
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

async function paypalRequest(pathname, { method = 'GET', body, headers = {}, prefer = 'return=representation' } = {}) {
  const token = await paypalToken();
  const response = await fetch(`${PAYPAL_API}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', prefer, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[paypal-checkout] PayPal API failed', JSON.stringify({ method, pathname, status: response.status, data }, null, 2));
    throw new Error((data?.message || data?.name || `PayPal API failed: ${response.status}`) + ' :: ' + JSON.stringify(data));
  }
  return data;
}

async function ensurePayPalProductId() {
  const envProductId = envText('PAYPAL_PRODUCT_ID');
  if (envProductId) return envProductId;
  const cache = planCache();
  if (cache.productId) return cache.productId;
  const product = await paypalRequest('/v1/catalogs/products', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `chunknet-product-${PAYPAL_ENV}` },
    body: { name: 'Chunknet Storage', description: 'Chunknet encrypted P2P cloud storage subscriptions', type: 'DIGITAL', category: 'SOFTWARE' },
  });
  cache.productId = product.id;
  savePlanCache(cache);
  return product.id;
}

async function ensurePayPalBillingPlanId(plan) {
  const envPlanId = envText(`PAYPAL_PLAN_${String(plan.id).toUpperCase()}_ID`);
  if (envPlanId) return envPlanId;
  const cache = planCache();
  if (cache.planIds?.[plan.id]) return cache.planIds[plan.id];
  const productId = await ensurePayPalProductId();
  const created = await paypalRequest('/v1/billing/plans', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': `chunknet-plan-${PAYPAL_ENV}-${plan.id}-${Number(plan.priceUsd).toFixed(2)}` },
    body: {
      product_id: productId,
      name: `Chunknet ${plan.name} Monthly`,
      description: `${plan.description} - monthly auto-renewing subscription`,
      status: 'ACTIVE',
      billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: Number(plan.priceUsd).toFixed(2), currency_code: 'USD' } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 3 },
    },
  });
  cache.productId = productId;
  cache.planIds = { ...(cache.planIds || {}), [plan.id]: created.id };
  savePlanCache(cache);
  return created.id;
}

function oneMonthFromNowSeconds() {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
}

function paidUntilFromSubscription(details = {}) {
  const nextBilling = details?.billing_info?.next_billing_time;
  const nextMs = nextBilling ? Date.parse(nextBilling) : NaN;
  if (Number.isFinite(nextMs) && nextMs > Date.now()) return Math.floor(nextMs / 1000) + 48 * 60 * 60;
  return oneMonthFromNowSeconds();
}

function saveSubscriptionRecord(record) {
  const store = subscriptionStore();
  store.subscriptions = store.subscriptions || {};
  store.subscriptions[record.subscriptionId] = { ...(store.subscriptions[record.subscriptionId] || {}), ...record, updatedAt: new Date().toISOString() };
  saveSubscriptionStore(store);
  return store.subscriptions[record.subscriptionId];
}

function findSubscriptionRecord({ subscriptionId = '', wallet = '' } = {}) {
  const store = subscriptionStore();
  const all = Object.values(store.subscriptions || {});
  if (subscriptionId && store.subscriptions?.[subscriptionId]) return store.subscriptions[subscriptionId];
  const identity = normalizeIdentity(wallet);
  return all.filter((item) => item && (!identity || item.wallet === identity)).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

async function showSubscription(subscriptionId) {
  return paypalRequest(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET' });
}

async function createPayPalSubscription(plan, wallet) {
  const paypalPlanId = await ensurePayPalBillingPlanId(plan);
  const subscription = await paypalRequest('/v1/billing/subscriptions', {
    method: 'POST',
    body: { plan_id: paypalPlanId, custom_id: JSON.stringify({ wallet, planId: plan.id }).slice(0, 127), application_context: { brand_name: 'Chunknet', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: RETURN_URL, cancel_url: CANCEL_URL } },
  });
  saveSubscriptionRecord({ subscriptionId: subscription.id, paypalPlanId, wallet, planId: plan.id, status: subscription.status || 'APPROVAL_PENDING', paidUntil: null, createdAt: new Date().toISOString() });
  return { ...subscription, paypalPlanId };
}

function subscriptionUnlockPayload({ subscription, record, plan, wallet }) {
  const status = String(subscription.status || record?.status || '').toUpperCase();
  if (!['ACTIVE'].includes(status)) throw new Error(`PayPal subscription is not active yet: ${status || 'unknown'}`);
  const paidUntil = paidUntilFromSubscription(subscription);
  const subscriptionId = String(subscription.id || record?.subscriptionId || '');
  const identity = normalizeIdentity(wallet || record?.wallet);
  if (!subscriptionId) throw new Error('Missing PayPal subscription id');
  if (!isValidPaidIdentity(identity)) throw new Error('Valid paid wallet or seed account identity required');
  const planUnlockToken = signPlanUnlock({ wallet: identity, planId: plan.id, paidUntil, orderId: subscriptionId });
  const saved = saveSubscriptionRecord({ ...(record || {}), subscriptionId, wallet: identity, planId: plan.id, status, paidUntil, lastPaypalStatus: subscription.status || status, nextBillingTime: subscription?.billing_info?.next_billing_time || null });
  return { ok: true, active: true, subscriptionId, orderId: subscriptionId, id: subscriptionId, planId: plan.id, plan, wallet: identity, paidUntil, planUnlockVersion: PLAN_UNLOCK_VERSION, planUnlockToken, subscription, record: saved, mode: 'subscription' };
}

async function createRealPayPalOrder(plan, wallet) {
  return paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    body: { intent: 'CAPTURE', purchase_units: [{ reference_id: plan.id, description: `Chunknet ${plan.name} storage plan for ${wallet}`, custom_id: JSON.stringify({ wallet, planId: plan.id }).slice(0, 127), amount: { currency_code: 'USD', value: Number(plan.priceUsd).toFixed(2) } }], application_context: { brand_name: 'Chunknet', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: RETURN_URL, cancel_url: CANCEL_URL } },
  });
}

async function captureRealPayPalOrder(orderId) {
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
}

async function handleCreateOrder(req, res) {
  const body = await readBody(req);
  const plan = resolvePlan(body.planId || body.plan || body.subscriptionPlan || body.selectedPlan);
  if (Number(plan.priceUsd || 0) <= 0) throw new Error(`${plan.name} does not require PayPal checkout`);
  const wallet = paidIdentityFromPayload(body);
  if (!isValidPaidIdentity(wallet)) throw new Error('Valid paid wallet or seed account identity required');
  let order;
  if (hasPayPalCredentials()) order = await createRealPayPalOrder(plan, wallet);
  else if (ALLOW_LOCAL_FALLBACK) { const orderId = `local-paypal-${Date.now()}-${Math.random().toString(16).slice(2)}`; order = { id: orderId, status: 'CREATED', links: [{ rel: 'approve', href: `https://www.paypal.com/checkoutnow?token=${encodeURIComponent(orderId)}` }], localFallback: true }; }
  else throw new Error('PayPal credentials are not configured');
  const orderId = String(order.id || '');
  const approveUrl = approvalLink(order);
  if (!orderId || !approveUrl) throw new Error('PayPal did not return an approval link');
  pendingOrders.set(orderId, { orderId, wallet, planId: plan.id, createdAt: new Date().toISOString(), priceUsd: plan.priceUsd });
  return send(res, 200, { ok: true, orderId, id: orderId, approveUrl, approvalUrl: approveUrl, checkoutUrl: approveUrl, planId: plan.id, plan, wallet, paypal: order, mode: 'order' });
}

async function handleCaptureOrder(req, res) {
  const body = await readBody(req);
  const orderId = String(body.orderId || body.id || body.token || '').trim();
  if (!orderId) throw new Error('PayPal order id required');
  const requestedPlan = body.planId || body.plan || body.subscriptionPlan;
  const wallet = paidIdentityFromPayload(body);
  const pending = pendingOrders.get(orderId);
  let capture = null;
  if (hasPayPalCredentials() && !orderId.startsWith('local-paypal-')) { capture = await captureRealPayPalOrder(orderId); const status = String(capture.status || '').toUpperCase(); if (status && status !== 'COMPLETED') throw new Error(`PayPal payment not completed: ${status}`); }
  const plan = resolvePlan(requestedPlan || pending?.planId);
  if (Number(plan.priceUsd || 0) <= 0) throw new Error(`${plan.name} does not require PayPal capture`);
  if (pending?.planId && pending.planId !== plan.id) throw new Error('Subscription plan does not match selected app plan');
  if (pending?.wallet && wallet && pending.wallet !== wallet) throw new Error('Wallet does not match pending PayPal order');
  const paidUntil = oneMonthFromNowSeconds();
  const unlockWallet = wallet || pending?.wallet;
  if (!isValidPaidIdentity(unlockWallet)) throw new Error('Valid paid wallet or seed account identity required');
  const planUnlockToken = signPlanUnlock({ wallet: unlockWallet, planId: plan.id, paidUntil, orderId });
  pendingOrders.delete(orderId);
  return send(res, 200, { ok: true, captured: true, orderId, id: orderId, planId: plan.id, plan, wallet: unlockWallet, paidUntil, planUnlockVersion: PLAN_UNLOCK_VERSION, planUnlockToken, capture, mode: 'order' });
}

async function handleCreateSubscription(req, res) {
  const body = await readBody(req);
  const plan = resolvePlan(body.planId || body.plan || body.subscriptionPlan || body.selectedPlan);
  if (Number(plan.priceUsd || 0) <= 0) throw new Error(`${plan.name} does not require PayPal subscription`);
  const wallet = paidIdentityFromPayload(body);
  if (!isValidPaidIdentity(wallet)) throw new Error('Valid paid wallet or seed account identity required');
  const subscription = await createPayPalSubscription(plan, wallet);
  const approveUrl = approvalLink(subscription);
  if (!subscription.id || !approveUrl) throw new Error('PayPal did not return a subscription approval link');
  return send(res, 200, { ok: true, subscriptionId: subscription.id, orderId: subscription.id, id: subscription.id, approveUrl, approvalUrl: approveUrl, checkoutUrl: approveUrl, planId: plan.id, plan, wallet, subscription, mode: 'subscription' });
}

async function handleConfirmSubscription(req, res) {
  const body = await readBody(req);
  const subscriptionId = String(body.subscriptionId || body.orderId || body.id || body.token || '').trim();
  if (!subscriptionId) throw new Error('PayPal subscription id required');
  const record = findSubscriptionRecord({ subscriptionId });
  const requestedPlan = resolvePlan(body.planId || body.plan || body.subscriptionPlan || record?.planId);
  const wallet = paidIdentityFromPayload(body) || record?.wallet;
  if (!isValidPaidIdentity(wallet)) throw new Error('Valid paid wallet or seed account identity required');
  if (record?.wallet && record.wallet !== wallet) throw new Error('Wallet does not match pending PayPal order');
  const subscription = await showSubscription(subscriptionId);
  return send(res, 200, subscriptionUnlockPayload({ subscription, record: { ...(record || {}), subscriptionId }, plan: requestedPlan, wallet }));
}

async function handleSubscriptionStatus(req, res) {
  const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams.entries());
  const subscriptionId = String(body.subscriptionId || body.orderId || body.id || '').trim();
  const wallet = paidIdentityFromPayload(body);
  const record = findSubscriptionRecord({ subscriptionId, wallet });
  if (!record?.subscriptionId) throw new Error('No PayPal subscription found for this identity');
  const plan = resolvePlan(body.planId || record.planId);
  const subscription = await showSubscription(record.subscriptionId);
  return send(res, 200, subscriptionUnlockPayload({ subscription, record, plan, wallet: wallet || record.wallet }));
}

async function handleVerifyUnlock(req, res) {
  const body = await readBody(req);
  const verified = verifyPlanUnlockToken({ wallet: body.wallet || body.accountId || body.identity || body.walletAddress || body.address || body.seedAccount || body.username, planId: body.planId || body.plan || body.subscriptionPlan, paidUntil: body.paidUntil, orderId: body.orderId || body.paypalOrderId || body.subscriptionId || body.captureId || body.txHash, planUnlockToken: body.planUnlockToken || body.unlockToken });
  return send(res, 200, { ok: true, verified, planUnlockVersion: PLAN_UNLOCK_VERSION });
}

async function verifyWebhook(req, event) {
  if (!PAYPAL_WEBHOOK_ID) return { verified: false, skipped: true, reason: 'PAYPAL_WEBHOOK_ID not configured' };
  const body = { auth_algo: req.headers['paypal-auth-algo'], cert_url: req.headers['paypal-cert-url'], transmission_id: req.headers['paypal-transmission-id'], transmission_sig: req.headers['paypal-transmission-sig'], transmission_time: req.headers['paypal-transmission-time'], webhook_id: PAYPAL_WEBHOOK_ID, webhook_event: event };
  const result = await paypalRequest('/v1/notifications/verify-webhook-signature', { method: 'POST', body });
  return { verified: result.verification_status === 'SUCCESS', result };
}

async function refreshSubscriptionRecord(subscriptionId, fallback = {}) {
  if (!subscriptionId) return null;
  try {
    const subscription = await showSubscription(subscriptionId);
    const record = findSubscriptionRecord({ subscriptionId }) || fallback;
    const plan = resolvePlan(record.planId || fallback.planId || 'personal');
    const wallet = record.wallet || fallback.wallet;
    if (!isValidPaidIdentity(wallet)) return null;
    const paidUntil = String(subscription.status || '').toUpperCase() === 'ACTIVE' ? paidUntilFromSubscription(subscription) : Number(record.paidUntil || 0);
    return saveSubscriptionRecord({ ...(record || {}), subscriptionId, planId: plan.id, wallet, status: subscription.status, paidUntil, nextBillingTime: subscription?.billing_info?.next_billing_time || null, lastWebhookRefreshAt: new Date().toISOString() });
  } catch (error) {
    console.warn('[paypal-webhook] refresh subscription failed:', error?.message || error);
    return null;
  }
}

async function handleWebhook(req, res) {
  const event = await readBody(req);
  const verification = await verifyWebhook(req, event);
  if (PAYPAL_WEBHOOK_ID && !verification.verified) throw new Error('PayPal webhook signature verification failed');
  const eventType = String(event.event_type || '');
  const resource = event.resource || {};
  const subscriptionId = String(resource.id || resource.subscription_id || resource.billing_agreement_id || resource.billing_subscription_id || '');
  if (subscriptionId) await refreshSubscriptionRecord(subscriptionId, { status: eventType });
  return send(res, 200, { ok: true, received: true, eventType, subscriptionId, verification });
}

function router(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
  if (req.method === 'GET' && (route === '/' || route === '/health')) return send(res, 200, { ok: true, service: 'p2p-cloud-paypal-checkout', env: PAYPAL_ENV, api: PAYPAL_API, configured: hasPayPalCredentials(), planUnlockConfigured: Boolean(PLAN_UNLOCK_SECRET), webhookConfigured: Boolean(PAYPAL_WEBHOOK_ID), returnUrl: RETURN_URL, cancelUrl: CANCEL_URL, localFallback: ALLOW_LOCAL_FALLBACK, stateDir: STATE_DIR, plans: Object.values(PLANS) });
  if (req.method === 'GET' && route === '/plans') return send(res, 200, { ok: true, plans: Object.values(PLANS), aliases: PLAN_ALIASES });
  if (req.method === 'POST' && ['/paypal/create-order', '/create-order', '/paypal/create', '/create'].includes(route)) return handleCreateOrder(req, res);
  if (req.method === 'POST' && ['/paypal/capture-order', '/capture-order', '/paypal/confirm', '/confirm'].includes(route)) return handleCaptureOrder(req, res);
  if (req.method === 'POST' && ['/paypal/create-subscription', '/create-subscription', '/paypal/subscribe', '/subscribe'].includes(route)) return handleCreateSubscription(req, res);
  if (req.method === 'POST' && ['/paypal/confirm-subscription', '/confirm-subscription', '/paypal/subscription-confirm', '/subscription-confirm'].includes(route)) return handleConfirmSubscription(req, res);
  if (req.method === 'POST' && ['/paypal/subscription-status', '/subscription-status', '/paypal/status'].includes(route)) return handleSubscriptionStatus(req, res);
  if (req.method === 'POST' && ['/paypal/verify-unlock', '/verify-unlock'].includes(route)) return handleVerifyUnlock(req, res);
  if (req.method === 'POST' && ['/paypal/webhook', '/webhook'].includes(route)) return handleWebhook(req, res);
  return send(res, 404, { ok: false, error: 'Not found', route });
}

const server = http.createServer((req, res) => {
  Promise.resolve(router(req, res)).catch((error) => {
    console.error('[paypal-checkout] error:', error?.stack || error?.message || error);
    send(res, 400, { ok: false, error: error?.message || 'PayPal checkout error' });
  });
});

server.listen(PORT, HOST, () => console.log(`[paypal-checkout] listening on http://${HOST}:${PORT} env=${PAYPAL_ENV} paypal=${hasPayPalCredentials() ? 'configured' : 'missing'} fallback=${ALLOW_LOCAL_FALLBACK ? 'enabled' : 'disabled'}`));
