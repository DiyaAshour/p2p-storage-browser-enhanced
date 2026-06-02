#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const uiPath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const mainPath = path.join(root, 'electron', 'main.js');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, text) { fs.writeFileSync(file, text, 'utf8'); }
function mustInclude(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`Could not find ${label}: ${needle.slice(0, 120)}`);
}

function patchUi() {
  let text = read(uiPath);

  if (!text.includes('| "wallet:setPlan"')) {
    text = text.replace('  | "wallet:disconnect"\n', '  | "wallet:disconnect"\n  | "wallet:setPlan"\n');
  }

  if (!text.includes('const PAYPAL_CHECKOUT_URL =')) {
    text = text.replace(
      'const WALLETCONNECT_CHAIN_ID = "eip155:1"; // Ethereum Mainnet\n',
      'const WALLETCONNECT_CHAIN_ID = "eip155:1"; // Ethereum Mainnet\nconst PAYPAL_CHECKOUT_URL =\n  ((import.meta as any).env?.VITE_PAYPAL_CHECKOUT_URL as string) ||\n  "http://127.0.0.1:8791";\n'
    );
  }

  if (!text.includes('payingPlanId')) {
    text = text.replace(
      '  const [newFolder, setNewFolder] = useState("");\n',
      '  const [newFolder, setNewFolder] = useState("");\n  const [payingPlanId, setPayingPlanId] = useState<string>("");\n'
    );
  }

  if (!text.includes('const buyPlan = (plan: Plan) =>')) {
    const anchor = '  const createWorkspace = () =>\n';
    mustInclude(text, anchor, 'createWorkspace anchor');
    const block = `  const buyPlan = (plan: Plan) =>
    run(async () => {
      if (!identityConnected) throw new Error("Connect wallet or sign in first");
      if (!plan?.id || Number(plan.priceUsd || 0) <= 0) throw new Error("Select a paid plan");

      const account = wallet?.accountId || wallet?.address;
      if (!account) throw new Error("Missing account identity");

      setPayingPlanId(plan.id);

      try {
        const createRes = await fetch(\`${PAYPAL_CHECKOUT_URL}/paypal/create-order\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ planId: plan.id, wallet: account }),
        });

        const created = await createRes.json();
        if (!createRes.ok || !created?.ok || !created?.approveUrl || !created?.orderId) {
          throw new Error(created?.error || "Could not create PayPal checkout");
        }

        window.open(created.approveUrl, "_blank", "noopener,noreferrer");

        await showInfo(
          "Complete PayPal payment",
          "PayPal checkout opened in your browser.\\n\\nAfter completing the payment, click OK here to activate your plan."
        );

        const captureRes = await fetch(\`${PAYPAL_CHECKOUT_URL}/paypal/capture-order\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId: created.orderId, planId: plan.id, wallet: account }),
        });

        const captured = await captureRes.json();
        if (!captureRes.ok || !captured?.ok || !captured?.planUnlockToken) {
          throw new Error(captured?.error || "Payment was not completed");
        }

        const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {
          planId: captured.planId,
          paidUntil: captured.paidUntil,
          orderId: captured.orderId,
          txHash: captured.orderId,
          planUnlockToken: captured.planUnlockToken,
        });

        setWallet(nextWallet);
        await refresh();
        toast.success(\`${captured.plan?.name || plan.name} plan activated\`);
      } finally {
        setPayingPlanId("");
      }
    });

`;
    text = text.replace(anchor, block + anchor);
  }

  if (!text.includes('Upgrade storage')) {
    const anchor = `          {wallet?.plan && (
            <span className="flex items-center gap-1">
              <Cloud className="size-3" />
              {wallet.plan.name}
            </span>
          )}`;
    mustInclude(text, anchor, 'wallet plan header');
    const replacement = `${anchor}

          {identityConnected && wallet?.plans?.filter((plan) => Number(plan.priceUsd || 0) > 0).length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-zinc-500">Upgrade storage</span>
              {wallet.plans
                .filter((plan) => Number(plan.priceUsd || 0) > 0)
                .map((plan) => {
                  const active = wallet.planId === plan.id || wallet.plan?.id === plan.id;
                  return (
                    <Button
                      key={plan.id}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      disabled={busy || active || payingPlanId === plan.id}
                      onClick={() => buyPlan(plan)}
                      className="h-7 px-2 text-[11px]"
                    >
                      <Cloud className="size-3" />
                      {active ? \`${plan.name} Active\` : \`${plan.name} · $${plan.priceUsd}/mo\`}
                    </Button>
                  );
                })}
            </div>
          ) : null}`;
    text = text.replace(anchor, replacement);
  }

  write(uiPath, text);
}

function patchMain() {
  let text = read(mainPath);

  if (!text.includes('const PLAN_UNLOCK_VERSION =')) {
    const anchor = `const PLANS = {
  free: { id: 'free', name: 'Free', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false },
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: 1, locked: true },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: 2.5, locked: true },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: 4.99, locked: true },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: 7.99, locked: true },
};`;
    mustInclude(text, anchor, 'PLANS block');
    text = text.replace(anchor, `${anchor}
const PLAN_UNLOCK_VERSION = 'plan-unlock-hmac-sha256-v1';
const PLAN_UNLOCK_SECRET = String(process.env.P2P_PLAN_UNLOCK_SECRET || process.env.PLAN_UNLOCK_SECRET || '').trim();`);
  }

  if (!text.includes('function planUnlockPayload')) {
    const anchor = `function nowSeconds() { return Math.floor(Date.now() / 1000); }\n`;
    mustInclude(text, anchor, 'nowSeconds');
    const block = `function planUnlockPayload({ wallet, planId, paidUntil, orderId }) {
  return JSON.stringify({
    version: PLAN_UNLOCK_VERSION,
    wallet: normalizeWallet(wallet),
    planId: String(planId || '').trim(),
    paidUntil: Number(paidUntil || 0),
    orderId: String(orderId || '').trim(),
  });
}
function verifyPlanUnlock(payload = {}) {
  if (!PLAN_UNLOCK_SECRET) throw new Error('Plan unlock secret is not configured');
  const planId = String(payload.planId || '').trim();
  const paidUntil = Number(payload.paidUntil || 0);
  const orderId = String(payload.orderId || payload.txHash || '').trim();
  const token = String(payload.planUnlockToken || '').trim();
  if (!PLANS[planId] || planId === 'free') throw new Error('Unknown paid plan');
  if (!paidUntil || paidUntil <= nowSeconds()) throw new Error('Payment unlock is expired');
  if (!orderId) throw new Error('PayPal order id is required');
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid plan unlock token');
  const wallet = activeWallet();
  if (!wallet) throw new Error('Verified identity required for plan unlock');
  const expected = crypto.createHmac('sha256', PLAN_UNLOCK_SECRET)
    .update(planUnlockPayload({ wallet, planId, paidUntil, orderId }))
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(token, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Plan unlock token verification failed');
  return { planId, paidUntil, orderId };
}
`;
    text = text.replace(anchor, anchor + block);
  }

  const oldLine = `ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const planId = String(payload.planId || 'free'); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });`;
  if (text.includes(oldLine)) {
    const newBlock = `ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => {
  assertVerifiedWallet();
  const unlock = verifyPlanUnlock(payload);
  walletState = {
    ...walletState,
    planId: unlock.planId,
    paidUntil: unlock.paidUntil,
    subscriptionTx: unlock.orderId,
    planUnlockedAt: new Date().toISOString(),
  };
  persistWallet();
  return walletSummary();
});`;
    text = text.replace(oldLine, newBlock);
  }

  write(mainPath, text);
}

patchUi();
patchMain();
console.log('[enable-paypal-plans-ui] PayPal plan UI + secure plan unlock patch applied.');
