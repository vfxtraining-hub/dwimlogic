'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../server/env.js');
const { createApp } = require('../server/server.js');
const { presign } = require('../server/storage.js');
const stripe = require('../server/stripe.js');

const DAY = 86400000;

async function boot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editbox-'));
  let clock = Date.parse('2026-10-01T12:00:00Z');
  const sent = [];
  const cfg = env.config(Object.assign({ EDITBOX_DATA_DIR: dir, EDITBOX_ADMIN_EMAILS: 'editor@dwim.test', EDITBOX_DEV_LOGIN: '1', PORT: '0' }, extraEnv || {}));
  const app = createApp(cfg, { now: () => clock, mail: { send: async (to, subject, text) => sent.push({ to, subject, text }) } });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  app.cfg.baseUrl = base;
  return { app, server, base, sent, dir, advance: (ms) => { clock += ms; }, close: () => new Promise((r) => server.close(r)) };
}

function client(base) {
  let cookie = '';
  async function call(method, p, body, headers) {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-EditBox': '1', Cookie: cookie }, headers || {}),
      body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
  }
  async function login(email, next) {
    const r = await call('POST', '/editbox/api/auth/request', { email, next });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const v = await call('GET', new URL(r.body.devLink).pathname + new URL(r.body.devLink).search);
    assert.strictEqual(v.status, 302);
    return v;
  }
  return { call, login };
}

test('live server: full client and editor flow with mock payments and local storage', async () => {
  const s = await boot();
  try {
    const c = client(s.base), e = client(s.base), x = client(s.base);
    assert.strictEqual((await c.call('GET', '/editbox/api/projects')).status, 401);
    await c.login('Client@Example.com');
    const ev = await e.login('editor@dwim.test', 'studio');
    assert.strictEqual(ev.headers.get('location'), '/editbox/studio/');
    await x.login('stranger@example.com');

    const me = await c.call('GET', '/editbox/api/me');
    assert.strictEqual(me.body.me.email, 'client@example.com');
    assert.strictEqual(me.body.me.role, 'client');

    assert.strictEqual((await c.call('POST', '/editbox/api/projects', { title: 'x' }, { 'X-EditBox': '' })).status, 403, 'CSRF header required');
    const created = await c.call('POST', '/editbox/api/projects', { title: 'Recap film', deliverable: 'corporate', finishedMinutes: 2, footageMinutes: 60, description: 'Two minute recap' });
    assert.strictEqual(created.status, 200);
    const id = created.body.project.id;
    assert.ok(s.sent.some((m) => m.to === 'editor@dwim.test' && /New request/.test(m.subject)));

    assert.strictEqual((await x.call('GET', '/editbox/api/projects/' + id)).status, 404, 'other clients cannot see it');
    assert.strictEqual((await x.call('GET', '/editbox/api/projects')).body.projects.length, 0);

    const up = await c.call('POST', '/editbox/api/projects/' + id + '/uploads', { name: 'A001.mov', size: 11, type: 'video/quicktime', kind: 'source' });
    assert.strictEqual(up.status, 200);
    const put = await fetch(s.base + up.body.upload.url, { method: 'PUT', body: 'hello world' });
    assert.strictEqual(put.status, 200);
    await c.call('POST', '/editbox/api/projects/' + id + '/assets/' + up.body.asset.id + '/complete', {});
    const file = await e.call('GET', '/editbox/api/projects/' + id + '/assets/' + up.body.asset.id + '/file', undefined, { Range: 'bytes=0-4' });
    assert.strictEqual(file.status, 206);
    assert.strictEqual(file.body, 'hello');
    assert.strictEqual((await x.call('GET', '/editbox/api/projects/' + id + '/assets/' + up.body.asset.id + '/file')).status, 404);

    assert.strictEqual((await c.call('POST', '/editbox/api/projects/' + id + '/estimate', { low: 4, high: 6 })).status, 403);
    const est = await e.call('POST', '/editbox/api/projects/' + id + '/estimate', { low: 4, high: 6, note: 'Simple cut.' });
    assert.strictEqual(est.body.project.status, 'estimated');

    assert.strictEqual((await c.call('POST', '/editbox/api/projects/' + id + '/checkout', { packId: 'p5' })).status, 200);
    const chk = await c.call('POST', '/editbox/api/projects/' + id + '/checkout', { packId: 'p5' });
    assert.strictEqual(chk.body.mock, true);
    assert.strictEqual((await x.call('POST', '/editbox/api/checkouts/' + chk.body.checkoutId + '/confirm-mock', {})).status, 404);
    const paid = await c.call('POST', '/editbox/api/checkouts/' + chk.body.checkoutId + '/confirm-mock', {});
    assert.strictEqual(paid.body.project.status, 'active');
    assert.strictEqual(paid.body.project.balance, 5);
    await c.call('POST', '/editbox/api/checkouts/' + chk.body.checkoutId + '/confirm-mock', {});
    assert.strictEqual((await c.call('GET', '/editbox/api/projects/' + id)).body.project.balance, 5, 'confirming twice credits once');

    await c.call('POST', '/editbox/api/projects/' + id + '/messages', { body: 'Logo attached by link.' });
    await e.call('POST', '/editbox/api/projects/' + id + '/messages', { body: 'Got it.' });
    const ver = await e.call('POST', '/editbox/api/projects/' + id + '/versions', { label: 'Rough cut', durationSec: 40 });
    const vid = ver.body.result.id;
    await c.call('POST', '/editbox/api/projects/' + id + '/versions/' + vid + '/comments', { t: 3.2, body: 'Shorter intro' });
    await c.call('POST', '/editbox/api/projects/' + id + '/versions/' + vid + '/status', { status: 'approved' });
    const burned = await e.call('POST', '/editbox/api/projects/' + id + '/burn', { hours: 5, note: 'Edit and export' });
    assert.strictEqual(burned.body.project.status, 'depleted');
    assert.ok(s.sent.some((m) => m.to === 'client@example.com' && /used up/.test(m.subject)));

    const p = burned.body.project;
    assert.ok(p.messages.filter((m) => !m.system).length >= 3, 'chat is logged');
    assert.ok(p.assets.every((a) => !('key' in a)), 'storage keys not exposed');

    const sub = await c.call('POST', '/editbox/api/projects/' + id + '/archive/subscribe', {});
    const arch = await c.call('POST', '/editbox/api/checkouts/' + sub.body.checkoutId + '/confirm-mock', {});
    assert.strictEqual(arch.body.project.status, 'archived');

    s.advance(31 * DAY);
    assert.strictEqual((await e.call('GET', '/editbox/api/projects')).status, 401, '30-day session expired');
    await e.login('editor@dwim.test');
    await c.login('client@example.com');
    const rep = (await e.call('POST', '/editbox/api/admin/retention', {})).body.report;
    assert.strictEqual(rep.sourcePurged.length, 1);
    assert.ok(!fs.existsSync(path.join(s.dir, 'files', id, up.body.asset.id, 'A001.mov')), 'source file deleted from disk');
    assert.strictEqual((await c.call('POST', '/editbox/api/admin/retention', {})).status, 403);
  } finally { await s.close(); }
});

test('live server: static whitelist never exposes data or server code', async () => {
  const s = await boot();
  try {
    const c = client(s.base);
    assert.strictEqual((await c.call('GET', '/editbox/')).status, 200);
    assert.strictEqual((await c.call('GET', '/editbox')).status, 301);
    assert.match((await c.call('GET', '/editbox/static/config.js')).body, /"mode":"live"/);
    for (const p of ['/editbox/server/server.js', '/editbox/data/db.json', '/.git/config', '/editbox/package.json', '/editbox/static/../server/env.js', '/PLAN.md']) {
      assert.strictEqual((await c.call('GET', p)).status, 404, p);
    }
  } finally { await s.close(); }
});

test('stripe webhook: signature required, credits hours once', async () => {
  const s = await boot({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  try {
    const c = client(s.base), e = client(s.base);
    await c.login('c@example.com');
    await e.login('editor@dwim.test');
    const id = (await c.call('POST', '/editbox/api/projects', { title: 'Spot', deliverable: 'spot' })).body.project.id;
    await e.call('POST', '/editbox/api/projects/' + id + '/estimate', { low: 6, high: 9, minHours: 5 });
    const evt = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 47500, metadata: { kind: 'hours', projectId: id, packId: 'p5' } } } });
    const bad = await fetch(s.base + '/editbox/api/stripe/webhook', { method: 'POST', body: evt, headers: { 'Stripe-Signature': 't=1,v1=00' } });
    assert.strictEqual(bad.status, 400);
    const t = Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + evt).digest('hex');
    for (let i = 0; i < 2; i++) {
      const ok = await fetch(s.base + '/editbox/api/stripe/webhook', { method: 'POST', body: evt, headers: { 'Stripe-Signature': 't=' + t + ',v1=' + sig } });
      assert.strictEqual(ok.status, 200);
    }
    const p = (await c.call('GET', '/editbox/api/projects/' + id)).body.project;
    assert.strictEqual(p.balance, 5);
    assert.strictEqual(p.ledger[0].source, 'stripe');
    assert.match(p.messages.find((m) => m.kind === 'purchase').body, /Paid via Stripe/);
  } finally { await s.close(); }
});

test('S3 presign matches the AWS documented example', () => {
  const url = presign({ bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'GET', 'test.txt', { expires: 86400, now: Date.parse('2013-05-24T00:00:00Z') });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('stripe form encoding nests objects', () => {
  assert.strictEqual(stripe.form({ a: 1, line_items: { 0: { price: 'p', quantity: 1 } } }), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1');
});

test('agent API: bearer auth, inbox, packet with media URLs, upload render, post version, burn', async () => {
  const s = await boot({ EDITBOX_AGENT_KEYS: 'grok-bot:test-agent-key-0123456789' });
  try {
    const c = client(s.base), e = client(s.base);
    const A = { Authorization: 'Bearer test-agent-key-0123456789', 'X-EditBox': '' };
    await c.login('c@example.com');
    await e.login('editor@dwim.test');
    const id = (await c.call('POST', '/editbox/api/projects', { title: 'Promo', deliverable: 'spot', handoff: 'resolve', resolution: '2160p', fps: '24' })).body.project.id;
    const up = await c.call('POST', '/editbox/api/projects/' + id + '/uploads', { name: 'A001.mov', size: 4, kind: 'source' });
    await fetch(up.body.upload.absoluteUrl, { method: 'PUT', body: 'clip' });
    await c.call('POST', '/editbox/api/projects/' + id + '/assets/' + up.body.asset.id + '/complete', {});

    assert.strictEqual((await c.call('GET', '/editbox/api/agent/jobs', undefined, { Authorization: 'Bearer wrong-key-wrong-key' })).status, 401);
    assert.strictEqual((await c.call('GET', '/editbox/api/agent/jobs/' + id, undefined, A)).status, 404, 'not handed over yet');
    assert.deepStrictEqual((await e.call('GET', '/editbox/api/me')).body.agents, ['grok-bot']);
    assert.strictEqual((await e.call('POST', '/editbox/api/projects/' + id + '/work/assign', { agent: 'nobody' })).status, 400);
    await e.call('POST', '/editbox/api/projects/' + id + '/estimate', { low: 4, high: 5 });
    await e.call('POST', '/editbox/api/projects/' + id + '/work/assign', { agent: 'grok-bot', instructions: 'Resolve timeline at 24p.' });
    const chk = await c.call('POST', '/editbox/api/projects/' + id + '/checkout', { packId: 'p5' });
    await c.call('POST', '/editbox/api/checkouts/' + chk.body.checkoutId + '/confirm-mock', {});

    const inbox = (await c.call('GET', '/editbox/api/agent/jobs', undefined, A)).body.jobs;
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].task, 'first_cut');
    const job = (await c.call('GET', '/editbox/api/agent/jobs/' + id, undefined, A)).body.job;
    assert.strictEqual(job.delivery.handoff, 'resolve');
    assert.strictEqual(job.work.instructions, 'Resolve timeline at 24p.');
    const media = await fetch(job.media[0].url, { headers: { Authorization: A.Authorization } });
    assert.strictEqual(await media.text(), 'clip');
    const md = await c.call('GET', '/editbox/api/agent/jobs/' + id + '?format=md', undefined, A);
    assert.match(md.body, /# Edit Box job: Promo/);

    assert.strictEqual((await c.call('POST', '/editbox/api/agent/jobs/' + id + '/claim', {}, A)).body.project.work.state, 'in_edit');
    const rup = await c.call('POST', '/editbox/api/projects/' + id + '/uploads', { name: 'v1.mp4', size: 5, type: 'video/mp4', kind: 'render' }, A);
    await fetch(rup.body.upload.absoluteUrl, { method: 'PUT', body: 'video' });
    await c.call('POST', '/editbox/api/projects/' + id + '/assets/' + rup.body.asset.id + '/complete', {}, A);
    const ver = await c.call('POST', '/editbox/api/projects/' + id + '/versions', { label: 'First cut', assetId: rup.body.asset.id, durationSec: 30 }, A);
    assert.strictEqual(ver.body.project.work.state, 'awaiting_client');
    const burn = await c.call('POST', '/editbox/api/projects/' + id + '/burn', { hours: 1.5, note: 'Assembly in Resolve' }, A);
    assert.strictEqual(burn.body.project.balance, 3.5);
    assert.strictEqual((await c.call('POST', '/editbox/api/projects/' + id + '/estimate', { low: 1, high: 2 }, A)).status, 403);
    assert.strictEqual((await c.call('POST', '/editbox/api/projects/' + id + '/checkout', { packId: 'p5' }, A)).status, 403);
    await c.call('POST', '/editbox/api/projects/' + id + '/work', { state: 'needs_editor', note: 'Need the logo file' }, A);
    assert.ok(s.sent.some((m) => m.to === 'editor@dwim.test' && /Agent needs you/.test(m.subject)));
  } finally { await s.close(); }
});
