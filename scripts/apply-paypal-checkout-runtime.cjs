#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const rendererPath = path.join(root, 'client', 'src', 'NativeP2PAppLive.tsx');
const mainPath = path.join(root, 'electron', 'main.js');
const ipcContractPath = path.join(root, 'electron', 'ipc-contract.cjs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after, 'utf8');
  return true;
}

function patchRenderer() {
  let source = read(rendererPath);
  const before = source;

  if (!source.includes('| "paypal:openCheckout"')) {
    source = source.replace(
      '  | "wallet:setPlan";',
      '  | "wallet:setPlan"\n  | "paypal:openCheckout";'
    );
  }

  source = source.replace(
    /const PAYPAL_CHECKOUT_URL = "http:\/\/[^"\n]+:8791";/,
    'const PAYPAL_CHECKOUT_URL =\n    ((import.meta as any).env?.VITE_PAYPAL_CHECKOUT_URL as string) ||\n    "http://54.166.171.208:8791";'
  );

  const oldCheckoutFlow = /\s*window\.open\(created\.approveUrl,\s*"_blank"(?:,\s*"noopener,noreferrer")?\);\s*await showInfo\(\s*"Complete PayPal payment",\s*"PayPal checkout opened in your browser\.\\n\\nAfter completing the payment, click OK here to activate your plan\."\s*\);/;
  const newCheckoutFlow = `
        const checkout = await api!.invoke<{ ok: boolean; cancelled?: boolean }>("paypal:openCheckout", {
          approveUrl: created.approveUrl,
          returnUrl: "https://example.com/chunknet-payment-success",
          cancelUrl: "https://example.com/chunknet-payment-cancel",
        });

        if (!checkout?.ok) {
          throw new Error(checkout?.cancelled ? "PayPal checkout cancelled" : "PayPal checkout was not completed");
        }`;

  source = source.replace(oldCheckoutFlow, newCheckoutFlow);

  return writeIfChanged(rendererPath, before, source);
}

function patchIpcContract() {
  let source = read(ipcContractPath);
  const before = source;

  if (!source.includes("'paypal:openCheckout'")) {
    source = source.replace("  'wallet:setPlan',", "  'wallet:setPlan',\n  'paypal:openCheckout',");
  }

  if (!source.includes("'paypal:'")) {
    source = source.replace("  'drive:',", "  'drive:',\n  'paypal:',");
  }

  return writeIfChanged(ipcContractPath, before, source);
}

function patchMainPlans(source) {
  const productionPlans = `const FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const TRIAL_DAYS = 7;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';`;

  source = source.replace(
    /const FREE_QUOTA_BYTES = \d+ \* 1024 \* 1024 \* 1024;\s*const ENCRYPTION_ALGORITHM = 'aes-256-gcm';/,
    productionPlans
  );

  const plansBlock = `const PLANS = {
  free: { id: 'free', name: 'Trial', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false, trialDays: TRIAL_DAYS, description: '10 GB trial for 7 days' },
  trial: { id: 'trial', name: 'Trial', quotaBytes: FREE_QUOTA_BYTES, priceUsd: 0, locked: false, trialDays: TRIAL_DAYS, description: '10 GB trial for 7 days' },
  starter: { id: 'starter', name: 'Starter', quotaBytes: 100 * 1024 ** 3, priceUsd: 2.99, locked: true, description: '100 GB storage plan' },
  personal: { id: 'personal', name: 'Personal', quotaBytes: 1 * 1024 ** 4, priceUsd: 7.99, locked: true, description: '1 TB storage plan' },
  plus: { id: 'plus', name: 'Plus', quotaBytes: 3 * 1024 ** 4, priceUsd: 14.99, locked: true, description: '3 TB storage plan' },
  pro: { id: 'pro', name: 'Pro', quotaBytes: 7 * 1024 ** 4, priceUsd: 24.99, locked: true, description: '7 TB storage plan' },
  ultra: { id: 'ultra', name: 'Ultra', quotaBytes: 10 * 1024 ** 4, priceUsd: 34.99, locked: true, description: '10 TB storage plan' },
  tb1: { id: 'tb1', aliasFor: 'personal', name: 'Personal', quotaBytes: 1 * 1024 ** 4, priceUsd: 7.99, locked: true, hidden: true },
  tb3: { id: 'tb3', aliasFor: 'plus', name: 'Plus', quotaBytes: 3 * 1024 ** 4, priceUsd: 14.99, locked: true, hidden: true },
  tb7: { id: 'tb7', aliasFor: 'pro', name: 'Pro', quotaBytes: 7 * 1024 ** 4, priceUsd: 24.99, locked: true, hidden: true },
  tb10: { id: 'tb10', aliasFor: 'ultra', name: 'Ultra', quotaBytes: 10 * 1024 ** 4, priceUsd: 34.99, locked: true, hidden: true },
};`;

  source = source.replace(/const PLANS = \{[\s\S]*?\n\};\n\nlet mainWindow = null;/, `${plansBlock}\n\nlet mainWindow = null;`);

  source = source.replace(
    /function walletSummary\(\) \{ const plan = PLANS\[walletState\.planId\] \|\| PLANS\.free; const usedBytes = walletState\.connected \? totalStoredBytesForWallet\(\) : 0; return \{ ok: true, \.\.\.walletState, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet\(\) \|\| walletState\.address, plan, plans: Object\.values\(PLANS\), usedBytes, remainingBytes: Math\.max\(0, plan\.quotaBytes - usedBytes\), sync: lastSyncStatus \}; \}/,
    "function visiblePlans() { return Object.values(PLANS).filter((plan) => !plan.hidden && !plan.aliasFor); }\nfunction canonicalPlanId(planId = 'free') { return PLANS[planId]?.aliasFor || planId; }\nfunction walletSummary() { const canonicalId = canonicalPlanId(walletState.planId); const plan = PLANS[canonicalId] || PLANS.free; const usedBytes = walletState.connected ? totalStoredBytesForWallet() : 0; return { ok: true, ...walletState, planId: canonicalId, encryptionSecret: null, loginSignature: null, encryptionKeySource: ENCRYPTION_KEY_SOURCE, minDrivePasswordLength: MIN_DRIVE_PASSWORD_LENGTH, address: activeWallet() || walletState.address, plan, plans: visiblePlans(), usedBytes, remainingBytes: Math.max(0, plan.quotaBytes - usedBytes), sync: lastSyncStatus }; }"
  );

  source = source.replace(
    /ipcMain\.handle\('wallet:setPlan', async \(_event, payload = \{\}\) => \{ assertVerifiedWallet\(\); const planId = String\(payload\.planId \|\| 'free'\); if \(!PLANS\[planId\]\) throw new Error\('Unknown wallet plan'\); walletState = \{ \.\.\.walletState, planId, paidUntil: payload\.paidUntil \|\| walletState\.paidUntil \|\| null, subscriptionTx: payload\.txHash \|\| walletState\.subscriptionTx \|\| null \}; persistWallet\(\); return walletSummary\(\); \}\);/,
    "ipcMain.handle('wallet:setPlan', async (_event, payload = {}) => { assertVerifiedWallet(); const requestedPlanId = String(payload.planId || 'free'); const planId = canonicalPlanId(requestedPlanId); if (!PLANS[planId]) throw new Error('Unknown wallet plan'); walletState = { ...walletState, planId, paidUntil: payload.paidUntil || walletState.paidUntil || null, subscriptionTx: payload.txHash || walletState.subscriptionTx || null }; persistWallet(); return walletSummary(); });"
  );

  return source;
}

function patchMainUiPrefs(source) {
  if (source.includes("ipcMain.handle('p2p:setUiPrefs'")) return source;
  if (!source.includes("ipcMain.handle('p2p:start'")) {
    throw new Error('Could not find p2p:start IPC handler anchor in electron/main.js');
  }

  const handler = `
function uiPrefsPath() {
  ensureDataDir();
  return path.join(dataDir, 'ui-prefs.json');
}

function readUiPrefs() {
  try {
    const filePath = uiPrefsPath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeUiPrefs(prefs = {}) {
  const next = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  fs.mkdirSync(path.dirname(uiPrefsPath()), { recursive: true });
  fs.writeFileSync(uiPrefsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

ipcMain.handle('p2p:getUiPrefs', async () => ({ ok: true, prefs: readUiPrefs() }));
ipcMain.handle('p2p:setUiPrefs', async (_event, payload = {}) => {
  const incoming = payload?.prefs && typeof payload.prefs === 'object' && !Array.isArray(payload.prefs)
    ? payload.prefs
    : payload;
  const { ok: _ok, prefs: _prefs, ...cleanIncoming } = incoming || {};
  const prefs = writeUiPrefs({ ...readUiPrefs(), ...cleanIncoming });
  return { ok: true, prefs };
});
`;

  return source.replace("ipcMain.handle('p2p:start'", `${handler}\nipcMain.handle('p2p:start'`);
}

function patchMain() {
  let source = read(mainPath);
  const before = source;

  source = patchMainPlans(source);
  source = patchMainUiPrefs(source);

  if (!source.includes("ipcMain.handle('paypal:openCheckout'")) {
    const handler = `
function checkoutUrlMatches(currentUrl = '', targetUrl = '') {
  try {
    const current = new URL(String(currentUrl || ''));
    const target = new URL(String(targetUrl || ''));
    return current.origin === target.origin && current.pathname.replace(/\\/+$/, '') === target.pathname.replace(/\\/+$/, '');
  } catch {
    return false;
  }
}

function isPayPalApproveUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'paypal.com' || host.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}

ipcMain.handle('paypal:openCheckout', async (_event, payload = {}) => {
  const approveUrl = String(payload.approveUrl || '').trim();
  const returnUrl = String(payload.returnUrl || 'https://example.com/chunknet-payment-success').trim();
  const cancelUrl = String(payload.cancelUrl || 'https://example.com/chunknet-payment-cancel').trim();

  if (!isPayPalApproveUrl(approveUrl)) throw new Error('Invalid PayPal checkout URL');

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      minWidth: 420,
      minHeight: 620,
      title: 'Chunknet PayPal Checkout',
      parent: parent || undefined,
      modal: Boolean(parent),
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: true,
        partition: 'persist:chunknet-paypal-checkout',
      },
    });

    try {
      win.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
    } catch {}

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      resolve(result);
    };

    const inspect = (url) => {
      if (checkoutUrlMatches(url, returnUrl)) {
        finish({ ok: true, url });
        return true;
      }
      if (checkoutUrlMatches(url, cancelUrl)) {
        finish({ ok: false, cancelled: true, url });
        return true;
      }
      return false;
    };

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (inspect(url)) return { action: 'deny' };
      try {
        const next = new URL(url);
        const host = next.hostname.toLowerCase();
        if (next.protocol === 'https:' && (host === 'paypal.com' || host.endsWith('.paypal.com'))) {
          win.loadURL(url).catch(() => {});
          return { action: 'deny' };
        }
      } catch {}
      return { action: 'deny' };
    });

    win.webContents.on('will-redirect', (event, url) => { if (inspect(url)) event.preventDefault(); });
    win.webContents.on('will-navigate', (event, url) => { if (inspect(url)) event.preventDefault(); });
    win.webContents.on('did-navigate', (_event, url) => inspect(url));
    win.webContents.on('did-navigate-in-page', (_event, url) => inspect(url));

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, cancelled: true, closed: true });
      }
    });

    win.loadURL(approveUrl).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
});
`;

    if (!source.includes("ipcMain.handle('p2p:start'")) {
      throw new Error('Could not find p2p:start IPC handler anchor in electron/main.js');
    }

    source = source.replace("ipcMain.handle('p2p:start'", `${handler}\nipcMain.handle('p2p:start'`);
  }

  return writeIfChanged(mainPath, before, source);
}

const changed = {
  renderer: patchRenderer(),
  ipcContract: patchIpcContract(),
  main: patchMain(),
};

console.log('[paypal-runtime] applied', changed);
