const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const rendererFile = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const mainWrapperFile = path.join(root, 'electron', 'main-wrapper.js');

if (!fs.existsSync(rendererFile)) throw new Error(`Missing ${rendererFile}`);
if (!fs.existsSync(mainWrapperFile)) throw new Error(`Missing ${mainWrapperFile}`);

let src = fs.readFileSync(rendererFile, 'utf8');
let changed = false;

function mark(message) {
  changed = true;
  console.log(`[ensure-renderer-paypal-ipc] ${message}`);
}

function ensurePayPalChannelTypes() {
  if (!src.includes('"paypal:createSubscription"')) {
    const needle = '  | "paypal:openCheckout"\n';
    if (!src.includes(needle)) throw new Error('Could not find paypal:openCheckout in renderer Channel union.');
    src = src.replace(
      needle,
      '  | "paypal:createSubscription"\n  | "paypal:openCheckout"\n  | "paypal:confirmSubscription"\n'
    );
    mark('added PayPal subscription channels to renderer Channel union');
  }
}

function removeRendererPayPalServerUrl() {
  const before = src;
  src = src.replace(
    /\nconst PAYPAL_CHECKOUT_URL =\n\s+\(\(import\.meta as any\)\.env\?\.VITE_PAYPAL_CHECKOUT_URL as string\) \|\|\n\s+"http:\/\/54\.166\.171\.208:8791"; \/\/ Ethereum Mainnet\n/g,
    '\n'
  );
  if (src !== before) mark('removed renderer PayPal server URL');
}

function ipcBuyPlanSource() {
  return [
    'const buyPlan = (plan: Plan) =>',
    '  run(async () => {',
    '    if (!identityConnected) {',
    '      throw new Error("Connect wallet or sign in with Seed Account before subscribing");',
    '    }',
    '',
    '    if (!api) throw new Error("Electron bridge is not available");',
    '',
    '    const identity = paidIdentity();',
    '    if (!identity) {',
    '      throw new Error("Valid wallet or seed account identity required");',
    '    }',
    '',
    '    if (!canSelectPlan(plan)) {',
    '      throw new Error("Delete files first before switching to this lower plan");',
    '    }',
    '',
    '    setPayingPlanId(plan.id);',
    '',
    '    try {',
    '      const created = await api.invoke<any>("paypal:createSubscription", {',
    '        planId: plan.id,',
    '        wallet: identity,',
    '        accountId: identity,',
    '        identity,',
    '        username: wallet?.username || "",',
    '      });',
    '',
    '      if (!created?.approveUrl) {',
    '        throw new Error(created?.error || "Could not create PayPal subscription");',
    '      }',
    '',
    '      const checkout = await api.invoke<{ ok: boolean; cancelled?: boolean }>("paypal:openCheckout", {',
    '        approveUrl: created.approveUrl,',
    '      });',
    '',
    '      if (!checkout?.ok) {',
    '        throw new Error(checkout?.cancelled ? "PayPal subscription cancelled" : "PayPal subscription was not completed");',
    '      }',
    '',
    '      const confirmed = await api.invoke<any>("paypal:confirmSubscription", {',
    '        subscriptionId: created.subscriptionId || created.orderId || created.id,',
    '        orderId: created.orderId || created.subscriptionId || created.id,',
    '        planId: plan.id,',
    '        wallet: identity,',
    '        accountId: identity,',
    '        identity,',
    '        username: wallet?.username || "",',
    '      });',
    '',
    '      if (!confirmed?.ok) {',
    '        throw new Error(confirmed?.error || "Subscription was not activated");',
    '      }',
    '',
    '      const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {',
    '        planId: confirmed.planId || plan.id,',
    '        paidUntil: confirmed.paidUntil,',
    '        subscriptionId: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,',
    '        txHash: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,',
    '        planUnlockToken: confirmed.planUnlockToken,',
    '      });',
    '',
    '      setWallet(nextWallet);',
    '      setPlanPickerOpen(false);',
    '      await refresh();',
    '',
    '      toast.success((confirmed.plan?.name || plan.name) + " plan activated");',
    '    } finally {',
    '      setPayingPlanId("");',
    '    }',
    '  });',
  ].join('\n');
}

function replaceBuyPlan() {
  if (!/\bfetch\s*\(/.test(src) && src.includes('"paypal:createSubscription"') && src.includes('"paypal:confirmSubscription"')) {
    return;
  }

  const start = src.indexOf('const buyPlan = (plan: Plan) =>');
  if (start < 0) throw new Error('Could not find buyPlan function in renderer.');

  const endMarker = '\n  const joinWorkspace = () =>';
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error('Could not find joinWorkspace marker after buyPlan.');

  src = src.slice(0, start) + ipcBuyPlanSource() + src.slice(end);
  mark('moved buyPlan PayPal requests to Electron IPC');
}

function ensureMainWrapperImport() {
  let main = fs.readFileSync(mainWrapperFile, 'utf8');
  if (main.includes("./paypal-subscription-ipc.js")) return;

  const marker = "    await import('./wallet-plan-guard.js');\n    console.log('[main-wrapper] wallet plan guard import finished');\n";
  const replacement = `${marker}    await import('./paypal-subscription-ipc.js');\n    console.log('[main-wrapper] paypal subscription IPC import finished');\n`;
  if (!main.includes(marker)) throw new Error('Could not find wallet-plan-guard import marker in main-wrapper.js');

  main = main.replace(marker, replacement);
  fs.writeFileSync(mainWrapperFile, main, 'utf8');
  console.log('[ensure-renderer-paypal-ipc] installed paypal subscription IPC import in main-wrapper.js');
}

ensurePayPalChannelTypes();
removeRendererPayPalServerUrl();
replaceBuyPlan();

if (/\bfetch\s*\(/.test(src)) {
  throw new Error('Renderer still contains fetch(); app data and payment requests must go through Electron IPC.');
}

if (!src.includes('"paypal:createSubscription"') || !src.includes('"paypal:confirmSubscription"')) {
  throw new Error('Renderer is missing PayPal subscription IPC channels.');
}

if (changed) fs.writeFileSync(rendererFile, src, 'utf8');
ensureMainWrapperImport();

console.log('[ensure-renderer-paypal-ipc] ok');
