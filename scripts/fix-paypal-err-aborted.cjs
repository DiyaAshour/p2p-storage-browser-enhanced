const fs = require("node:fs");

const p = "electron/main.js";
let s = fs.readFileSync(p, "utf8");

const oldBlock = `    win.loadURL(approveUrl).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });`;

const newBlock = `    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (settled) return;
      // PayPal often aborts an internal navigation while redirecting between checkout pages.
      // This is not a failed payment, so do not reject the checkout promise.
      if (errorCode === -3 || String(errorDescription || '').includes('ERR_ABORTED')) return;
      console.warn('[paypal-window] did-fail-load', { errorCode, errorDescription, validatedURL });
    });

    win.loadURL(approveUrl).catch((error) => {
      if (settled) return;
      if (error?.code === 'ERR_ABORTED' || String(error?.message || '').includes('ERR_ABORTED')) {
        console.warn('[paypal-window] ignored ERR_ABORTED during PayPal redirect');
        return;
      }
      settled = true;
      reject(error);
    });`;

if (!s.includes(oldBlock)) {
  console.log("Target block not found. Maybe already patched.");
} else {
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(p, s, "utf8");
  console.log("OK PayPal ERR_ABORTED ignored");
}
