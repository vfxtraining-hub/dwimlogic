/* The Edit Box: shared business rules.
 * Runs unchanged in the browser (demo mode, window.EditBoxCore) and in Node (live server, require()).
 * Every state change to a project goes through an op in this file, so demo and live behave the same.
 * All prices and retention windows below are editable placeholders. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditBoxCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;

  /* ---------- editable constants ---------- */

  var PRICING = {
    currency: 'usd',
    packs: [
      { id: 'p5', label: 'Starter', hours: 5, priceCents: 47500 },
      { id: 'p10', label: 'Standard', hours: 10, priceCents: 90000 },
      { id: 'p20', label: 'Production', hours: 20, priceCents: 170000 },
      { id: 'p40', label: 'Studio', hours: 40, priceCents: 320000 }
    ],
    minStartHours: 5,
    // the minimum to start is this share of the low estimate, rounded up to the next pack
    startShareOfEstimate: 0.5,
    burnIncrement: 0.25,
    archive: { priceCents: 1900, interval: 'month', storageGb: 500 }
  };

  var RETENTION = {
    sourceUnusedDays: 30,
    sourceWarnDays: 7,
    depletedGraceDays: 14,
    declinedDownloadDays: 7,
    lapsedArchiveGraceDays: 7,
    purgeWarnDays: 3
  };

  // Hours of editor time: base + per finished minute + per extra version, then footage review time.
  var DELIVERABLES = {
    social: { label: 'Social cutdowns and versions', base: 1, perFinishedMin: 1.5, perVersion: 0.5 },
    corporate: { label: 'Corporate, event or explainer edit', base: 2, perFinishedMin: 2, perVersion: 0.75 },
    spot: { label: 'Brand spot or promo', base: 4, perFinishedMin: 6, perVersion: 1 },
    longform: { label: 'Documentary or long form', base: 4, perFinishedMin: 1.2, perVersion: 2 },
    podcast: { label: 'Podcast or interview edit', base: 1, perFinishedMin: 0.4, perVersion: 0.5 },
    finish: { label: 'Color, sound and finishing only', base: 1, perFinishedMin: 1, perVersion: 0.5 },
    other: { label: 'Something else', base: 2, perFinishedMin: 1.5, perVersion: 0.75 }
  };
  var FOOTAGE_REVIEW_PER_HOUR = 1;
  var COMPLEXITY = { simple: 0.85, standard: 1, complex: 1.35 };
  var RUSH_MULTIPLIER = 1.25;

  // Work queue for the editor and the editing agent (Grok Bot, Cursor agents). Separate from the billing status.
  var WORK_STATES = {
    unassigned: 'Not assigned',
    queued_for_agent: 'Queued for agent',
    in_edit: 'In edit',
    awaiting_client: 'Awaiting client',
    needs_editor: 'Needs editor',
    paused_no_hours: 'Paused: no hours',
    done: 'Done'
  };
  // What the agent is expected to do next when it picks a job up.
  var WORK_TASKS = { first_cut: 'Cut the first version', revision: 'Address the open review notes', deliver_finals: 'Render and upload the final deliverables', reply: 'Reply to the client' };

  var DELIVERY = {
    resolution: { '1080p': '1920×1080 HD', '2160p': '3840×2160 UHD', vertical: '1080×1920 vertical', square: '1080×1080 square', source: 'Match source' },
    fps: ['23.976', '24', '25', '29.97', '30', '50', '59.94', 'source'],
    handoff: {
      render: 'Rendered files only (H.264 / ProRes)',
      resolve: 'Renders + DaVinci Resolve project (.drp)',
      xml: 'Renders + XML/AAF timeline for another NLE'
    }
  };

  var STAGES = [
    { id: 'requested', label: 'Request' },
    { id: 'estimated', label: 'Free estimate' },
    { id: 'active', label: 'Hours prepaid' },
    { id: 'depleted', label: 'Hours used' },
    { id: 'archived', label: 'Archived' }
  ];

  /* ---------- helpers ---------- */

  function EditBoxError(status, message) {
    var e = new Error(message);
    e.status = status;
    e.editbox = true;
    return e;
  }

  function id(prefix) {
    var a = '', c = typeof globalThis !== 'undefined' && globalThis.crypto;
    if (c && c.getRandomValues) {
      var b = new Uint8Array(12);
      c.getRandomValues(b);
      for (var i = 0; i < b.length; i++) a += (b[i] % 36).toString(36);
    } else {
      for (var j = 0; j < 12; j++) a += Math.floor(Math.random() * 36).toString(36);
    }
    return prefix + '_' + a;
  }

  function iso(now) { return new Date(now).toISOString(); }
  function ms(v) { return v ? Date.parse(v) : 0; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function roundUp(n, step) { return Math.ceil(n / step - 1e-9) * step; }
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 4000); }
  function num(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function money(cents) {
    var v = cents / 100;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function hrs(h) {
    var v = r2(h);
    return (v % 1 ? v.toFixed(2).replace(/0$/, '') : String(v)) + (v === 1 ? ' hr' : ' hrs');
  }

  function packById(packId) {
    for (var i = 0; i < PRICING.packs.length; i++) if (PRICING.packs[i].id === packId) return PRICING.packs[i];
    return null;
  }

  /* ---------- estimate ---------- */

  function estimate(input) {
    var d = DELIVERABLES[input.deliverable] || DELIVERABLES.other;
    var footageMin = num(input.footageMinutes, 0, 6000, 0);
    var finishedMin = num(input.finishedMinutes, 0.25, 600, 1);
    var versions = Math.round(num(input.versions, 1, 200, 1));
    var mult = COMPLEXITY[input.complexity] || 1;
    var core = d.base + d.perFinishedMin * finishedMin + d.perVersion * (versions - 1) + FOOTAGE_REVIEW_PER_HOUR * footageMin / 60;
    core *= mult;
    if (input.rush) core *= RUSH_MULTIPLIER;
    var low = Math.max(1, roundUp(core * 0.85, 0.5));
    var high = Math.max(low + 0.5, roundUp(core * 1.2, 0.5));
    return { low: low, high: high, minHours: minHoursToStart(low) };
  }

  function minHoursToStart(low) {
    var need = Math.max(PRICING.minStartHours, low * PRICING.startShareOfEstimate);
    for (var i = 0; i < PRICING.packs.length; i++) if (PRICING.packs[i].hours >= need) return PRICING.packs[i].hours;
    return PRICING.packs[PRICING.packs.length - 1].hours;
  }

  function packsFor(minHours) {
    return PRICING.packs.map(function (p) {
      return { id: p.id, label: p.label, hours: p.hours, priceCents: p.priceCents, perHourCents: Math.round(p.priceCents / p.hours), eligible: p.hours >= (minHours || 0) };
    });
  }

  /* ---------- derived state ---------- */

  function balance(p) {
    var b = 0;
    (p.ledger || []).forEach(function (e) { b += e.hours; });
    return r2(b);
  }

  function totals(p) {
    var bought = 0, used = 0, paid = 0;
    (p.ledger || []).forEach(function (e) {
      if (e.hours > 0) bought += e.hours; else used -= e.hours;
      if (e.amountCents) paid += e.amountCents;
    });
    return { bought: r2(bought), used: r2(used), balance: r2(bought - used), paidCents: paid };
  }

  function archiveActive(p) {
    return !!p.archive && (p.archive.status === 'active' || p.archive.status === 'canceling');
  }

  function liveAssets(p) { return (p.assets || []).filter(function (a) { return !a.purgedAt; }); }

  function sourceExpiry(a) {
    if (a.kind !== 'source' || a.purgedAt) return null;
    return ms(a.lastUsedAt || a.createdAt) + RETENTION.sourceUnusedDays * DAY;
  }

  function stageIndex(p) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === p.status) return i;
    return p.status === 'purged' ? STAGES.length : 0;
  }

  /* What should happen next, for the person looking. Drives the guided demo and the nudges in the UI. */
  function nextStep(p, role) {
    var editor = role === 'editor' || role === 'agent';
    if (editor && p.status === 'active' && p.work) {
      if (p.work.state === 'needs_editor') return 'The job is flagged for you: ' + (WORK_TASKS[p.work.task] || 'take a look') + '.';
      if (p.work.state === 'queued_for_agent') return 'Queued for ' + p.work.assignee.name + ': ' + (WORK_TASKS[p.work.task] || 'editing') + '.';
      if (p.work.state === 'in_edit' && p.work.assignee && p.work.assignee.kind === 'agent') return p.work.assignee.name + ' is editing: ' + (WORK_TASKS[p.work.task] || 'editing') + '.';
    }
    switch (p.status) {
      case 'requested':
        return editor ? 'Review the brief and footage, then send the free estimate.' : 'Your request is in. The editor reviews it and sends a free estimate.';
      case 'estimated':
        return editor ? 'Waiting for the client to prepay hours.' : 'Pick an hour pack (at least ' + hrs(p.estimate.minHours) + ') to start the job.';
      case 'active':
        if (!p.versions.length) return editor ? 'Cut the first version, post it for review and log the hours you spent.' : 'Work has started. The first version will appear under Versions.';
        var v = p.versions[p.versions.length - 1];
        if (v.status === 'in_review') return editor ? 'Version ' + v.n + ' is with the client. Log hours as you work.' : 'Review version ' + v.n + ' and leave timestamped notes, or approve it.';
        if (v.status === 'changes_requested') return editor ? 'The client asked for changes on version ' + v.n + '. Post the next version.' : 'Your notes are with the editor.';
        return editor ? 'Version ' + v.n + ' is approved. Deliver the finals and log the remaining hours.' : 'Version ' + v.n + ' is approved.';
      case 'depleted':
        if (p.archive && p.archive.declinedAt) return 'Files are removed on ' + new Date(p.purgeAfter).toDateString() + '. Download what you need.';
        return editor ? 'Hours are used up. The client has been offered an archive subscription.' : 'Hours are used up. Top up, or keep everything with an archive subscription.';
      case 'archived':
        return 'Archived. Project files, renders and finals stay while the subscription is active. Source footage is removed after ' + RETENTION.sourceUnusedDays + ' days unused.';
      case 'purged':
        return 'Project files were removed. The message log and hour ledger stay for your records. Start a new project any time.';
    }
    return '';
  }

  /* ---------- access ---------- */

  function isEditor(actor) { return !!actor && actor.role === 'editor'; }
  function isAgent(actor) { return !!actor && actor.role === 'agent'; }
  function isStaff(actor) { return isEditor(actor) || isAgent(actor); }
  function assignedTo(p, actor) {
    var a = p.work && p.work.assignee;
    return !!a && a.kind === 'agent' && a.name === actor.name;
  }

  /* Editors see everything, agents only the jobs handed to them, clients only their own. */
  function canSee(actor, p) {
    if (!actor) return false;
    if (isEditor(actor)) return true;
    if (isAgent(actor)) return assignedTo(p, actor);
    return p.clientEmail === String(actor.email || '').toLowerCase();
  }

  function find(db, actor, projectId) {
    var p = null;
    for (var i = 0; i < db.projects.length; i++) if (db.projects[i].id === projectId) { p = db.projects[i]; break; }
    if (!p || !canSee(actor, p)) throw EditBoxError(404, 'Project not found.');
    return p;
  }

  function requireEditor(actor) {
    if (!isEditor(actor)) throw EditBoxError(403, 'Only the editor can do that.');
  }

  function requireStaff(actor) {
    if (!isStaff(actor)) throw EditBoxError(403, 'Only the editor or the editing agent can do that.');
  }

  function requireOwner(actor, p) {
    if (isStaff(actor) || p.clientEmail !== String(actor.email || '').toLowerCase()) throw EditBoxError(403, 'Only the client can do that.');
  }

  function notPurged(p) {
    if (p.status === 'purged') throw EditBoxError(409, 'This project was closed and its files removed. Start a new project.');
  }

  function who(actor) {
    if (!actor) return { by: 'system', role: 'system' };
    return { by: actor.name || actor.email, role: actor.role };
  }

  function log(p, actor, body, now, extra) {
    var w = who(actor);
    var m = { id: id('msg'), by: w.by, role: w.role, body: body, at: iso(now), system: !actor || !!(extra && extra.system) };
    if (extra && extra.kind) m.kind = extra.kind;
    p.messages.push(m);
    p.updatedAt = iso(now);
    return m;
  }

  function sys(p, body, now, kind) { return log(p, null, body, now, { system: true, kind: kind }); }

  /* ---------- ops ---------- */

  function emptyDb() { return { schema: 1, projects: [] }; }

  function listProjects(db, actor) {
    return db.projects.filter(function (p) { return canSee(actor, p); })
      .sort(function (a, b) { return ms(b.updatedAt) - ms(a.updatedAt); });
  }

  function createProject(db, actor, input, now) {
    if (!actor || isStaff(actor)) throw EditBoxError(403, 'Sign in as a client to start a project.');
    var title = str(input.title, 120);
    if (!title) throw EditBoxError(400, 'Give the project a name.');
    var brief = {
      deliverable: DELIVERABLES[input.deliverable] ? input.deliverable : 'other',
      description: str(input.description, 6000),
      footageMinutes: num(input.footageMinutes, 0, 6000, 0),
      finishedMinutes: num(input.finishedMinutes, 0.25, 600, 1),
      versions: Math.round(num(input.versions, 1, 200, 1)),
      complexity: COMPLEXITY[input.complexity] ? input.complexity : 'standard',
      rush: !!input.rush,
      deadline: str(input.deadline, 40),
      company: str(input.company, 120),
      specs: {
        resolution: DELIVERY.resolution[input.resolution] ? input.resolution : '1080p',
        fps: DELIVERY.fps.indexOf(String(input.fps)) > -1 ? String(input.fps) : 'source',
        handoff: DELIVERY.handoff[input.handoff] ? input.handoff : 'render',
        captions: !!input.captions,
        notes: str(input.specNotes, 2000)
      }
    };
    var p = {
      id: id('prj'),
      title: title,
      clientEmail: String(actor.email).toLowerCase(),
      clientName: str(input.clientName || actor.name, 120),
      status: 'requested',
      createdAt: iso(now),
      updatedAt: iso(now),
      brief: brief,
      preliminary: estimate(brief),
      estimate: null,
      ledger: [],
      messages: [],
      assets: [],
      versions: [],
      archive: { status: 'none' },
      depletedAt: null,
      purgeAfter: null,
      purgedAt: null,
      work: { state: 'unassigned', task: null, assignee: null, instructions: '', clientWaiting: false, updatedAt: iso(now) },
      // Phase 2 hook: shared Blackmagic Cloud project library. MVP only records interest; nothing connects.
      integrations: { blackmagic: input.blackmagicInterest ? { status: 'interested', library: str(input.blackmagicLibrary, 200), invitedAt: null, connectedAt: null } : null },
      demo: !!input.demo
    };
    db.projects.push(p);
    sys(p, 'Project requested. Preliminary estimate ' + hrs(p.preliminary.low) + ' to ' + hrs(p.preliminary.high) + '. The editor confirms it before anything is charged.', now, 'requested');
    if (brief.description) log(p, actor, brief.description, now, { kind: 'brief' });
    return p;
  }

  function postMessage(db, actor, projectId, body, now) {
    var p = find(db, actor, projectId);
    body = str(body, 8000);
    if (!body) throw EditBoxError(400, 'Write a message first.');
    if (p.work) p.work.clientWaiting = !isStaff(actor);
    return log(p, actor, body, now);
  }

  function sendEstimate(db, actor, projectId, input, now) {
    requireEditor(actor);
    var p = find(db, actor, projectId);
    notPurged(p);
    var low = roundUp(num(input.low, 0.5, 2000, 0), 0.25);
    var high = roundUp(num(input.high, low, 4000, low), 0.25);
    if (!low) throw EditBoxError(400, 'Set the low end of the estimate.');
    var minHours = input.minHours ? num(input.minHours, 1, 4000, PRICING.minStartHours) : minHoursToStart(low);
    var revised = !!p.estimate;
    p.estimate = { low: low, high: high, minHours: minHours, note: str(input.note, 4000), sentAt: iso(now), by: who(actor).by };
    if (p.status === 'requested') p.status = 'estimated';
    sys(p, (revised ? 'Revised estimate: ' : 'Free estimate: ') + hrs(low) + ' to ' + hrs(high) + '. Prepay at least ' + hrs(minHours) + ' to start.', now, 'estimate');
    if (p.estimate.note) log(p, actor, p.estimate.note, now, { kind: 'estimate-note' });
    return p;
  }

  /* System only: called by the Stripe webhook, the mock checkout, or demo mode. Never by a client request directly. */
  function creditHours(db, projectId, input, now) {
    var p = null;
    db.projects.forEach(function (x) { if (x.id === projectId) p = x; });
    if (!p) throw EditBoxError(404, 'Project not found.');
    notPurged(p);
    if (!p.estimate) throw EditBoxError(409, 'Hours can be bought once the estimate is in.');
    if (input.ref && p.ledger.some(function (e) { return e.ref === input.ref; })) return p;
    var pack = packById(input.packId);
    if (!pack) throw EditBoxError(400, 'Unknown hour pack.');
    if (p.status === 'estimated' && pack.hours < p.estimate.minHours) throw EditBoxError(400, 'This job needs at least ' + hrs(p.estimate.minHours) + ' to start.');
    p.ledger.push({
      id: id('led'), type: 'purchase', hours: pack.hours, amountCents: input.amountCents != null ? input.amountCents : pack.priceCents,
      packId: pack.id, source: input.source || 'mock', ref: input.ref || null, note: pack.label + ' pack', at: iso(now)
    });
    var wasDepleted = p.status === 'depleted' || p.status === 'archived';
    if (p.work && p.work.state === 'paused_no_hours') setWork(p, !p.work.assignee ? 'unassigned' : p.work.assignee.kind === 'agent' ? 'queued_for_agent' : 'in_edit', p.work.task, now);
    p.status = 'active';
    p.depletedAt = null;
    p.purgeAfter = null;
    if (p.archive && p.archive.declinedAt) delete p.archive.declinedAt;
    var paidNote = input.source === 'stripe' ? 'Paid via Stripe.' : 'Demo payment, no card was charged.';
    sys(p, (wasDepleted ? 'Topped up ' : 'Prepaid ') + hrs(pack.hours) + ' (' + pack.label + ', ' + money(pack.priceCents) + '). ' + paidNote + ' Balance ' + hrs(balance(p)) + '.', now, 'purchase');
    return p;
  }

  function burnHours(db, actor, projectId, input, now) {
    requireStaff(actor);
    var p = find(db, actor, projectId);
    if (p.status !== 'active') throw EditBoxError(409, 'Hours can only be logged while the job has prepaid hours.');
    var h = roundUp(num(input.hours, 0, 1000, 0), PRICING.burnIncrement);
    if (!h) throw EditBoxError(400, 'Log at least ' + hrs(PRICING.burnIncrement) + '.');
    var bal = balance(p);
    if (h > bal + 1e-9) throw EditBoxError(409, 'Only ' + hrs(bal) + ' left. Ask the client to top up first.');
    var note = str(input.note, 500) || 'Editing';
    p.ledger.push({ id: id('led'), type: 'burn', hours: -h, amountCents: 0, note: note, by: who(actor).by, at: iso(now) });
    // Logged work counts as using the source footage.
    p.assets.forEach(function (a) { if (a.kind === 'source' && !a.purgedAt) { a.lastUsedAt = iso(now); a.warnedAt = null; } });
    var left = balance(p);
    sys(p, 'Logged ' + hrs(h) + ': ' + note + '. ' + hrs(left) + ' left.', now, 'burn');
    if (left <= 0) {
      p.status = 'depleted';
      p.depletedAt = iso(now);
      if (p.work && p.work.state !== 'unassigned') setWork(p, 'paused_no_hours', null, now);
      if (archiveActive(p)) {
        p.status = 'archived';
        sys(p, 'Prepaid hours are used up. Your archive subscription keeps the project, renders and finals stored.', now, 'depleted');
      } else {
        p.purgeAfter = iso(now + RETENTION.depletedGraceDays * DAY);
        sys(p, 'Prepaid hours are used up. To keep the project available, start an archive subscription (' + money(PRICING.archive.priceCents) + ' a ' + PRICING.archive.interval + '), or top up hours to keep working. Without either, project files are removed on ' + new Date(p.purgeAfter).toDateString() + '.', now, 'depleted');
      }
    }
    return p;
  }

  var CLIENT_KINDS = { source: 1 };
  var ASSET_KINDS = { source: 1, project: 1, render: 1, deliverable: 1 };

  function addAsset(db, actor, projectId, input, now) {
    var p = find(db, actor, projectId);
    notPurged(p);
    var kind = ASSET_KINDS[input.kind] ? input.kind : 'source';
    if (!isStaff(actor) && !CLIENT_KINDS[kind]) throw EditBoxError(403, 'Clients can add source footage and transfer links.');
    var url = str(input.url, 2000);
    if (url && !/^https?:\/\//i.test(url)) throw EditBoxError(400, 'Transfer links must start with http:// or https://');
    var name = str(input.name, 240) || (url ? url.replace(/^https?:\/\//i, '').split('/')[0] + ' transfer' : '');
    if (!name) throw EditBoxError(400, 'File name is missing.');
    var a = {
      id: input.id || id('ast'), kind: kind, name: name, size: Math.max(0, Number(input.size) || 0), type: str(input.type, 120),
      key: input.key || null, url: url || null, uploadedBy: who(actor).by, uploaderRole: actor.role, createdAt: iso(now), lastUsedAt: iso(now),
      ready: input.ready !== false, purgedAt: null
    };
    p.assets.push(a);
    var what = a.url ? 'transfer link' : ({ source: 'source footage', project: 'project file', render: 'render', deliverable: 'final deliverable' })[kind];
    if (a.ready) sys(p, who(actor).by + ' added ' + what + ': ' + a.name + '.', now, 'asset');
    return a;
  }

  function markAssetReady(db, actor, projectId, assetId, now) {
    var p = find(db, actor, projectId);
    var a = p.assets.filter(function (x) { return x.id === assetId; })[0];
    if (!a) throw EditBoxError(404, 'File not found.');
    if (!a.ready) {
      a.ready = true;
      sys(p, who(actor).by + ' uploaded ' + a.name + '.', now, 'asset');
    }
    return a;
  }

  /* An editor opening or downloading source footage counts as usage and resets the 30-day clock. */
  function touchAsset(db, actor, projectId, assetId, now) {
    var p = find(db, actor, projectId);
    var a = p.assets.filter(function (x) { return x.id === assetId; })[0];
    if (!a || a.purgedAt) throw EditBoxError(404, 'File not found or already removed.');
    if (isStaff(actor) && a.kind === 'source') { a.lastUsedAt = iso(now); a.warnedAt = null; }
    return a;
  }

  function postVersion(db, actor, projectId, input, now) {
    requireStaff(actor);
    var p = find(db, actor, projectId);
    notPurged(p);
    if (!p.estimate) throw EditBoxError(409, 'Send the estimate first.');
    var asset = null;
    if (input.assetId) {
      asset = p.assets.filter(function (a) { return a.id === input.assetId; })[0];
      if (!asset) throw EditBoxError(400, 'Render file not found.');
    }
    var n = p.versions.length + 1;
    var v = {
      id: id('ver'), n: n, label: str(input.label, 120) || 'Version ' + n, note: str(input.note, 4000),
      assetId: asset ? asset.id : null, synthetic: !asset, durationSec: num(input.durationSec, 1, 36000, 60),
      status: 'in_review', createdAt: iso(now), by: who(actor).by, comments: [],
      // Phase 2: Blackmagic Cloud presentation link or Resolve timeline reference for deeper review.
      external: input.externalUrl ? { provider: 'blackmagic_cloud', url: str(input.externalUrl, 2000) } : null
    };
    if (input.timelineAssetId) v.timelineAssetId = str(input.timelineAssetId, 60);
    p.versions.push(v);
    setWork(p, 'awaiting_client', null, now);
    sys(p, 'Version ' + n + ' posted for review: ' + v.label + (isAgent(actor) ? ' (cut by ' + actor.name + ')' : '') + '.', now, 'version');
    if (v.note) log(p, actor, v.note, now, { kind: 'version-note' });
    return v;
  }

  function findVersion(p, versionId) {
    var v = p.versions.filter(function (x) { return x.id === versionId; })[0];
    if (!v) throw EditBoxError(404, 'Version not found.');
    return v;
  }

  function addComment(db, actor, projectId, versionId, input, now) {
    var p = find(db, actor, projectId);
    var v = findVersion(p, versionId);
    var body = str(input.body, 4000);
    if (!body) throw EditBoxError(400, 'Write a note first.');
    var c = { id: id('cmt'), t: input.t == null ? null : r2(num(input.t, 0, v.durationSec, 0)), body: body, by: who(actor).by, role: actor.role, at: iso(now), resolved: false };
    v.comments.push(c);
    v.comments.sort(function (a, b) { return (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t); });
    p.updatedAt = iso(now);
    return c;
  }

  function resolveComment(db, actor, projectId, versionId, commentId, now) {
    var p = find(db, actor, projectId);
    var c = findVersion(p, versionId).comments.filter(function (x) { return x.id === commentId; })[0];
    if (!c) throw EditBoxError(404, 'Note not found.');
    c.resolved = !c.resolved;
    p.updatedAt = iso(now);
    return c;
  }

  function setVersionStatus(db, actor, projectId, versionId, status, now) {
    var p = find(db, actor, projectId);
    requireOwner(actor, p);
    var v = findVersion(p, versionId);
    if (status !== 'approved' && status !== 'changes_requested') throw EditBoxError(400, 'Unknown review status.');
    v.status = status;
    if (p.work && p.work.state !== 'unassigned' && p.status === 'active') {
      var next = status === 'approved' ? 'deliver_finals' : 'revision';
      setWork(p, p.work.assignee ? 'queued_for_agent' : 'needs_editor', next, now);
    }
    var open = v.comments.filter(function (c) { return !c.resolved; }).length;
    sys(p, status === 'approved' ? 'Client approved version ' + v.n + '.' : 'Client requested changes on version ' + v.n + (open ? ' (' + open + ' open note' + (open > 1 ? 's' : '') + ').' : '.'), now, 'review');
    return v;
  }

  /* System only: Stripe checkout.session.completed for the archive price, or demo/mock. */
  function activateArchive(db, projectId, input, now) {
    var p = null;
    db.projects.forEach(function (x) { if (x.id === projectId) p = x; });
    if (!p) throw EditBoxError(404, 'Project not found.');
    notPurged(p);
    if (archiveActive(p)) return p;
    p.archive = {
      status: 'active', since: iso(now), currentPeriodEnd: iso(input.currentPeriodEnd || now + 30 * DAY),
      source: input.source || 'mock', subscriptionId: input.subscriptionId || null, customerId: input.customerId || null
    };
    p.purgeAfter = null;
    if (p.status === 'depleted') p.status = 'archived';
    sys(p, 'Archive subscription started (' + money(PRICING.archive.priceCents) + ' a ' + PRICING.archive.interval + (input.source === 'stripe' ? ', via Stripe' : ', demo, no card charged') + '). Project files, renders and finals stay stored while it is active. Source footage still clears after ' + RETENTION.sourceUnusedDays + ' days unused.', now, 'archive');
    return p;
  }

  function subscribeArchiveAllowed(p) {
    return p.status !== 'purged' && !archiveActive(p) && p.ledger.length > 0;
  }

  /* System only: mirror Stripe subscription status changes. */
  function syncArchive(db, subscriptionId, input, now) {
    var p = db.projects.filter(function (x) { return x.archive && x.archive.subscriptionId === subscriptionId; })[0];
    if (!p) return null;
    if (input.currentPeriodEnd) p.archive.currentPeriodEnd = iso(input.currentPeriodEnd);
    if (input.status === 'canceled' || input.status === 'ended') endArchive(p, now);
    else if (input.cancelAtPeriodEnd) p.archive.status = 'canceling';
    else if (input.status === 'active' || input.status === 'trialing') p.archive.status = 'active';
    else if (input.status === 'past_due' || input.status === 'unpaid') p.archive.status = 'past_due';
    p.updatedAt = iso(now);
    return p;
  }

  function cancelArchive(db, actor, projectId, now) {
    var p = find(db, actor, projectId);
    requireOwner(actor, p);
    if (!archiveActive(p)) throw EditBoxError(409, 'There is no active archive subscription.');
    p.archive.status = 'canceling';
    sys(p, 'Archive subscription set to end on ' + new Date(p.archive.currentPeriodEnd).toDateString() + '. Files stay until then, plus a ' + RETENTION.lapsedArchiveGraceDays + '-day download window.', now, 'archive');
    return p;
  }

  function endArchive(p, now) {
    if (p.archive.status === 'ended') return;
    p.archive.status = 'ended';
    p.archive.endedAt = iso(now);
    if (p.status === 'archived') {
      p.status = 'depleted';
      p.purgeAfter = iso(now + RETENTION.lapsedArchiveGraceDays * DAY);
      sys(p, 'Archive subscription ended. Project files are removed on ' + new Date(p.purgeAfter).toDateString() + ' unless you subscribe again or top up hours.', now, 'archive');
    }
  }

  function declineArchive(db, actor, projectId, now) {
    var p = find(db, actor, projectId);
    requireOwner(actor, p);
    if (p.status !== 'depleted') throw EditBoxError(409, 'You can only decline the archive once the hours are used up.');
    p.archive.declinedAt = iso(now);
    var when = now + RETENTION.declinedDownloadDays * DAY;
    p.purgeAfter = iso(Math.min(ms(p.purgeAfter) || when, when));
    sys(p, 'Client declined the archive subscription. Project files are removed on ' + new Date(p.purgeAfter).toDateString() + '. Download anything you need before then. You can start a new project any time.', now, 'archive');
    return p;
  }

  /* ---------- work queue (editor + agent) ---------- */

  function setWork(p, state, task, now) {
    p.work = p.work || {};
    p.work.state = state;
    if (task !== undefined) p.work.task = task;
    p.work.updatedAt = iso(now);
  }

  function taskFor(p) {
    if (!p.versions.length) return 'first_cut';
    var v = p.versions[p.versions.length - 1];
    if (v.status === 'approved') return 'deliver_finals';
    if (v.status === 'changes_requested') return 'revision';
    return 'reply';
  }

  /* Editor hands a job to a named agent (or takes it back with agent: null). */
  function assignWork(db, actor, projectId, input, now) {
    requireEditor(actor);
    var p = find(db, actor, projectId);
    notPurged(p);
    var agent = str(input.agent, 60);
    if (!agent) {
      p.work.assignee = { kind: 'human', name: who(actor).by };
      setWork(p, 'in_edit', p.work.task || taskFor(p), now);
      sys(p, who(actor).by + ' took the edit back in house.', now, 'work');
      return p;
    }
    p.work.assignee = { kind: 'agent', name: agent };
    p.work.instructions = str(input.instructions, 6000);
    var waiting = p.status === 'active' ? 'queued_for_agent' : 'paused_no_hours';
    if (p.status === 'requested' || p.status === 'estimated') waiting = 'paused_no_hours';
    setWork(p, waiting, input.task && WORK_TASKS[input.task] ? input.task : taskFor(p), now);
    sys(p, 'Handed to the editing agent ' + agent + (waiting === 'paused_no_hours' ? '. It starts once prepaid hours are in.' : '.') + ' DWIM Logic supervises the edit.', now, 'work');
    return p;
  }

  var AGENT_STATES = { in_edit: 1, awaiting_client: 1, needs_editor: 1 };

  /* Agent or editor moves the job along. Agents can claim, report progress, or escalate to the editor. */
  function updateWork(db, actor, projectId, input, now) {
    requireStaff(actor);
    var p = find(db, actor, projectId);
    notPurged(p);
    var state = input.state;
    if (!WORK_STATES[state]) throw EditBoxError(400, 'Unknown work state.');
    if (isAgent(actor) && !AGENT_STATES[state]) throw EditBoxError(403, 'Agents can set in_edit, awaiting_client or needs_editor.');
    if (state === 'in_edit' && p.status !== 'active') throw EditBoxError(409, 'No prepaid hours on this job yet.');
    setWork(p, state, input.task && WORK_TASKS[input.task] ? input.task : undefined, now);
    var note = str(input.note, 2000);
    if (state === 'needs_editor') sys(p, (isAgent(actor) ? actor.name : who(actor).by) + ' flagged this for the editor' + (note ? ': ' + note : '.'), now, 'work');
    else if (state === 'in_edit' && isAgent(actor)) sys(p, actor.name + ' picked up the job: ' + (WORK_TASKS[p.work.task] || 'editing') + '.', now, 'work');
    else p.updatedAt = iso(now);
    return p;
  }

  function claimWork(db, actor, projectId, now) {
    return updateWork(db, actor, projectId, { state: 'in_edit' }, now);
  }

  function agentInbox(db, actor) {
    return listProjects(db, actor).filter(function (p) {
      return p.status === 'active' && (p.work.state === 'queued_for_agent' || p.work.state === 'in_edit' || p.work.clientWaiting);
    });
  }

  /* Everything an editing agent needs to do the job, in one document.
   * fileUrl(asset) returns a fetchable URL (signed, or the API file route that accepts the agent's bearer token). */
  function jobPacket(p, fileUrl) {
    var specs = p.brief.specs || {};
    var latest = p.versions[p.versions.length - 1] || null;
    return {
      schema: 'editbox.job/1',
      project: { id: p.id, title: p.title, status: p.status, client: p.clientName || p.clientEmail, createdAt: p.createdAt, demo: !!p.demo },
      work: { state: p.work.state, task: p.work.task, taskLabel: WORK_TASKS[p.work.task] || null, instructions: p.work.instructions || '', clientWaiting: !!p.work.clientWaiting, assignee: p.work.assignee },
      brief: {
        need: (DELIVERABLES[p.brief.deliverable] || {}).label, description: p.brief.description, company: p.brief.company,
        footageMinutes: p.brief.footageMinutes, finishedMinutes: p.brief.finishedMinutes, versions: p.brief.versions,
        complexity: p.brief.complexity, rush: p.brief.rush, deadline: p.brief.deadline
      },
      delivery: {
        resolution: DELIVERY.resolution[specs.resolution] || specs.resolution, fps: specs.fps, captions: !!specs.captions,
        handoff: specs.handoff, handoffLabel: DELIVERY.handoff[specs.handoff], notes: specs.notes || '',
        nle: 'DaVinci Resolve'
      },
      hours: { balance: balance(p), bought: totals(p).bought, used: totals(p).used, increment: PRICING.burnIncrement, estimate: p.estimate },
      media: p.assets.filter(function (a) { return !a.purgedAt && a.ready !== false; }).map(function (a) {
        return { id: a.id, kind: a.kind, name: a.name, size: a.size, type: a.type, transferLink: a.url || null, url: a.url ? null : (fileUrl ? fileUrl(a) : null), addedBy: a.uploadedBy, createdAt: a.createdAt };
      }),
      messages: p.messages.map(function (m) { return { at: m.at, from: m.system ? 'system' : m.role, by: m.by, kind: m.kind || null, body: m.body }; }),
      versions: p.versions.map(function (v) {
        return { id: v.id, n: v.n, label: v.label, status: v.status, durationSec: v.durationSec, createdAt: v.createdAt, note: v.note,
          notes: v.comments.map(function (c) { return { t: c.t, by: c.by, role: c.role, body: c.body, resolved: c.resolved }; }) };
      }),
      openNotes: latest ? latest.comments.filter(function (c) { return !c.resolved; }).map(function (c) { return { version: latest.n, t: c.t, body: c.body }; }) : [],
      blackmagic: p.integrations && p.integrations.blackmagic
    };
  }

  /* The same packet as Markdown, for language-model agents that read prose better than JSON. */
  function jobPacketMarkdown(k) {
    var L = [];
    var tc = function (t) { if (t == null) return 'general'; var s = Math.floor(t); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
    L.push('# Edit Box job: ' + k.project.title, '', 'Project `' + k.project.id + '` · status ' + k.project.status + ' · work ' + k.work.state + (k.work.taskLabel ? ' · task: **' + k.work.taskLabel + '**' : ''));
    if (k.work.instructions) L.push('', '## Instructions from the editor', k.work.instructions);
    L.push('', '## Brief', '- Need: ' + k.brief.need, '- Finished length: ' + k.brief.finishedMinutes + ' min, ' + k.brief.versions + ' version(s), ' + k.brief.complexity + (k.brief.rush ? ', rush' : ''), '- Raw footage: ' + k.brief.footageMinutes + ' min' + (k.brief.deadline ? '\n- Deadline: ' + k.brief.deadline : ''), '', k.brief.description || '(no description)');
    L.push('', '## Delivery', '- NLE: ' + k.delivery.nle, '- Resolution: ' + k.delivery.resolution + ' · fps ' + k.delivery.fps + (k.delivery.captions ? ' · captions' : ''), '- Handoff: ' + k.delivery.handoffLabel + (k.delivery.notes ? '\n- Notes: ' + k.delivery.notes : ''));
    L.push('', '## Hours', '- Balance: ' + k.hours.balance + ' of ' + k.hours.bought + ' prepaid. Log in ' + k.hours.increment + ' hr steps. Stop and flag the editor before the balance runs out.');
    L.push('', '## Media');
    k.media.forEach(function (m) { L.push('- [' + m.kind + '] ' + m.name + (m.transferLink ? ' (transfer link: ' + m.transferLink + ')' : m.url ? ' <' + m.url + '>' : '')); });
    if (k.openNotes.length) { L.push('', '## Open review notes (latest version)'); k.openNotes.forEach(function (n) { L.push('- V' + n.version + ' @ ' + tc(n.t) + ': ' + n.body); }); }
    L.push('', '## Versions');
    k.versions.forEach(function (v) { L.push('- V' + v.n + ' ' + v.label + ' (' + v.status + ', ' + v.notes.length + ' notes)'); });
    L.push('', '## Message log');
    k.messages.forEach(function (m) { L.push('- ' + m.at.slice(0, 16).replace('T', ' ') + ' **' + (m.from === 'system' ? 'system' : m.by + ' (' + m.from + ')') + '**: ' + m.body.replace(/\n+/g, ' ')); });
    return L.join('\n') + '\n';
  }

  /* Retention job. Pure: mutates db and returns what storage must delete. Run it on a schedule (see server/retention.js).
   * Rules:
   *  1. Source footage is removed after RETENTION.sourceUnusedDays without use, whatever the project state.
   *  2. With an active archive subscription, everything else stays.
   *  3. Hours used up and no subscription: files are removed after the grace period (shorter if the client declines).
   *  4. A canceled subscription runs to the end of its paid period, then a short grace period, then rule 3.
   *  The message log and hour ledger are kept as the project record; only files are removed. */
  function runRetention(db, now, opts) {
    opts = opts || {};
    var report = { at: iso(now), dryRun: !!opts.dryRun, sourcePurged: [], projectsPurged: [], warnings: [], archivesEnded: [], deleteKeys: [] };
    var work = opts.dryRun ? JSON.parse(JSON.stringify(db)) : db;
    work.projects.forEach(function (p) {
      if (p.status === 'purged') return;

      if (p.archive && p.archive.status === 'canceling' && ms(p.archive.currentPeriodEnd) <= now) {
        endArchive(p, now);
        report.archivesEnded.push(p.id);
      }
      if (p.archive && p.archive.status === 'active' && p.archive.source !== 'stripe' && ms(p.archive.currentPeriodEnd) <= now) {
        // Demo and mock subscriptions renew themselves; Stripe ones are updated by webhooks.
        while (ms(p.archive.currentPeriodEnd) <= now) p.archive.currentPeriodEnd = iso(ms(p.archive.currentPeriodEnd) + 30 * DAY);
      }

      p.assets.forEach(function (a) {
        var exp = sourceExpiry(a);
        if (exp == null) return;
        if (exp <= now) {
          purgeAsset(a, now, report);
          report.sourcePurged.push({ projectId: p.id, assetId: a.id, name: a.name });
          sys(p, 'Source footage removed after ' + RETENTION.sourceUnusedDays + ' days unused: ' + a.name + '. Projects, renders and finals are not affected.', now, 'retention');
        } else if (exp - now <= RETENTION.sourceWarnDays * DAY && !a.warnedAt) {
          a.warnedAt = iso(now);
          report.warnings.push({ projectId: p.id, assetId: a.id, kind: 'source' });
          sys(p, 'Heads up: source footage ' + a.name + ' is removed on ' + new Date(exp).toDateString() + ' unless it is used again.', now, 'retention-warning');
        }
      });

      if (p.status === 'depleted' && p.purgeAfter && !archiveActive(p)) {
        var at = ms(p.purgeAfter);
        if (at <= now) {
          p.assets.forEach(function (a) { if (!a.purgedAt) purgeAsset(a, now, report); });
          p.status = 'purged';
          p.purgedAt = iso(now);
          report.projectsPurged.push(p.id);
          sys(p, 'Hours used up with no archive subscription, so project files were removed. The message log and hour ledger stay here. Start a new project whenever you are ready.', now, 'retention');
        } else if (at - now <= RETENTION.purgeWarnDays * DAY && !p.purgeWarnedAt) {
          p.purgeWarnedAt = iso(now);
          report.warnings.push({ projectId: p.id, kind: 'project' });
          sys(p, 'Reminder: project files are removed on ' + new Date(at).toDateString() + '. Start an archive subscription or top up to keep them.', now, 'retention-warning');
        }
      }
    });
    return report;
  }

  function purgeAsset(a, now, report) {
    if (a.key) report.deleteKeys.push(a.key);
    a.purgedAt = iso(now);
    a.key = null;
  }

  /* Client-safe view of a project (strips storage keys). */
  function publicProject(p) {
    var c = JSON.parse(JSON.stringify(p));
    c.assets.forEach(function (a) { a.hasFile = !!a.key; delete a.key; });
    c.balance = balance(p);
    c.totals = totals(p);
    return c;
  }

  return {
    PRICING: PRICING, RETENTION: RETENTION, DELIVERABLES: DELIVERABLES, COMPLEXITY: COMPLEXITY, STAGES: STAGES, DAY: DAY,
    EditBoxError: EditBoxError, id: id, money: money, hrs: hrs, packById: packById, packsFor: packsFor,
    estimate: estimate, minHoursToStart: minHoursToStart, balance: balance, totals: totals, archiveActive: archiveActive,
    liveAssets: liveAssets, sourceExpiry: sourceExpiry, stageIndex: stageIndex, nextStep: nextStep,
    canSee: canSee, isEditor: isEditor, subscribeArchiveAllowed: subscribeArchiveAllowed, publicProject: publicProject,
    emptyDb: emptyDb, listProjects: listProjects, createProject: createProject, postMessage: postMessage, sendEstimate: sendEstimate,
    creditHours: creditHours, burnHours: burnHours, addAsset: addAsset, markAssetReady: markAssetReady, touchAsset: touchAsset,
    postVersion: postVersion, addComment: addComment, resolveComment: resolveComment, setVersionStatus: setVersionStatus,
    activateArchive: activateArchive, syncArchive: syncArchive, cancelArchive: cancelArchive, declineArchive: declineArchive,
    runRetention: runRetention, find: find,
    WORK_STATES: WORK_STATES, WORK_TASKS: WORK_TASKS, DELIVERY: DELIVERY, isAgent: isAgent, isStaff: isStaff,
    assignWork: assignWork, updateWork: updateWork, claimWork: claimWork, agentInbox: agentInbox, taskFor: taskFor,
    jobPacket: jobPacket, jobPacketMarkdown: jobPacketMarkdown
  };
});
