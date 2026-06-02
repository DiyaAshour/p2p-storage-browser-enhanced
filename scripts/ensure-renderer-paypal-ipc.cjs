const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const rendererFile = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const mainWrapperFile = path.join(root, 'electron', 'main-wrapper.js');

if (!fs.existsSync(rendererFile)) throw new Error(`Missing ${rendererFile}`);
if (!fs.existsSync(mainWrapperFile)) throw new Error(`Missing ${mainWrapperFile}`);

let src = fs.readFileSync(rendererFile, 'utf8');
let changed = false;

function replaceOnce(find, replace, label) {
  if (!src.includes(find)) return false;
  src = src.replace(find, replace);
  changed = true;
  console.log(`[ensure-renderer-paypal-ipc] updated ${label}`);
  return true;
}

replaceOnce(
  '  | "paypal:openCheckout"\n',
  '  | "paypal:createSubscription"\n  | "paypal:openCheckout"\n  | "paypal:confirmSubscription"\n',
  'PayPal channel type union'
);

src = src.replace(
  /\nconst PAYPAL_CHECKOUT_URL =\n\s+\(\(import\.meta as any\)\.env\?\.VITE_PAYPAL_CHECKOUT_URL as string\) \|\|\n\s+"http:\/\/54\.166\.171\.208:8791"; \/\/ Ethereum Mainnet\n/g,
  () => {
    changed = true;
    console.log('[ensure-renderer-paypal-ipc] removed renderer PayPal server URL');
    return '\n';
  }
);

const legacyBuyPlan = `const buyPlan = (plan: Plan) =>
  run(async () => {
    if (!identityConnected) {
      throw new Error("Connect wallet or sign in with Seed Account before subscribing");
    }

    if (!api) throw new Error("Electron bridge is not available");

    const identity = paidIdentity();
    if (!identity) {
      throw new Error("Valid wallet or seed account identity required");
    }

    if (!canSelectPlan(plan)) {
      throw new Error("Delete files first before switching to this lower plan");
    }

    setPayingPlanId(plan.id);

    try {
      const createRes = await fetch(\`${PAYPAL_CHECKOUT_URL}/paypal/create-subscription\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: plan.id,
          wallet: identity,
          accountId: identity,
          identity,
          username: wallet?.username || "",
        }),
      });

      const created = await createRes.json().catch(() => ({}));

      if (!createRes.ok || !created?.approveUrl) {
        throw new Error(created?.error || "Could not create PayPal subscription");
      }

      const checkout = await api.invoke<{ ok: boolean; cancelled?: boolean }>("paypal:openCheckout", {
        approveUrl: created.approveUrl,
        returnUrl: "https://example.com/chunknet-payment-success",
        cancelUrl: "https://example.com/chunknet-payment-cancel",
      });

      if (!checkout?.ok) {
        throw new Error(checkout?.cancelled ? "PayPal subscription cancelled" : "PayPal subscription was not completed");
      }

      const confirmRes = await fetch(\`${PAYPAL_CHECKOUT_URL}/paypal/confirm-subscription\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscriptionId: created.subscriptionId || created.orderId || created.id,
          orderId: created.orderId || created.subscriptionId || created.id,
          planId: plan.id,
          wallet: identity,
          accountId: identity,
          identity,
          username: wallet?.username || "",
        }),
      });

      const confirmed = await confirmRes.json().catch(() => ({}));

      if (!confirmRes.ok || !confirmed?.ok) {
        throw new Error(confirmed?.error || "Subscription was not activated");
      }

      const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {
        planId: confirmed.planId || plan.id,
        paidUntil: confirmed.paidUntil,
        subscriptionId: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        txHash: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        planUnlockToken: confirmed.planUnlockToken,
      });

      setWallet(nextWallet);
      setPlanPickerOpen(false);
      await refresh();

      toast.success(\`${confirmed.plan?.name || plan.name} plan activated\`);
    } finally {
      setPayingPlanId("");
    }
  });`;

const ipcBuyPlan = `const buyPlan = (plan: Plan) =>
  run(async () => {
    if (!identityConnected) {
      throw new Error("Connect wallet or sign in with Seed Account before subscribing");
    }

    if (!api) throw new Error("Electron bridge is not available");

    const identity = paidIdentity();
    if (!identity) {
      throw new Error("Valid wallet or seed account identity required");
    }

    if (!canSelectPlan(plan)) {
      throw new Error("Delete files first before switching to this lower plan");
    }

    setPayingPlanId(plan.id);

    try {
      const created = await api.invoke<any>("paypal:createSubscription", {
        planId: plan.id,
        wallet: identity,
        accountId: identity,
        identity,
        username: wallet?.username || "",
      });

      if (!created?.approveUrl) {
        throw new Error(created?.error || "Could not create PayPal subscription");
      }

      const checkout = await api.invoke<{ ok: boolean; cancelled?: boolean }>("paypal:openCheckout", {
        approveUrl: created.approveUrl,
      });

      if (!checkout?.ok) {
        throw new Error(checkout?.cancelled ? "PayPal subscription cancelled" : "PayPal subscription was not completed");
      }

      const confirmed = await api.invoke<any>("paypal:confirmSubscription", {
        subscriptionId: created.subscriptionId || created.orderId || created.id,
        orderId: created.orderId || created.subscriptionId || created.id,
        planId: plan.id,
        wallet: identity,
        accountId: identity,
        identity,
        username: wallet?.username || "",
      });

      if (!confirmed?.ok) {
        throw new Error(confirmed?.error || "Subscription was not activated");
      }

      const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {
        planId: confirmed.planId || plan.id,
        paidUntil: confirmed.paidUntil,
        subscriptionId: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        txHash: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        planUnlockToken: confirmed.planUnlockToken,
      });

      setWallet(nextWallet);
      setPlanPickerOpen(false);
      await refresh();

      toast.success(\`${confirmed.plan?.name || plan.name} plan activated\`);
    } finally {
      setPayingPlanId("");
    }
  });`;

if (src.includes(legacyBuyPlan)) {
  src = src.replace(legacyBuyPlan, ipcBuyPlan);
  changed = true;
  console.log('[ensure-renderer-paypal-ipc] moved buyPlan network requests to IPC');
}

if (/\bfetch\s*\(/.test(src)) {
  throw new Error('Renderer still contains fetch(); PayPal requests must go through Electron IPC.');
}

if (!src.includes('"paypal:createSubscription"') || !src.includes('"paypal:confirmSubscription"')) {
  throw new Error('Renderer is missing PayPal subscription IPC channels.');
}

if (changed) fs.writeFileSync(rendererFile, src, 'utf8');

let main = fs.readFileSync(mainWrapperFile, 'utf8');
if (!main.includes("./paypal-subscription-ipc.js")) {
  const marker = "    await import('./wallet-plan-guard.js');\n    console.log('[main-wrapper] wallet plan guard import finished');\n";
  const replacement = `${marker}    await import('./paypal-subscription-ipc.js');\n    console.log('[main-wrapper] paypal subscription IPC import finished');\n`;
  if (!main.includes(marker)) throw new Error('Could not find wallet-plan-guard import marker in main-wrapper.js');
  main = main.replace(marker, replacement);
  fs.writeFileSync(mainWrapperFile, main, 'utf8');
  console.log('[ensure-renderer-paypal-ipc] installed paypal subscription IPC import in main-wrapper.js');
}

console.log('[ensure-renderer-paypal-ipc] ok');
