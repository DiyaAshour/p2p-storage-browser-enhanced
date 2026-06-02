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

function patchMain() {
  let source = read(mainPath);
  const before = source;

  if (source.includes("ipcMain.handle('paypal:openCheckout'")) {
    return false;
  }

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

  return writeIfChanged(mainPath, before, source);
}

const changed = {
  renderer: patchRenderer(),
  ipcContract: patchIpcContract(),
  main: patchMain(),
};

console.log('[paypal-runtime] applied', changed);
