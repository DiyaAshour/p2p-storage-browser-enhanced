#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after, 'utf8');
  return true;
}

let source = read(rendererPath);
const before = source;

// Switch the production UI from one-time PayPal Orders to monthly PayPal Subscriptions.
source = source.replaceAll('/paypal/create-order', '/paypal/create-subscription');
source = source.replaceAll('/paypal/capture-order', '/paypal/confirm-subscription');

source = source.replaceAll('Could not create PayPal checkout', 'Could not create PayPal subscription');
source = source.replaceAll('Payment was not completed', 'Subscription was not activated');
source = source.replaceAll('Complete PayPal payment', 'Complete PayPal subscription');
source = source.replaceAll('PayPal checkout opened in your browser.', 'PayPal subscription checkout opened.');
source = source.replaceAll('After completing the payment, click OK here to activate your plan.', 'After approving the monthly subscription, click OK here to activate your plan.');
source = source.replaceAll('PayPal checkout cancelled', 'PayPal subscription cancelled');
source = source.replaceAll('PayPal checkout was not completed', 'PayPal subscription was not completed');

// Keep old response variable names compatible, but store the subscription id clearly when present.
source = source.replace(
  /txHash: captured\.orderId,\s*\n\s*orderId: captured\.orderId,/,
  'txHash: captured.subscriptionId || captured.orderId,\n          orderId: captured.orderId || captured.subscriptionId,\n          subscriptionId: captured.subscriptionId || captured.orderId,'
);

const changed = writeIfChanged(rendererPath, before, source);
console.log('[paypal-subscriptions-runtime] applied', { renderer: changed });
