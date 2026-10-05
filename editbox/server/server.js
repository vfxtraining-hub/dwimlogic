'use strict';
/* The Edit Box live server. Zero dependencies, Node 18+.
 * Serves the DWIM Logic site and /editbox, plus the JSON API under /editbox/api. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../static/core.js');
const env = require('./env.js');
const Store = require('./db.js');
const Storage = require('./storage.js');
const stripe = require('./stripe.js');
const Mail = require('./mail.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8'
};
const STATIC_ROUTES = [
  [/^\/$/, 'index.html'],
  [/^\/(favicon\.svg|favicon\.ico|favicon-32\.png|apple-touch-icon\.png|site\.webmanifest)$/, null],
  [/^\/assets\/[\w./-]+\.(jpg|png|svg)$/, null],
  [/^\/editbox\/$/, 'editbox/index.html'],
  [/^\/editbox\/portal\/$/, 'editbox/portal/index.html'],
  [/^\/editbox\/studio\/$/, 'editbox/studio/index.html'],
  [/^\/editbox\/static\/[\w.-]+\.(js|css|svg)$/, null]
];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length < 200;

function createApp(cfg, deps) {
  deps = deps || {};
  const now = deps.now || (() => Date.now());
  const store = Store.open(cfg.dataDir);
  const storage = Storage.create(cfg.storage, cfg.dataDir);
  const mail = deps.mail || Mail.create(cfg.mail);
  const payments = cfg.stripe.secretKey ? 'stripe' : 'mock';
  const secure = cfg.baseUrl.startsWith('https://');
  const loginHits = new Map();
  const agentKeys = cfg.agents.map((a) => ({ name: a.name, hash: sha(a.key) }));
  if (cfg.production && payments === 'mock') console.warn('[editbox] STRIPE_SECRET_KEY is not set: checkout runs in mock mode and charges nothing.');
  if (!cfg.adminEmails.length) console.warn('[editbox] EDITBOX_ADMIN_EMAILS is empty: nobody can open the studio.');

  /* ---------- http helpers ---------- */
  function send(res, status, body, headers) {
    const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
    res.writeHead(status, Object.assign({
      'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    }, headers || {}));
    res.end(isBuf ? body : JSON.stringify(body));
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function json(req) {
    const raw = await readBody(req, 1 << 20);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { throw core.EditBoxError(400, 'Invalid JSON.'); }
  }
  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  function sessionCookie(value, maxAge) {
    return 'eb_session=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
  }

  /* ---------- auth ---------- */
  function roleFor(email) { return cfg.adminEmails.includes(email) ? 'editor' : 'client'; }
  function actorFrom(req) {
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (auth) {
      const h = Buffer.from(sha(auth[1].trim()));
      const a = agentKeys.find((k) => crypto.timingSafeEqual(Buffer.from(k.hash), h));
      return a ? { email: 'agent:' + a.name, role: 'agent', name: a.name } : null;
    }
    const t = cookies(req).eb_session;
    if (!t) return null;
    const h = sha(t);
    const s = store.db.sessions.find((x) => x.hash === h && x.expiresAt > now());
    if (!s) return null;
    return { email: s.email, role: roleFor(s.email), name: s.email };
  }
  function need(actor) { if (!actor) throw core.EditBoxError(401, 'Sign in first.'); return actor; }
  function needEditor(actor) { need(actor); if (actor.role !== 'editor') throw core.EditBoxError(403, 'Editor only.'); return actor; }

  async function notify(p, actor, subject, text) {
    try {
      const link = cfg.baseUrl + '/editbox/' + (actor && actor.role === 'client' ? 'studio' : 'portal') + '/#/p/' + p.id;
      const to = actor && actor.role === 'client' ? cfg.adminEmails : actor && actor.toEditor ? cfg.adminEmails : [p.clientEmail];
      for (const addr of to) await mail.send(addr, '[The Edit Box] ' + subject + ': ' + p.title, text + '\n\nOpen the project: ' + link + '\n\nDWIM Logic · The Edit Box');
    } catch (e) { console.error('[editbox] notify failed', e.message); }
  }

  /* ---------- retention ---------- */
  async function retention(dryRun) {
    const report = await store.tx((db) => core.runRetention(db, now(), { dryRun }));
    if (!dryRun) {
      for (const key of report.deleteKeys) {
        try { await storage.remove(key); } catch (e) { console.error('[editbox] could not delete', key, e.message); }
      }
    }
    return report;
  }

  /* ---------- api ---------- */
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^/editbox/api' + pattern + '$'), fn });

  on('GET', '/config', async () => clientConfig());
  on('GET', '/me', async ({ actor }) => ({ me: actor, devLogin: cfg.devLogin, agents: actor && actor.role === 'editor' ? agentKeys.map((a) => a.name) : undefined }));

  on('POST', '/auth/request', async ({ body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) throw core.EditBoxError(400, 'Enter a valid email address.');
    const hits = (loginHits.get(email) || []).filter((t) => t > now() - 15 * 60000);
    if (hits.length >= 5) throw core.EditBoxError(429, 'Too many sign-in links. Try again in a few minutes.');
    hits.push(now()); loginHits.set(email, hits);
    const t = token();
    const nextPath = body.next === 'studio' ? 'studio' : 'portal';
    await store.tx((db) => {
      db.tokens = db.tokens.filter((x) => x.expiresAt > now() && !x.usedAt);
      db.tokens.push({ hash: sha(t), email, next: nextPath, expiresAt: now() + 20 * 60000, usedAt: null });
    });
    const link = cfg.baseUrl + '/editbox/api/auth/verify?token=' + t;
    await mail.send(email, 'Your sign-in link for The Edit Box', 'Open this link to sign in (valid for 20 minutes, one use):\n\n' + link + '\n\nIf you did not ask for it, ignore this email.');
    return cfg.devLogin ? { ok: true, devLink: link } : { ok: true };
  });

  on('GET', '/auth/verify', async ({ url, res }) => {
    const t = url.searchParams.get('token') || '';
    const result = await store.tx((db) => {
      const rec = db.tokens.find((x) => x.hash === sha(t));
      if (!rec || rec.usedAt || rec.expiresAt < now()) return null;
      rec.usedAt = now();
      const s = token();
      db.sessions = db.sessions.filter((x) => x.expiresAt > now());
      db.sessions.push({ hash: sha(s), email: rec.email, createdAt: now(), expiresAt: now() + 30 * 86400000 });
      return { s, next: roleFor(rec.email) === 'editor' && rec.next === 'studio' ? 'studio' : 'portal' };
    });
    if (!result) { send(res, 302, '', { Location: '/editbox/portal/#/login?expired=1' }); return null; }
    send(res, 302, '', { Location: '/editbox/' + result.next + '/', 'Set-Cookie': sessionCookie(result.s, 30 * 86400) });
    return null;
  });

  on('POST', '/auth/logout', async ({ req, res }) => {
    const t = cookies(req).eb_session;
    if (t) await store.tx((db) => { db.sessions = db.sessions.filter((x) => x.hash !== sha(t)); });
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    return null;
  });

  on('GET', '/projects', async ({ actor }) => ({ projects: core.listProjects(store.db, need(actor)).map(core.publicProject) }));
  on('POST', '/projects', async ({ actor, body }) => {
    need(actor);
    const p = await store.tx((db) => core.createProject(db, actor, body, now()));
    notify(p, actor, 'New request', 'New Edit Box request from ' + p.clientEmail + '.\n\n' + (p.brief.description || ''));
    return { project: core.publicProject(p) };
  });
  on('GET', '/projects/(\\w+)', async ({ actor, m }) => ({ project: core.publicProject(core.find(store.db, need(actor), m[1])) }));

  const mutate = (fn) => async (ctx) => {
    need(ctx.actor);
    const out = await store.tx((db) => fn(db, ctx));
    return { project: core.publicProject(core.find(store.db, ctx.actor, ctx.m[1])), result: out && out.id ? out : undefined };
  };

  on('POST', '/projects/(\\w+)/messages', mutate((db, { actor, m, body }) => {
    const msg = core.postMessage(db, actor, m[1], body.body, now());
    notify(core.find(db, actor, m[1]), actor, 'New message', msg.body);
    return msg;
  }));
  on('POST', '/projects/(\\w+)/estimate', mutate((db, { actor, m, body }) => {
    const p = core.sendEstimate(db, actor, m[1], body, now());
    notify(p, actor, 'Your free estimate', 'Estimate: ' + core.hrs(p.estimate.low) + ' to ' + core.hrs(p.estimate.high) + '. Prepay at least ' + core.hrs(p.estimate.minHours) + ' to start.');
  }));
  on('POST', '/projects/(\\w+)/burn', mutate((db, { actor, m, body }) => {
    const p = core.burnHours(db, actor, m[1], body, now());
    if (p.status === 'depleted') notify(p, actor, 'Prepaid hours used up', core.nextStep(p, 'client'));
  }));
  on('POST', '/projects/(\\w+)/links', mutate((db, { actor, m, body }) => core.addAsset(db, actor, m[1], { kind: body.kind || 'source', url: body.url, name: body.name }, now())));
  on('POST', '/projects/(\\w+)/versions', mutate((db, { actor, m, body }) => {
    const v = core.postVersion(db, actor, m[1], body, now());
    notify(core.find(db, actor, m[1]), actor, 'Version ' + v.n + ' ready for review', v.label + (v.note ? '\n\n' + v.note : ''));
    return v;
  }));
  on('POST', '/projects/(\\w+)/versions/(\\w+)/comments', mutate((db, { actor, m, body }) => core.addComment(db, actor, m[1], m[2], body, now())));
  on('POST', '/projects/(\\w+)/versions/(\\w+)/comments/(\\w+)/resolve', mutate((db, { actor, m }) => core.resolveComment(db, actor, m[1], m[2], m[3], now())));
  on('POST', '/projects/(\\w+)/versions/(\\w+)/status', mutate((db, { actor, m, body }) => {
    const v = core.setVersionStatus(db, actor, m[1], m[2], body.status, now());
    notify(core.find(db, actor, m[1]), actor, v.status === 'approved' ? 'Version ' + v.n + ' approved' : 'Changes requested on version ' + v.n, '');
  }));
  on('POST', '/projects/(\\w+)/archive/decline', mutate((db, { actor, m }) => core.declineArchive(db, actor, m[1], now())));
  on('POST', '/projects/(\\w+)/archive/cancel', async (ctx) => {
    const p = core.find(store.db, need(ctx.actor), ctx.m[1]);
    if (p.archive.source === 'stripe' && p.archive.subscriptionId) await stripe.cancelAtPeriodEnd(cfg.stripe, p.archive.subscriptionId);
    return mutate((db, { actor, m }) => core.cancelArchive(db, actor, m[1], now()))(ctx);
  });

  /* Uploads: create a pending asset, hand the browser an upload target, then mark it complete. */
  on('POST', '/projects/(\\w+)/uploads', async ({ actor, m, body }) => {
    need(actor);
    const size = Number(body.size) || 0;
    if (size > cfg.storage.maxUploadMb * 1048576) throw core.EditBoxError(413, 'That file is over the ' + cfg.storage.maxUploadMb + ' MB limit. Send a transfer link instead.');
    const out = await store.tx((db) => {
      const assetId = core.id('ast');
      const clean = String(body.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
      const key = m[1] + '/' + assetId + '/' + clean;
      const a = core.addAsset(db, actor, m[1], { id: assetId, kind: body.kind, name: body.name, size, type: body.type, key, ready: false }, now());
      const t = token();
      db.uploads.push({ hash: sha(t), projectId: m[1], assetId, key, email: actor.email, maxSize: size || cfg.storage.maxUploadMb * 1048576, expiresAt: now() + 6 * 3600000 });
      const target = storage.uploadTarget(key, t);
      target.absoluteUrl = target.url.startsWith('/') ? cfg.baseUrl + target.url : target.url;
      return { asset: a, upload: target };
    });
    return { asset: Object.assign({}, out.asset, { key: undefined }), upload: out.upload };
  });
  on('POST', '/projects/(\\w+)/assets/(\\w+)/complete', mutate((db, { actor, m }) => {
    const a = core.markAssetReady(db, actor, m[1], m[2], now());
    db.uploads = db.uploads.filter((u) => u.assetId !== a.id);
    if (a.kind === 'source' || a.kind === 'deliverable') notify(core.find(db, actor, m[1]), actor, 'File uploaded', a.name);
    return a;
  }));

  on('GET', '/projects/(\\w+)/assets/(\\w+)/file', async ({ actor, m, req, res }) => {
    need(actor);
    const a = await store.tx((db) => core.touchAsset(db, actor, m[1], m[2], now()));
    if (!a.key || !a.ready) throw core.EditBoxError(404, 'This file is not available.');
    if (storage.driver === 's3') { send(res, 302, '', { Location: storage.downloadUrl(a.key, a.name) }); return null; }
    streamFile(req, res, storage.filePath(a.key), a.type || MIME[path.extname(a.name).toLowerCase()] || 'application/octet-stream', a.name);
    return null;
  });

  /* Payments */
  on('POST', '/projects/(\\w+)/checkout', async ({ actor, m, body }) => {
    need(actor);
    const p = core.find(store.db, actor, m[1]);
    if (actor.role !== 'client') throw core.EditBoxError(403, 'Only the client can buy hours.');
    if (!p.estimate) throw core.EditBoxError(409, 'Wait for the estimate first.');
    const pack = core.packById(body.packId);
    if (!pack) throw core.EditBoxError(400, 'Unknown hour pack.');
    if (p.status === 'estimated' && pack.hours < p.estimate.minHours) throw core.EditBoxError(400, 'This job needs at least ' + core.hrs(p.estimate.minHours) + ' to start.');
    return startCheckout(actor, p, { kind: 'hours', packId: pack.id }, () => stripe.hoursSession(cfg.stripe, {
      project: p, pack, email: actor.email,
      successUrl: cfg.baseUrl + '/editbox/portal/#/p/' + p.id + '?paid=1', cancelUrl: cfg.baseUrl + '/editbox/portal/#/p/' + p.id
    }));
  });
  on('POST', '/projects/(\\w+)/archive/subscribe', async ({ actor, m }) => {
    need(actor);
    const p = core.find(store.db, actor, m[1]);
    if (actor.role !== 'client') throw core.EditBoxError(403, 'Only the client can subscribe.');
    if (!core.subscribeArchiveAllowed(p)) throw core.EditBoxError(409, 'An archive subscription is not available for this project right now.');
    return startCheckout(actor, p, { kind: 'archive' }, () => stripe.archiveSession(cfg.stripe, {
      project: p, priceCents: core.PRICING.archive.priceCents, interval: core.PRICING.archive.interval, email: actor.email,
      successUrl: cfg.baseUrl + '/editbox/portal/#/p/' + p.id + '?archived=1', cancelUrl: cfg.baseUrl + '/editbox/portal/#/p/' + p.id
    }));
  });

  async function startCheckout(actor, p, info, makeStripe) {
    const rec = Object.assign({ id: core.id('chk'), projectId: p.id, email: actor.email, status: 'open', createdAt: now() }, info);
    if (payments === 'stripe') {
      const s = await makeStripe();
      rec.stripeSessionId = s.id;
      await store.tx((db) => { db.checkouts.push(rec); });
      return { url: s.url };
    }
    await store.tx((db) => { db.checkouts.push(rec); });
    return { mock: true, checkoutId: rec.id };
  }

  on('POST', '/checkouts/(\\w+)/confirm-mock', async ({ actor, m }) => {
    need(actor);
    if (payments !== 'mock') throw core.EditBoxError(404, 'Not available.');
    const id = m[1];
    const p = await store.tx((db) => {
      const c = db.checkouts.find((x) => x.id === id && x.email === actor.email);
      if (!c) throw core.EditBoxError(404, 'Checkout not found.');
      if (c.status === 'complete') return core.find(db, actor, c.projectId);
      c.status = 'complete';
      if (c.kind === 'hours') return core.creditHours(db, c.projectId, { packId: c.packId, source: 'mock', ref: c.id, amountCents: 0 }, now());
      return core.activateArchive(db, c.projectId, { source: 'mock' }, now());
    });
    return { project: core.publicProject(p) };
  });

  on('POST', '/stripe/webhook', async ({ req, res }) => {
    const raw = await readBody(req, 1 << 20);
    if (!stripe.verifyWebhook(raw, req.headers['stripe-signature'], cfg.stripe.webhookSecret, now())) { send(res, 400, { error: 'Bad signature' }); return null; }
    const evt = JSON.parse(raw);
    await handleStripeEvent(evt);
    send(res, 200, { received: true });
    return null;
  });

  async function handleStripeEvent(evt) {
    const o = evt.data && evt.data.object;
    if (!o) return;
    if (store.db.events.includes(evt.id)) return;
    if (evt.type === 'checkout.session.completed' && o.metadata && o.payment_status !== 'unpaid') {
      let periodEnd = null;
      if (o.metadata.kind === 'archive' && o.subscription && cfg.stripe.secretKey) {
        try {
          const sub = await stripe.getSubscription(cfg.stripe, o.subscription);
          periodEnd = 1000 * (sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end) || 0) || null;
        } catch (e) { console.error('[editbox] subscription lookup failed', e.message); }
      }
      await store.tx((db) => {
        db.events.push(evt.id);
        const c = db.checkouts.find((x) => x.stripeSessionId === o.id);
        if (c) c.status = 'complete';
        if (o.metadata.kind === 'hours') core.creditHours(db, o.metadata.projectId, { packId: o.metadata.packId, source: 'stripe', ref: o.id, amountCents: o.amount_total }, now());
        if (o.metadata.kind === 'archive') core.activateArchive(db, o.metadata.projectId, { source: 'stripe', subscriptionId: o.subscription, customerId: o.customer, currentPeriodEnd: periodEnd }, now());
      });
    }
    if (evt.type === 'customer.subscription.updated' || evt.type === 'customer.subscription.deleted') {
      const end = o.current_period_end || (o.items && o.items.data && o.items.data[0] && o.items.data[0].current_period_end);
      await store.tx((db) => {
        db.events.push(evt.id);
        core.syncArchive(db, o.id, { status: evt.type.endsWith('deleted') ? 'canceled' : o.status, cancelAtPeriodEnd: !!o.cancel_at_period_end, currentPeriodEnd: end ? end * 1000 : null }, now());
      });
    }
    if (store.db.events.length > 5000) store.db.events.splice(0, 1000);
  }

  /* Agent workflow. Agents authenticate with Authorization: Bearer <key> and only see jobs handed to them. */
  function fileUrlFor(p) {
    return (a) => storage.driver === 's3' && a.key ? storage.downloadUrl(a.key, a.name)
      : cfg.baseUrl + '/editbox/api/projects/' + p.id + '/assets/' + a.id + '/file';
  }
  function packet(p, format, res) {
    const k = core.jobPacket(p, fileUrlFor(p));
    k.api = {
      base: cfg.baseUrl + '/editbox/api',
      claim: 'POST /agent/jobs/' + p.id + '/claim',
      state: 'POST /projects/' + p.id + '/work {state: in_edit|awaiting_client|needs_editor, note}',
      message: 'POST /projects/' + p.id + '/messages {body}',
      upload: 'POST /projects/' + p.id + '/uploads {name,size,type,kind: render|deliverable|project} then PUT the file to upload.absoluteUrl, then POST /projects/' + p.id + '/assets/{assetId}/complete',
      version: 'POST /projects/' + p.id + '/versions {label, note, assetId, durationSec, timelineAssetId}',
      burn: 'POST /projects/' + p.id + '/burn {hours, note}'
    };
    if (format === 'md') { send(res, 200, core.jobPacketMarkdown(k), { 'Content-Type': 'text/markdown; charset=utf-8' }); return null; }
    return { job: k };
  }
  on('GET', '/agent/jobs', async ({ actor }) => {
    need(actor);
    if (actor.role !== 'agent') throw core.EditBoxError(403, 'Agent key required.');
    return { jobs: core.agentInbox(store.db, actor).map((p) => ({ id: p.id, title: p.title, state: p.work.state, task: p.work.task, taskLabel: core.WORK_TASKS[p.work.task] || null, clientWaiting: !!p.work.clientWaiting, balance: core.balance(p), updatedAt: p.updatedAt })) };
  });
  on('GET', '/agent/jobs/(\\w+)', async ({ actor, m, url, res }) => {
    need(actor);
    if (!core.isStaff(actor)) throw core.EditBoxError(403, 'Agent or editor only.');
    return packet(core.find(store.db, actor, m[1]), url.searchParams.get('format'), res);
  });
  on('POST', '/agent/jobs/(\\w+)/claim', mutate((db, { actor, m }) => core.claimWork(db, actor, m[1], now())));
  on('POST', '/projects/(\\w+)/work/assign', mutate((db, { actor, m, body }) => {
    if (body.agent && !agentKeys.some((a) => a.name === body.agent)) throw core.EditBoxError(400, 'Unknown agent. Add it to EDITBOX_AGENT_KEYS.');
    return core.assignWork(db, actor, m[1], body, now());
  }));
  on('POST', '/projects/(\\w+)/work', mutate((db, { actor, m, body }) => {
    const p = core.updateWork(db, actor, m[1], body, now());
    if (body.state === 'needs_editor') notify(p, Object.assign({}, actor, { toEditor: true }), 'Agent needs you', body.note || 'The agent flagged this job.');
  }));

  on('POST', '/admin/retention', async ({ actor, body }) => { needEditor(actor); return { report: await retention(!!body.dryRun) }; });

  /* ---------- static ---------- */
  function clientConfig() {
    return {
      mode: 'live', payments, storage: storage.driver, devLogin: cfg.devLogin,
      pricing: core.PRICING, retention: core.RETENTION
    };
  }
  function streamFile(req, res, file, type, downloadName) {
    let st;
    try { st = fs.statSync(file); } catch (e) { send(res, 404, 'Not found'); return; }
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    if (downloadName) headers['Content-Disposition'] = 'inline; filename="' + String(downloadName).replace(/["\\\r\n]/g, '') + '"';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, Object.assign(headers, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 }));
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }
  function serveStatic(req, res, pathname) {
    if (pathname === '/editbox' || pathname === '/editbox/portal' || pathname === '/editbox/studio') { send(res, 301, '', { Location: pathname + '/' }); return; }
    if (pathname === '/editbox/static/config.js') {
      send(res, 200, 'window.EDITBOX_CONFIG=' + JSON.stringify(clientConfig()) + ';\n', { 'Content-Type': 'text/javascript; charset=utf-8' });
      return;
    }
    for (const [re, file] of STATIC_ROUTES) {
      if (!re.test(pathname)) continue;
      const rel = file || pathname.slice(1);
      const abs = path.resolve(cfg.root, rel);
      if (!abs.startsWith(cfg.root + path.sep)) break;
      res.setHeader('Cache-Control', /\.html$/.test(abs) ? 'no-cache' : 'public, max-age=300');
      streamFile(req, res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      return;
    }
    send(res, 404, 'Not found');
  }

  /* ---------- upload sink for the local driver ---------- */
  function receiveUpload(req, res, t) {
    const u = store.db.uploads.find((x) => x.hash === sha(t) && x.expiresAt > now());
    if (!u || storage.driver !== 'local') { send(res, 404, { error: 'Upload link expired.' }); return; }
    const file = storage.filePath(u.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file);
    let size = 0, failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > u.maxSize + 1024 && !failed) { failed = true; out.destroy(); fs.rmSync(file, { force: true }); send(res, 413, { error: 'File is larger than declared.' }); req.destroy(); }
    });
    req.pipe(out);
    out.on('finish', () => { if (!failed) send(res, 200, { ok: true, size }); });
    out.on('error', () => { if (!failed) send(res, 500, { error: 'Could not store the file.' }); });
  }

  /* ---------- router ---------- */
  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (!pathname.startsWith('/editbox/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Method not allowed'); return; }
        serveStatic(req, res, pathname);
        return;
      }
      const up = /^\/editbox\/api\/upload\/([\w-]+)$/.exec(pathname);
      if (up && req.method === 'PUT') { receiveUpload(req, res, up[1]); return; }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const isWebhook = pathname === '/editbox/api/stripe/webhook';
        const bearer = /^Bearer\s/i.test(req.headers.authorization || '');
        if (req.method === 'POST' && !isWebhook && !bearer && req.headers['x-editbox'] !== '1') throw core.EditBoxError(403, 'Missing request header.');
        const body = req.method === 'POST' && !isWebhook ? await json(req) : {};
        const out = await r.fn({ req, res, url, m, body, actor: actorFrom(req) });
        if (out !== null) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!e.status || e.status >= 500) console.error('[editbox]', e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
    }
  }

  return { handler, store, storage, retention, handleStripeEvent, cfg, payments };
}

if (require.main === module) {
  env.loadDotEnv(path.join(env.EDITBOX, '.env'));
  const cfg = env.config();
  const app = createApp(cfg);
  http.createServer(app.handler).listen(cfg.port, () => {
    console.log('The Edit Box on %s/editbox/  (payments: %s, storage: %s%s)', cfg.baseUrl, app.payments, app.storage.driver, cfg.devLogin ? ', dev login links shown on screen' : '');
  });
  if (cfg.retentionEveryHours > 0) {
    const tick = () => app.retention(false).then((r) => {
      if (r.sourcePurged.length || r.projectsPurged.length) console.log('[editbox retention]', JSON.stringify(r));
    }).catch((e) => console.error('[editbox retention]', e));
    setTimeout(tick, 5000);
    setInterval(tick, cfg.retentionEveryHours * 3600000).unref();
  }
}

module.exports = { createApp };
