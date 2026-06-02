const fs = require("node:fs");

const p = "scripts/electron-dev-cloud.cjs";
let s = fs.readFileSync(p, "utf8");

const needle = "runOptionalScript('scripts/apply-paypal-checkout-runtime.cjs');";
const insert = needle + "\nrunOptionalScript('scripts/apply-paypal-subscriptions-runtime.cjs');";

if (!s.includes("apply-paypal-subscriptions-runtime.cjs")) {
  if (!s.includes(needle)) {
    throw new Error("Could not find PayPal checkout runtime line");
  }

  s = s.replace(needle, insert);
  fs.writeFileSync(p, s, "utf8");
}

console.log("OK subscriptions runtime wired");
