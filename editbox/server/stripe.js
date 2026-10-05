'use strict';
/* Stripe over plain HTTPS (no SDK). Used only when STRIPE_SECRET_KEY is set; otherwise the server
 * runs a clearly labelled mock checkout that never charges anyone. */
const crypto = require('crypto');

function form(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

async function call(secretKey, method, pathName, body) {
  const r = await fetch('https://api.stripe.com/v1/' + pathName, {
    method,
    headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || r.status));
  return j;
}

function hoursSession(cfg, { project, pack, email, successUrl, cancelUrl }) {
  return call(cfg.secretKey, 'POST', 'checkout/sessions', {
    mode: 'payment',
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: project.id,
    metadata: { kind: 'hours', projectId: project.id, packId: pack.id },
    payment_intent_data: { metadata: { kind: 'hours', projectId: project.id, packId: pack.id } },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: pack.priceCents, product_data: { name: 'The Edit Box: ' + pack.hours + ' prepaid editing hours (' + pack.label + ')', description: project.title } } } }
  });
}

function archiveSession(cfg, { project, priceCents, interval, email, successUrl, cancelUrl }) {
  const item = cfg.archivePriceId
    ? { price: cfg.archivePriceId, quantity: 1 }
    : { quantity: 1, price_data: { currency: 'usd', unit_amount: priceCents, recurring: { interval }, product_data: { name: 'The Edit Box: project archive' } } };
  return call(cfg.secretKey, 'POST', 'checkout/sessions', {
    mode: 'subscription',
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: project.id,
    metadata: { kind: 'archive', projectId: project.id },
    subscription_data: { metadata: { kind: 'archive', projectId: project.id } },
    line_items: { 0: item }
  });
}

function cancelAtPeriodEnd(cfg, subscriptionId) {
  return call(cfg.secretKey, 'POST', 'subscriptions/' + encodeURIComponent(subscriptionId), { cancel_at_period_end: 'true' });
}

function getSubscription(cfg, subscriptionId) {
  return call(cfg.secretKey, 'GET', 'subscriptions/' + encodeURIComponent(subscriptionId));
}

/* Verifies the Stripe-Signature header against the raw body (v1 scheme, 5 minute tolerance). */
function verifyWebhook(rawBody, header, secret, now) {
  if (!header || !secret) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    const k = kv.slice(0, i), v = kv.slice(i + 1);
    (parts[k] = parts[k] || []).push(v);
  }
  const t = parts.t && parts.t[0];
  if (!t || Math.abs((now || Date.now()) / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex');
  return (parts.v1 || []).some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { hoursSession, archiveSession, cancelAtPeriodEnd, getSubscription, verifyWebhook, form };
