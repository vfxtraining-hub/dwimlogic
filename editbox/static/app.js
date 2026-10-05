/* The Edit Box portal (client) and studio (editor). One app, role from <body data-role>. */
(function () {
  'use strict';
  var C = window.EditBoxCore, PL = window.EditBoxPlayer, CFG = window.EDITBOX_CONFIG || { mode: 'demo' };
  var ROLE = document.body.getAttribute('data-role') === 'editor' ? 'editor' : 'client';
  var EDITOR = ROLE === 'editor';
  var DEMO = CFG.mode !== 'live';
  var S = window.EditBoxStore(ROLE);
  var app = document.getElementById('app');
  var bar = document.getElementById('demo');
  var whoEl = document.getElementById('who');
  var agents = [];
  var me = null, project = null, route = {}, player = null, playerKey = '', playerHost = null, playTime = 0, busy = false;

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(v, withTime) {
    if (!v) return '';
    var d = new Date(v);
    var s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return withTime ? s + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : s;
  }
  function bytes(n) {
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  function daysLeft(t) { return Math.ceil((t - S.now()) / C.DAY); }
  var toastT = 0;
  function toast(msg, err) {
    var t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, err ? 6000 : 3800);
  }
  function fail(e) { toast((e && e.message) || 'Something went wrong.', true); if (e && e.status === 401) go('#/login'); }
  function modal(html, bind) {
    var m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<div class="box" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(m);
    function close() { m.remove(); document.removeEventListener('keydown', key); }
    function key(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', key);
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-close]')) close(); });
    var f = m.querySelector('button:not([data-close]),input');
    if (f) f.focus();
    if (bind) bind(m, close);
    return close;
  }
  function go(h) { if (location.hash === h) onRoute(); else location.hash = h; }
  function val(form, name) { var el = form.elements[name]; return el ? (el.type === 'checkbox' ? el.checked : el.value) : ''; }
  function lock(btn, on) { if (btn) { btn.disabled = on; } busy = on; }
  var otherPage = EDITOR ? '../portal/' : '../studio/';

  /* ---------- chrome ---------- */
  function renderBar() {
    if (!bar) return;
    if (!DEMO) {
      bar.hidden = CFG.payments !== 'mock';
      if (!bar.hidden) bar.innerHTML = '<div class="wrap"><b>Test payments</b><span>Stripe is not connected on this server, so checkout is simulated and nothing is charged.</span></div>';
      return;
    }
    var h = location.hash || '#/';
    bar.hidden = false;
    bar.innerHTML = '<div class="wrap"><b>Demo mode</b><span>Nothing is charged and no files leave this browser.</span>' +
      '<span>View as</span><a class="sw' + (EDITOR ? '' : ' on') + '" href="../portal/' + esc(h) + '">Client</a><a class="sw' + (EDITOR ? ' on' : '') + '" href="../studio/' + esc(h) + '">Editor</a>' +
      '<span class="sp">Demo date ' + esc(fmtDate(S.now())) + '</span>' +
      '<button type="button" data-act="clock" data-days="1">+1 day</button><button type="button" data-act="clock" data-days="31">+31 days</button>' +
      '<button type="button" data-act="reset-demo">Reset demo</button></div>';
  }
  function renderWho() {
    if (!whoEl) return;
    if (!me) { whoEl.innerHTML = ''; return; }
    whoEl.innerHTML = '<span class="who">' + esc(EDITOR ? (me.name || me.email) + ' · editor' : me.email) + '</span>' +
      (DEMO && EDITOR ? '' : ' <button class="lnk" type="button" data-act="logout" style="font-size:13px">Sign out</button>');
  }

  /* ---------- routing ---------- */
  function parse() {
    var h = (location.hash || '#/').slice(1), q = '';
    var qi = h.indexOf('?');
    if (qi > -1) { q = h.slice(qi + 1); h = h.slice(0, qi); }
    var parts = h.split('/').filter(Boolean);
    var r = { name: 'list', q: new URLSearchParams(q) };
    if (parts[0] === 'login') r.name = 'login';
    else if (parts[0] === 'new') r.name = 'new';
    else if (parts[0] === 'p' && parts[1]) {
      r.name = 'project'; r.id = parts[1]; r.tab = parts[2] || 'messages';
      if (parts[2] === 'v' && parts[3]) { r.tab = 'versions'; r.vid = parts[3]; }
    }
    return r;
  }

  function onRoute() {
    route = parse();
    renderBar();
    if (route.name !== 'project' || !route.vid) dropPlayer();
    S.me().then(function (j) {
      me = j.me;
      renderWho();
      if (!me) { route.name = 'login'; return loginView(); }
      if (EDITOR && me.role !== 'editor') return notEditor();
      if (route.name === 'login') { go('#/'); return; }
      if (EDITOR && !agents.length && S.agents) S.agents().then(function (a) { agents = a || []; }).catch(function () {});
      if (route.name === 'new') return EDITOR ? go('#/') : newView();
      if (route.name === 'project') return loadProject(true);
      return listView();
    }).catch(fail);
  }

  /* ---------- login ---------- */
  function loginView() {
    var expired = route.q && route.q.get('expired');
    app.innerHTML = '<div class="wrap view"><div class="login">' +
      '<p class="kicker">' + (EDITOR ? 'Studio' : 'The Edit Box') + '</p>' +
      '<h1>' + (EDITOR ? 'Editor <em class="s">sign in.</em>' : 'Your <em class="s">projects.</em>') + '</h1>' +
      '<p class="sub">' + (EDITOR ? 'Editor accounts are the addresses listed in EDITBOX_ADMIN_EMAILS.' : 'Projects are private to your email address. We send a one-time sign-in link, so there is no password to remember.') + '</p>' +
      (expired ? '<p class="note" style="color:var(--warn)">That sign-in link has expired or was already used. Ask for a new one.</p>' : '') +
      '<form class="form card" data-form="login" novalidate>' +
      '<label>Email<input name="email" type="email" autocomplete="email" required></label>' +
      (DEMO ? '<label>Your name (optional)<input name="name" autocomplete="name"></label>' : '') +
      '<div class="row"><button class="btn" type="submit">' + (DEMO ? 'Enter the demo' : 'Email me a sign-in link') + '</button>' +
      (DEMO ? '<button class="lnk" type="button" data-act="sample-client">Use a sample client</button>' : '') + '</div>' +
      (DEMO ? '<p class="note">Demo mode: no email is sent and no password is needed. Each email address only sees its own projects.</p>' : '') +
      '<div id="login-out"></div></form>' +
      '<p class="note" style="margin-top:22px"><a href="../">What is The Edit Box?</a></p></div></div>';
  }
  function notEditor() {
    app.innerHTML = '<div class="wrap view"><div class="login"><h1>Not an <em class="s">editor.</em></h1><p class="sub">' + esc(me.email) + ' is a client account. Open your projects in the portal instead.</p><a class="btn" href="../portal/">Go to the portal</a></div></div>';
  }

  /* ---------- list ---------- */
  function listView() {
    S.listProjects().then(function (list) {
      if (EDITOR) return studioHome(list);
      var rows = list.map(function (p) {
        var attn = p.status === 'estimated' || p.status === 'depleted' || p.versions.some(function (v) { return v.status === 'in_review'; });
        return '<a class="prow' + (attn ? ' attn' : '') + '" href="#/p/' + esc(p.id) + '"><div><div class="t">' + esc(p.title) + '</div><div class="m">' + esc(C.nextStep(p, 'client')) + '</div></div>' +
          '<span class="pill ' + esc(p.status) + '">' + esc(statusLabel(p)) + '</span><div class="b">' + esc(C.hrs(p.balance)) + '<small>prepaid left</small></div></a>';
      }).join('');
      app.innerHTML = '<div class="wrap view"><p class="kicker">The Edit Box · DWIM Logic</p><div class="row" style="justify-content:space-between"><h1>Your <em class="s">projects.</em></h1><a class="btn" href="#/new">Start a project</a></div>' +
        (list.length ? '<div class="plist">' + rows + '</div>' :
          '<div class="empty" style="margin-top:22px"><h3>No projects yet.</h3><p>Describe the job and add your footage or a transfer link. The estimate is free.</p><a class="btn" href="#/new">Start a project</a></div>') + '</div>';
    }).catch(fail);
  }

  function workPill(p) {
    if (!p.work || p.status === 'purged') return '';
    var a = p.work.assignee;
    return '<span class="pill work w-' + esc(p.work.state) + '">' + esc(C.WORK_STATES[p.work.state] + (a && a.kind === 'agent' ? ' · ' + a.name : '')) + '</span>';
  }

  function statusLabel(p) {
    return { requested: 'Awaiting estimate', estimated: 'Estimate sent', active: 'In progress', depleted: p.archive && p.archive.declinedAt ? 'Closing' : 'Hours used', archived: 'Archived', purged: 'Files removed' }[p.status] || p.status;
  }

  function studioHome(list) {
    var count = function (s) { return list.filter(function (p) { return p.status === s; }).length; };
    var rows = list.map(function (p) {
      var attn = p.status === 'requested' || (p.work && p.work.state === 'needs_editor') || p.versions.some(function (v) { return v.status === 'changes_requested'; }) || (p.messages.length && p.messages[p.messages.length - 1].role === 'client');
      return '<a class="prow' + (attn ? ' attn' : '') + '" href="#/p/' + esc(p.id) + '"><div><div class="t">' + esc(p.title) + '</div><div class="m">' + esc(p.clientName || p.clientEmail) + ' · ' + esc(p.clientEmail) + ' · ' + esc(C.nextStep(p, 'editor')) + '</div></div>' +
        '<div style="display:grid;gap:6px;justify-items:end"><span class="pill ' + esc(p.status) + '">' + esc(statusLabel(p)) + '</span>' + workPill(p) + '</div><div class="b">' + esc(C.hrs(p.balance)) + '<small>of ' + esc(C.hrs(p.totals.bought)) + ' prepaid</small></div></a>';
    }).join('');
    app.innerHTML = '<div class="wrap view"><p class="kicker">Studio · DWIM Logic</p><h1>All <em class="s">projects.</em></h1>' +
      '<p class="sub" style="margin-bottom:10px">' + list.filter(function (p) { return p.work && (p.work.state === 'queued_for_agent' || p.work.state === 'in_edit') && p.work.assignee && p.work.assignee.kind === 'agent'; }).length + ' with the agent · ' + list.filter(function (p) { return p.work && p.work.state === 'needs_editor'; }).length + ' need you · ' + count('requested') + ' awaiting estimate · ' + count('estimated') + ' awaiting payment · ' + count('active') + ' in progress · ' + count('depleted') + ' hours used · ' + count('archived') + ' archived</p>' +
      '<div class="pgrid"><div>' + (list.length ? '<div class="plist" style="margin-top:0">' + rows + '</div>' :
        '<div class="empty"><h3>No requests yet.</h3><p>' + (DEMO ? 'Switch to the Client view in the demo bar and start a project, then come back here.' : 'Share dwimlogic.com/editbox and requests land here.') + '</p>' + (DEMO ? '<a class="btn" href="../portal/#/new">Start one as a client</a>' : '') + '</div>') + '</div>' +
      '<aside class="stack"><div class="card"><h4>Retention job</h4><p>Source footage clears after ' + C.RETENTION.sourceUnusedDays + ' days unused. Projects with hours used and no archive subscription clear after their grace period. ' + (DEMO ? 'In the demo it runs whenever you move the demo date forward.' : 'The server runs it every few hours.') + '</p>' +
      '<div class="row"><button class="btn sm ghost" type="button" data-act="retention" data-dry="1">Preview</button><button class="btn sm" type="button" data-act="retention">Run now</button></div><div id="ret-out" class="note"></div></div>' +
      '<div class="card"><h4>Rate placeholders</h4>' + C.PRICING.packs.map(function (k) { return '<p>' + k.hours + ' hrs · ' + k.label + ' · ' + C.money(k.priceCents) + '</p>'; }).join('') + '<p>Archive ' + C.money(C.PRICING.archive.priceCents) + ' a ' + C.PRICING.archive.interval + '</p><p class="note">Edit in editbox/static/core.js (PRICING).</p></div></aside></div></div>';
  }

  /* ---------- new project ---------- */
  function newView() {
    var opts = Object.keys(C.DELIVERABLES).map(function (k) { return '<option value="' + k + '">' + esc(C.DELIVERABLES[k].label) + '</option>'; }).join('');
    app.innerHTML = '<div class="wrap view"><p class="crumbs"><a href="#/">Projects</a> / New</p><h1>Start a <em class="s">project.</em></h1>' +
      '<p class="sub">Tell us what you need and send the footage. You get a free estimate before anything is charged.</p>' +
      '<div class="pgrid"><form class="form card" data-form="new" novalidate>' +
      '<div class="g2"><label>Project name<input name="title" required maxlength="120" placeholder="Spring launch recap"></label><label>Company (optional)<input name="company" autocomplete="organization"></label></div>' +
      '<label>What you need<select name="deliverable">' + opts + '</select></label>' +
      '<label>Describe the job<textarea name="description" rows="5" placeholder="Audience, length, tone, references, music, captions, delivery formats, who approves."></textarea></label>' +
      '<div class="g3"><label>Raw footage (minutes)<input name="footageMinutes" type="number" min="0" step="1" value="60" inputmode="numeric"></label><label>Finished length (minutes)<input name="finishedMinutes" type="number" min="0.25" step="0.25" value="2"></label><label>Number of versions<input name="versions" type="number" min="1" step="1" value="1" inputmode="numeric"></label></div>' +
      '<div class="g2"><label>Complexity<select name="complexity"><option value="simple">Simple: clean footage, straight cut</option><option value="standard" selected>Standard: some graphics and sound work</option><option value="complex">Complex: heavy graphics, grade, multicam</option></select></label><label>Deadline (optional)<input name="deadline" type="date"></label></div>' +
      '<label class="chk"><input name="rush" type="checkbox"> Rush job</label>' +
      '<fieldset class="fs"><legend>Delivery</legend><div class="g3"><label>Resolution<select name="resolution">' + Object.keys(C.DELIVERY.resolution).map(function (k) { return '<option value="' + k + '">' + esc(C.DELIVERY.resolution[k]) + '</option>'; }).join('') + '</select></label>' +
      '<label>Frame rate<select name="fps">' + C.DELIVERY.fps.map(function (k) { return '<option value="' + k + '"' + (k === 'source' ? ' selected' : '') + '>' + (k === 'source' ? 'Match source' : k + ' fps') + '</option>'; }).join('') + '</select></label>' +
      '<label>Handoff<select name="handoff">' + Object.keys(C.DELIVERY.handoff).map(function (k) { return '<option value="' + k + '">' + esc(C.DELIVERY.handoff[k]) + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="chk"><input name="captions" type="checkbox"> Captions (SRT and burned in)</label><label>Other specs (optional)<input name="specNotes" placeholder="Loudness target, codec, slate, safe areas"></label></fieldset>' +
      '<label class="chk"><input name="blackmagicInterest" type="checkbox"> We work in DaVinci Resolve on Blackmagic Cloud and could invite DWIM Logic into a shared project library later</label>' +
      '<div><label style="margin-bottom:6px">Footage</label><label class="drop" id="drop"><input type="file" name="files" multiple>Drop files here or click to choose. ' + (DEMO ? '(Demo: only file names are recorded.)' : 'Large files upload directly to storage.') + '</label><div class="queue" id="queue"></div></div>' +
      '<label>Or a transfer link (WeTransfer, Frame.io, Dropbox, Google Drive)<input name="link" type="url" placeholder="https://"></label>' +
      '<div class="row"><button class="btn" type="submit">Request my free estimate</button><span class="note" style="margin:0">No payment yet.</span></div></form>' +
      '<aside class="stack"><div class="card hot"><h4>Preliminary estimate</h4><div class="est-live"><strong id="est-n">0</strong><span id="est-t"></span></div><p id="est-m" style="margin-top:12px"></p><p class="note">A rough guide from your answers. The editor confirms it, usually within a working day.</p></div>' +
      '<div class="card"><h4>How it works</h4><p>1. Free estimate. 2. Prepay a pack of hours to start. 3. Talk in the project and review every version in the browser. 4. When hours run out, top up or keep everything with an archive subscription.</p></div></aside></div></div>';
    var f = app.querySelector('[data-form=new]');
    function upd() {
      var e = C.estimate(formInput(f));
      var pack = C.PRICING.packs.filter(function (p) { return p.hours === e.minHours; })[0];
      app.querySelector('#est-n').textContent = e.low + '–' + e.high;
      app.querySelector('#est-t').textContent = 'editing hours';
      app.querySelector('#est-m').textContent = 'Minimum to start: ' + C.hrs(e.minHours) + (pack ? ' (' + pack.label + ' pack, ' + C.money(pack.priceCents) + ')' : '') + '.';
    }
    f.addEventListener('input', upd);
    upd();
    var drop = app.querySelector('#drop'), input = f.elements.files;
    function showQueue() {
      app.querySelector('#queue').innerHTML = [].slice.call(input.files).map(function (fl, i) { return '<div><span>' + esc(fl.name) + '</span><span>' + bytes(fl.size) + '</span></div><div class="prog"><i id="pq' + i + '"></i></div>'; }).join('');
    }
    input.addEventListener('change', showQueue);
    ['dragover', 'dragenter'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; showQueue(); } });
  }
  function formInput(f) {
    return {
      title: val(f, 'title'), company: val(f, 'company'), deliverable: val(f, 'deliverable'), description: val(f, 'description'),
      footageMinutes: val(f, 'footageMinutes'), finishedMinutes: val(f, 'finishedMinutes'), versions: val(f, 'versions'),
      complexity: val(f, 'complexity'), deadline: val(f, 'deadline'), rush: val(f, 'rush'), clientName: me && me.name,
      resolution: val(f, 'resolution'), fps: val(f, 'fps'), handoff: val(f, 'handoff'), captions: val(f, 'captions'), specNotes: val(f, 'specNotes'),
      blackmagicInterest: val(f, 'blackmagicInterest')
    };
  }
  function submitNew(f, btn) {
    var input = formInput(f), files = [].slice.call(f.elements.files.files), link = val(f, 'link').trim();
    if (!input.title.trim()) { toast('Give the project a name.', true); f.elements.title.focus(); return; }
    lock(btn, true);
    S.createProject(input).then(function (p) {
      var chain = Promise.resolve();
      files.forEach(function (fl, i) {
        chain = chain.then(function () {
          return S.upload(p.id, fl, 'source', function (x) { var el = document.getElementById('pq' + i); if (el) el.style.width = Math.round(x * 100) + '%'; });
        });
      });
      if (link) chain = chain.then(function () { return S.addLink(p.id, link); });
      return chain.then(function () { toast('Request sent. Your free estimate is on its way.'); go('#/p/' + p.id); }, function (e) { fail(e); go('#/p/' + p.id + '/files'); });
    }).catch(fail).then(function () { lock(btn, false); });
  }

  /* ---------- project ---------- */
  function loadProject(scroll) {
    return S.getProject(route.id).then(function (p) {
      project = p;
      renderProject();
      if (scroll) window.scrollTo(0, 0);
      var paid = route.q.get('paid') || route.q.get('archived');
      if (paid && !DEMO && CFG.payments === 'stripe') { toast('Payment received. Your balance updates as soon as Stripe confirms.'); pollFor(6); }
    }).catch(function (e) {
      if (e.status === 404) { app.innerHTML = '<div class="wrap view"><h1>Project not <em class="s">found.</em></h1><p class="sub">It may belong to another account.</p><a class="btn" href="#/">Your projects</a></div>'; return; }
      fail(e);
    });
  }
  function pollFor(n) { if (n <= 0) return; setTimeout(function () { refresh().then(function () { pollFor(n - 1); }); }, 2500); }
  function refresh() {
    if (route.name !== 'project') { onRoute(); return Promise.resolve(); }
    return S.getProject(route.id).then(function (p) { project = p; renderProject(); }).catch(fail);
  }
  function apply(promise, okMsg) {
    return promise.then(function (j) {
      if (j && j.project) { project = j.project; renderProject(); } else return refresh();
      if (okMsg) toast(okMsg);
      return j;
    }).catch(function (e) { fail(e); throw e; });
  }

  function keepInputs() {
    var kept = {};
    [].slice.call(app.querySelectorAll('[data-keep]')).forEach(function (el) { kept[el.id] = el.value; });
    var focus = document.activeElement && document.activeElement.id;
    return function () {
      Object.keys(kept).forEach(function (id) { var el = document.getElementById(id); if (el && kept[id]) el.value = kept[id]; });
      if (focus) { var el = document.getElementById(focus); if (el && el.focus) el.focus(); }
    };
  }

  function renderProject() {
    var p = project, restore = keepInputs();
    var msgsEl = app.querySelector('.msgs'), stick = !msgsEl || msgsEl.scrollTop + msgsEl.clientHeight >= msgsEl.scrollHeight - 30;
    var idx = C.stageIndex(p), tab = route.tab;
    var steps = C.STAGES.map(function (s, i) {
      var label = s.id === 'archived' && p.status === 'purged' ? 'Files removed' : s.label;
      var cls = p.status === 'purged' ? (i < C.STAGES.length - 1 ? 'done' : 'now') : i < idx ? 'done' : i === idx ? 'now' : '';
      return '<div class="' + cls + '">' + esc(label) + '</div>';
    }).join('');
    var openNotes = p.versions.reduce(function (n, v) { return n + v.comments.filter(function (c) { return !c.resolved; }).length; }, 0);
    var tabs = [['messages', 'Messages', p.messages.length], ['versions', 'Versions', p.versions.length], ['files', 'Files', C.liveAssets(p).length], ['hours', 'Hours', p.ledger.length], ['brief', 'Brief', '']]
      .map(function (t) { return '<a href="#/p/' + esc(p.id) + '/' + t[0] + '" class="' + (tab === t[0] ? 'on' : '') + '">' + t[1] + (t[2] !== '' ? '<span class="c">' + t[2] + '</span>' : '') + '</a>'; }).join('');
    var body = tab === 'versions' ? (route.vid ? reviewHtml(p) : versionsHtml(p)) : tab === 'files' ? filesHtml(p) : tab === 'hours' ? hoursHtml(p) : tab === 'brief' ? briefHtml(p) : messagesHtml(p);
    app.innerHTML = '<div class="wrap view"><p class="crumbs"><a href="#/">' + (EDITOR ? 'Studio' : 'Projects') + '</a> / ' + esc(p.title) + '</p>' +
      '<div class="row" style="justify-content:space-between;align-items:flex-end"><div><h1>' + esc(p.title) + '</h1><div class="row" style="gap:12px"><span class="pill ' + esc(p.status) + '">' + esc(statusLabel(p)) + '</span>' +
      (EDITOR ? workPill(p) : '') + '<span class="who">' + esc(EDITOR ? (p.clientName ? p.clientName + ' · ' : '') + p.clientEmail : 'Opened ' + fmtDate(p.createdAt)) + '</span>' + (openNotes ? '<span class="who">' + openNotes + ' open review note' + (openNotes > 1 ? 's' : '') + '</span>' : '') + '</div></div></div>' +
      '<div class="stepper">' + steps + '</div><div class="guide"><b>Next</b><span>' + esc(C.nextStep(p, ROLE)) + '</span></div>' +
      '<div class="pgrid"><section><nav class="tabs" aria-label="Project">' + tabs + '</nav>' + body + '</section><aside class="stack">' + sidebarHtml(p) + '</aside></div></div>';
    restore();
    var m = app.querySelector('.msgs');
    if (m && stick) m.scrollTop = m.scrollHeight;
    if (route.vid) mountPlayer(p);
    bindProject();
  }

  /* messages */
  function messagesHtml(p) {
    var mine = function (m) { return !m.system && m.role === ROLE; };
    var list = p.messages.map(function (m) {
      if (m.system) return '<div class="msg sys k-' + esc(m.kind || '') + '"><div class="h"><span>' + esc(fmtDate(m.at, true)) + '</span></div><div class="b">' + esc(m.body) + '</div></div>';
      var tag = m.kind === 'brief' ? ' · brief' : m.kind === 'estimate-note' ? ' · estimate note' : m.kind === 'version-note' ? ' · version note' : '';
      var tagRole = m.role === 'editor' ? ' (editor)' : m.role === 'agent' ? ' (editing agent)' : '';
      return '<div class="msg' + (mine(m) ? ' me' : '') + (m.role === 'agent' ? ' agent' : '') + '"><div class="h"><b>' + esc(m.by + tagRole) + '</b><span>' + esc(fmtDate(m.at, true) + tag) + '</span></div><div class="b">' + esc(m.body) + '</div></div>';
    }).join('');
    return '<div class="card"><div class="msgs" aria-live="polite">' + list + '</div>' +
      '<form class="compose" data-form="message"><textarea id="compose" data-keep name="body" rows="2" placeholder="' + (EDITOR ? 'Reply to the client' : 'Message the editor') + '. Everything here is logged in the project."></textarea><button class="btn sm" type="submit">Send</button></form>' +
      '<p class="note">Every message, estimate, payment, version and hour logged is kept here as the project record.</p></div>';
  }

  /* versions */
  function versionsHtml(p) {
    var rows = p.versions.slice().reverse().map(function (v) {
      var open = v.comments.filter(function (c) { return !c.resolved; }).length;
      return '<a class="vrow" href="#/p/' + esc(p.id) + '/v/' + esc(v.id) + '"><span class="n">V' + v.n + '</span><div><div class="t">' + esc(v.label) + '</div><div class="m">' + esc(fmtDate(v.createdAt, true)) + ' · ' + esc(PL.tc(v.durationSec)) + ' · ' + v.comments.length + ' note' + (v.comments.length === 1 ? '' : 's') + (open ? ', ' + open + ' open' : '') + (v.external ? ' · Blackmagic Cloud link' : '') + '</div></div>' +
        '<span class="vst ' + esc(v.status) + '">' + esc(v.status.replace('_', ' ')) + '</span></a>';
    }).join('');
    return (EDITOR ? postVersionHtml(p) : '') + (p.versions.length ? '<div class="vlist">' + rows + '</div>' : '<div class="empty"><h3>No versions yet.</h3><p>' + (EDITOR ? 'Post the first cut above.' : 'Each cut the editor posts appears here for review in your browser, with timestamped notes.') + '</p></div>');
  }
  function postVersionHtml(p) {
    if (p.status === 'purged') return '';
    if (!p.estimate) return '<div class="card" style="margin-bottom:16px"><p>Send the estimate before posting versions.</p></div>';
    return '<details class="card" style="margin-bottom:16px"' + (p.versions.length ? '' : ' open') + '><summary style="cursor:pointer;font:400 26px var(--f-display)">Post version ' + (p.versions.length + 1) + '</summary>' +
      '<form class="form" data-form="version" style="margin-top:14px">' +
      '<div class="g2"><label>Label<input name="label" id="v-label" data-keep placeholder="' + (p.versions.length ? 'Revision with notes addressed' : 'Rough cut') + '"></label><label>Render file<input name="file" type="file" accept="video/*"></label></div>' +
      (DEMO || p.demo ? '<label>No file? Length of the demo render (seconds)<input name="dur" type="number" min="5" max="600" value="45"></label>' : '') +
      '<label>Notes for the client<textarea name="note" id="v-note" data-keep rows="2"></textarea></label>' +
      '<label>Blackmagic Cloud or Resolve review link (optional)<input name="ext" type="url" placeholder="https://"></label>' +
      '<div class="row"><button class="btn sm" type="submit">Post for review</button><span class="note" style="margin:0">' + (DEMO ? 'Demo: a render you pick plays from this browser. Without one, a synthetic demo render is used.' : 'The render uploads to project storage and stays while hours or the archive subscription are active.') + '</span></div></form></details>';
  }

  function reviewHtml(p) {
    var v = p.versions.filter(function (x) { return x.id === route.vid; })[0];
    if (!v) return '<div class="empty"><h3>Version not found.</h3><a class="lnk" href="#/p/' + esc(p.id) + '/versions">All versions</a></div>';
    var cm = v.comments.map(function (c) {
      return '<div class="cmt' + (c.resolved ? ' res' : '') + '">' + (c.t == null ? '<span class="at gen">General</span>' : '<button type="button" class="at" data-act="seek" data-t="' + c.t + '">' + esc(PL.shortTc(c.t)) + '</button>') +
        '<span class="who">' + esc(c.by) + (c.role === 'editor' ? ' (editor)' : '') + ' · ' + esc(fmtDate(c.at, true)) + '</span><div class="body">' + esc(c.body) + '</div>' +
        '<div class="act"><button type="button" data-act="resolve" data-cid="' + esc(c.id) + '">' + (c.resolved ? 'Reopen' : 'Mark resolved') + '</button></div></div>';
    }).join('');
    var clientActs = !EDITOR && p.status !== 'purged' ? '<div class="row" style="margin-top:14px"><button class="btn sm ok" type="button" data-act="vstatus" data-s="approved"' + (v.status === 'approved' ? ' disabled' : '') + '>Approve version ' + v.n + '</button><button class="btn sm ghost" type="button" data-act="vstatus" data-s="changes_requested"' + (v.status === 'changes_requested' ? ' disabled' : '') + '>Request changes</button></div>' : '';
    var bm = v.external ? '<div class="bm"><span><b>Blackmagic Cloud</b> This version also has a Resolve presentation for frame-accurate review.</span><a class="btn xs ghost" href="' + esc(v.external.url) + '" target="_blank" rel="noopener">Open presentation</a></div>'
      : '<div class="bm"><span><b>Coming in Phase 2</b> Invite DWIM Logic into your shared Blackmagic Cloud project library and watch the timeline being built live in DaVinci Resolve. Rendered versions still land here for review and the archive.</span></div>';
    return '<p class="crumbs" style="margin-top:-4px"><a href="#/p/' + esc(p.id) + '/versions">Versions</a> / V' + v.n + '</p>' +
      '<div class="row" style="justify-content:space-between;margin-bottom:12px"><h3 style="font:400 34px/1 var(--f-display);margin:0">V' + v.n + ' · ' + esc(v.label) + '</h3><span class="vst ' + esc(v.status) + '">' + esc(v.status.replace('_', ' ')) + '</span></div>' +
      '<div class="review"><div><div id="player-slot"></div>' + (v.note ? '<p class="note" style="font-size:14px;color:#c4ccd6">' + esc(v.note) + '</p>' : '') + clientActs + bm + '</div>' +
      '<div class="card"><h4>Notes on this version</h4><div class="cmts">' + (cm || '<p>No notes yet. Pause where you want a change and write it below.</p>') + '</div>' +
      (p.status === 'purged' ? '' : '<form class="cform" data-form="comment"><span class="stamp" id="stamp">at ' + esc(PL.shortTc(playTime)) + '</span><textarea name="body" id="cbody" data-keep rows="3" placeholder="What should change here?"></textarea><label class="chk" style="font-size:13px"><input type="checkbox" name="pin" checked> Pin to the current frame</label><button class="btn sm" type="submit">Add note</button></form>') +
      '</div></div>';
  }

  function dropPlayer() { if (player) { player.destroy(); player = null; playerKey = ''; playerHost = null; } }
  function mountPlayer(p) {
    var v = p.versions.filter(function (x) { return x.id === route.vid; })[0];
    var slot = document.getElementById('player-slot');
    if (!v || !slot) return;
    var asset = v.assetId ? p.assets.filter(function (a) { return a.id === v.assetId; })[0] : null;
    var key = p.id + v.id + (asset && asset.purgedAt ? 'gone' : '');
    var markers = v.comments;
    if (player && playerKey === key && playerHost) { slot.replaceWith(playerHost); player.setMarkers(markers); return; }
    dropPlayer();
    playerHost = document.createElement('div');
    playerHost.id = 'player-host';
    slot.replaceWith(playerHost);
    playerKey = key;
    playTime = 0;
    var opts = { duration: v.durationSec, onTime: function (t) { playTime = t; var s = document.getElementById('stamp'); if (s) s.textContent = 'at ' + PL.shortTc(t); } };
    var make = function (o) { player = PL.create(playerHost, Object.assign(opts, o)); player.setMarkers(markers); };
    if (asset) {
      if (asset.purgedAt) return make({ missing: 'This render was removed under the retention rules. Notes and the message log are kept.' });
      S.fileUrl(p.id, asset).then(function (url) { make(url ? { src: url } : { missing: DEMO ? 'This render was picked in another browser, so it cannot play here.' : 'File not available.' }); });
    } else if (p.demo) make({ synthetic: { title: p.title, label: v.label, n: v.n, duration: v.durationSec } });
    else make({ missing: v.external ? 'Review this version on Blackmagic Cloud (link below).' : 'No render attached to this version.' });
  }

  /* files */
  var KIND = { source: 'Source', project: 'Project file', render: 'Render', deliverable: 'Final' };
  function filesHtml(p) {
    var rows = p.assets.slice().reverse().map(function (a) {
      var ret = '', soon = false;
      if (a.purgedAt) ret = 'Removed ' + fmtDate(a.purgedAt);
      else if (a.kind === 'source') { var exp = C.sourceExpiry(a), d = daysLeft(exp); soon = d <= C.RETENTION.sourceWarnDays; ret = 'Removed ' + fmtDate(exp) + ' if unused (' + Math.max(0, d) + ' days)'; }
      else if (p.purgeAfter && !C.archiveActive(p)) { ret = 'Removed ' + fmtDate(p.purgeAfter); soon = true; }
      else if (C.archiveActive(p)) ret = 'Kept while archived';
      else ret = 'Kept while hours remain';
      if (!a.ready && !a.purgedAt) ret = 'Upload not finished';
      var open = !a.purgedAt && (a.url || a.hasFile);
      return '<div class="frow' + (a.purgedAt ? ' gone' : '') + '"><span class="k ' + esc(a.kind) + '">' + esc(a.url ? 'Link' : KIND[a.kind]) + '</span>' +
        '<div class="nm" title="' + esc(a.name) + '">' + esc(a.name) + '<small>' + esc([bytes(a.size), a.uploadedBy, fmtDate(a.createdAt)].filter(Boolean).join(' · ')) + '</small></div>' +
        '<div class="ret' + (soon ? ' soon' : '') + '">' + esc(ret) + (open ? '<br><button class="lnk" type="button" style="font-size:12px" data-act="open-file" data-aid="' + esc(a.id) + '">' + (a.url ? 'Open link' : 'Open') + '</button>' : '') + '</div></div>';
    }).join('');
    var add = p.status === 'purged' ? '' : '<div class="card" style="margin-bottom:16px"><form class="form" data-form="upload"><div class="g2">' +
      (EDITOR ? '<label>Kind<select name="kind"><option value="render">Render</option><option value="deliverable">Final deliverable</option><option value="project">Project file (.drp, .prproj, graphics)</option><option value="source">Source footage</option></select></label>' : '') +
      '<label>Add files<input type="file" name="files" multiple></label>' + (EDITOR ? '' : '<label>Or a transfer link<input name="link" type="url" placeholder="https://"></label>') + '</div><div class="queue" id="queue"></div>' +
      '<div class="row"><button class="btn sm" type="submit">Add</button><span class="note" style="margin:0">Source footage clears after ' + C.RETENTION.sourceUnusedDays + ' days unused. Renders, finals and project files stay while hours or the archive subscription are active.</span></div></form></div>';
    return add + (p.assets.length ? '<div class="files">' + rows + '</div>' : '<div class="empty"><h3>No files yet.</h3></div>');
  }

  /* hours */
  function hoursHtml(p) {
    var rows = p.ledger.slice().reverse().map(function (e) {
      var src = e.type === 'purchase' ? (e.source === 'stripe' ? 'Stripe payment ' + C.money(e.amountCents) : 'Demo payment, no charge') : 'Logged by ' + e.by;
      return '<tr><td>' + esc(fmtDate(e.at, true)) + '</td><td>' + esc(e.note) + '<div class="src">' + esc(src) + '</div></td><td class="h' + (e.hours > 0 ? ' plus' : '') + '">' + (e.hours > 0 ? '+' : '−') + esc(C.hrs(Math.abs(e.hours))) + '</td></tr>';
    }).join('');
    return '<div class="card"><div class="g3" style="margin-bottom:18px"><div class="meter"><span class="kicker" style="margin:0">Prepaid</span><span class="big">' + p.totals.bought + '<small>hrs</small></span></div><div class="meter"><span class="kicker" style="margin:0">Used</span><span class="big">' + p.totals.used + '<small>hrs</small></span></div><div class="meter"><span class="kicker" style="margin:0">Left</span><span class="big">' + p.balance + '<small>hrs</small></span></div></div>' +
      (rows ? '<table class="ledger"><thead><tr><th>When</th><th>What</th><th style="text-align:right">Hours</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p>No hours yet. Prepaid hours and logged work appear here line by line.</p>') + '</div>';
  }

  function briefHtml(p) {
    var b = p.brief, d = C.DELIVERABLES[b.deliverable];
    var row = function (k, v) { return v || v === 0 ? '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' : ''; };
    return '<div class="card brief"><dl>' + row('Need', d && d.label) + row('Company', b.company) + row('Raw footage', b.footageMinutes + ' min') + row('Finished length', b.finishedMinutes + ' min') +
      row('Versions', b.versions) + row('Complexity', b.complexity) + row('Rush', b.rush ? 'Yes' : 'No') + row('Deadline', b.deadline) +
      (b.specs ? row('Resolution', C.DELIVERY.resolution[b.specs.resolution]) + row('Frame rate', b.specs.fps === 'source' ? 'Match source' : b.specs.fps + ' fps') + row('Handoff', C.DELIVERY.handoff[b.specs.handoff]) + row('Captions', b.specs.captions ? 'Yes' : 'No') + row('Specs', b.specs.notes) : '') +
      row('Blackmagic Cloud', p.integrations && p.integrations.blackmagic ? 'Interested in a shared Resolve project library (Phase 2)' : '') +
      row('Preliminary', C.hrs(p.preliminary.low) + ' to ' + C.hrs(p.preliminary.high)) + row('Description', b.description) + '</dl></div>';
  }

  /* sidebar */
  function meterHtml(p) {
    var pct = p.totals.bought ? Math.max(0, Math.min(100, p.balance / p.totals.bought * 100)) : 0;
    return '<div class="card"><h4>Prepaid hours</h4><div class="meter"><span class="big">' + p.balance + '<small>hrs left</small></span><div class="bar' + (pct <= 20 ? ' low' : '') + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="lbl"><span>' + p.totals.used + ' used</span><span>' + p.totals.bought + ' prepaid</span></div></div></div>';
  }
  function packsHtml(p, minHours, topup) {
    var rec = C.PRICING.packs.filter(function (k) { return k.hours >= minHours; })[0];
    return '<div class="pgrid-packs">' + C.packsFor(topup ? 0 : minHours).map(function (k) {
      return '<button type="button" class="pack' + (rec && k.id === rec.id && !topup ? ' rec' : '') + '" data-act="buy" data-pack="' + k.id + '"' + (k.eligible ? '' : ' disabled title="Below the minimum to start"') + '><span class="h">' + k.hours + '</span><span class="l">' + esc(k.label) + '<small>' + C.money(k.perHourCents) + ' per hour</small></span><span class="p">' + C.money(k.priceCents) + '</span></button>';
    }).join('') + '</div>';
  }
  function sidebarHtml(p) {
    var out = [];
    var archived = C.archiveActive(p);
    if (EDITOR) {
      if (p.status !== 'purged') out.push(workCardHtml(p));
      if (p.status !== 'purged') out.push(estimateFormHtml(p));
      if (p.status === 'active') out.push(burnFormHtml(p));
      if (p.ledger.length) out.push(meterHtml(p));
    } else {
      if (p.status === 'requested') out.push('<div class="card"><h4>Free estimate</h4><div class="est-live" style="border:0;padding:0"><strong>' + p.preliminary.low + '–' + p.preliminary.high + '</strong><span>hours, preliminary</span></div><p style="margin-top:12px">The editor reviews your brief and footage and confirms the estimate here. Nothing is charged until you choose an hour pack.</p></div>');
      if (p.status === 'estimated') out.push('<div class="card hot"><h4>Your free estimate</h4><div class="est-live" style="border:0;padding:0"><strong>' + p.estimate.low + '–' + p.estimate.high + '</strong><span>editing hours</span></div>' + (p.estimate.note ? '<p style="margin-top:10px;color:#c4ccd6">' + esc(p.estimate.note) + '</p>' : '') +
        '<p style="margin-top:12px">Prepay at least <b style="color:#fff">' + C.hrs(p.estimate.minHours) + '</b> to start. Work stops when hours run out, so there are no surprise invoices.</p>' + packsHtml(p, p.estimate.minHours) + payNote() + '</div>');
      if (p.ledger.length) out.push(meterHtml(p));
      if (p.status === 'active') out.push('<details class="card"><summary style="cursor:pointer"><h4 style="display:inline">Top up hours</h4></summary><div style="margin-top:12px">' + packsHtml(p, 0, true) + payNote() + '</div></details>');
      if (p.status === 'depleted' && !(p.archive && p.archive.declinedAt)) out.push(archiveOfferHtml(p));
      if (p.status === 'depleted' && p.archive && p.archive.declinedAt) out.push('<div class="card warn"><h4>Closing</h4><p>Project files are removed on <b style="color:#fff">' + fmtDate(p.purgeAfter) + '</b>. Download anything you need from Files. Changed your mind?</p><div class="row"><button class="btn sm" type="button" data-act="archive">Keep everything (' + C.money(C.PRICING.archive.priceCents) + '/' + C.PRICING.archive.interval + ')</button></div><details style="margin-top:12px"><summary class="lnk" style="display:inline">Or top up hours</summary><div style="margin-top:12px">' + packsHtml(p, 0, true) + '</div></details></div>');
      if (p.status === 'archived' || (archived && p.status === 'active')) out.push('<div class="card"><h4>Archive subscription</h4><p>' + (p.archive.status === 'canceling' ? 'Ends on <b style="color:#fff">' + fmtDate(p.archive.currentPeriodEnd) + '</b>, followed by a ' + C.RETENTION.lapsedArchiveGraceDays + '-day download window.' : 'Active. Next renewal ' + fmtDate(p.archive.currentPeriodEnd) + '.') + ' Project files, renders and finals stay stored. Source footage clears after ' + C.RETENTION.sourceUnusedDays + ' days unused.</p>' +
        (p.archive.status === 'active' ? '<button class="lnk" type="button" data-act="cancel-archive" style="font-size:13px">Cancel subscription</button>' : '') + (p.status === 'archived' ? '<details style="margin-top:12px"><summary class="lnk" style="display:inline">Need more work? Top up hours</summary><div style="margin-top:12px">' + packsHtml(p, 0, true) + payNote() + '</div></details>' : '') + '</div>');
      if (p.status === 'purged') out.push('<div class="card"><h4>Project closed</h4><p>Files were removed on ' + fmtDate(p.purgedAt) + '. The message log and hour ledger stay here for your records.</p><a class="btn sm" href="#/new">Start a new project</a></div>');
    }
    out.push(retentionCardHtml(p));
    return out.join('');
  }
  function payNote() {
    if (DEMO) return '<p class="note">Demo: checkout is simulated and no card is charged.</p>';
    if (CFG.payments === 'mock') return '<p class="note">Test mode: Stripe is not connected, so nothing is charged.</p>';
    return '<p class="note">Secure checkout by Stripe.</p>';
  }
  function archiveOfferHtml(p) {
    return '<div class="card hot"><h4>Hours used up</h4><h3>Keep it <em class="s">all.</em></h3><p>An archive subscription keeps this project, every render and the final deliverables available for <b style="color:#fff">' + C.money(C.PRICING.archive.priceCents) + ' a ' + C.PRICING.archive.interval + '</b>. Source footage still clears after ' + C.RETENTION.sourceUnusedDays + ' days unused. Cancel any time.</p>' +
      '<div class="row"><button class="btn sm" type="button" data-act="archive">Start archive subscription</button></div>' +
      '<details style="margin-top:14px"><summary class="lnk" style="display:inline">More work to do? Top up hours</summary><div style="margin-top:12px">' + packsHtml(p, 0, true) + '</div></details>' +
      '<p style="margin-top:14px">Without either, project files are removed on <b style="color:#fff">' + fmtDate(p.purgeAfter) + '</b>. <button class="lnk" type="button" data-act="decline" style="font-size:14px">No thanks, remove the files</button></p>' + payNote() + '</div>';
  }
  function retentionCardHtml(p) {
    var src = p.assets.filter(function (a) { return a.kind === 'source' && !a.purgedAt; });
    var next = src.map(C.sourceExpiry).sort()[0];
    var lines = [];
    lines.push('<p><b style="color:#fff">Source footage</b>: ' + (src.length ? src.length + ' item' + (src.length > 1 ? 's' : '') + '. Next removal ' + fmtDate(next) + ' unless used again.' : 'none stored.') + ' Cleared after ' + C.RETENTION.sourceUnusedDays + ' days unused.</p>');
    var keep;
    if (p.status === 'purged') keep = 'removed ' + fmtDate(p.purgedAt) + '.';
    else if (C.archiveActive(p)) keep = 'kept while the archive subscription is active.';
    else if (p.purgeAfter) keep = 'removed on ' + fmtDate(p.purgeAfter) + ' unless you subscribe to the archive or top up.';
    else keep = 'kept while prepaid hours remain. When they run out you can keep everything with an archive subscription.';
    lines.push('<p><b style="color:#fff">Project files, renders and finals</b>: ' + keep + '</p>');
    return '<div class="card"><h4>Storage and retention</h4>' + lines.join('') + '</div>';
  }
  function workCardHtml(p) {
    var w = p.work || { state: 'unassigned' }, a = w.assignee;
    var withAgent = a && a.kind === 'agent';
    var list = agents.length ? agents : (DEMO ? ['grok-bot', 'cursor-agent'] : []);
    var agentOpts = list.map(function (n) { return '<option' + (withAgent && a.name === n ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    var taskOpts = Object.keys(C.WORK_TASKS).map(function (k) { return '<option value="' + k + '"' + ((w.task || C.taskFor(p)) === k ? ' selected' : '') + '>' + esc(C.WORK_TASKS[k]) + '</option>'; }).join('');
    var states = ['in_edit', 'awaiting_client', 'needs_editor', 'done'].filter(function (s) { return s !== w.state; })
      .map(function (s) { return '<button type="button" data-act="work-state" data-s="' + s + '">' + esc(C.WORK_STATES[s]) + '</button>'; }).join('');
    var hot = w.state === 'needs_editor' || (p.status === 'active' && w.state === 'unassigned');
    return '<div class="card' + (hot ? ' hot' : '') + '"><h4>Work queue</h4>' +
      '<p><span class="pill work w-' + esc(w.state) + '">' + esc(C.WORK_STATES[w.state]) + '</span> ' + (a ? esc((withAgent ? 'Agent ' : '') + a.name) : 'Nobody yet') + (w.task ? ' · ' + esc(C.WORK_TASKS[w.task]) : '') + (w.clientWaiting ? ' · <b style="color:var(--warn)">client waiting</b>' : '') + '</p>' +
      (list.length ? '<form class="form" data-form="assign"><div class="g2"><label>Agent<select name="agent">' + agentOpts + '</select></label><label>Task<select name="task">' + taskOpts + '</select></label></div>' +
        '<label>Instructions for the agent<textarea name="instructions" id="agent-instr" data-keep rows="2" placeholder="Pacing, music, what to avoid. The brief, messages and media are included automatically.">' + esc(w.instructions || '') + '</textarea></label>' +
        '<div class="row"><button class="btn sm" type="submit">' + (withAgent ? 'Update hand-off' : 'Hand to agent') + '</button>' + (withAgent ? '<button class="lnk" type="button" data-act="take-back" style="font-size:13px">Take it back in house</button>' : '') + '</div></form>'
        : '<p class="note">No agents configured. Set EDITBOX_AGENT_KEYS on the server.</p>') +
      '<div class="chips" style="margin-top:12px">' + states + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn xs ghost" type="button" data-act="packet">View job packet</button>' +
      (DEMO && withAgent && p.status === 'active' && w.state === 'queued_for_agent' ? '<button class="btn xs" type="button" data-act="simulate-agent">Simulate agent run</button>' : '') + '</div></div>';
  }
  function estimateFormHtml(p) {
    var e = p.estimate || p.preliminary;
    var opts = C.PRICING.packs.map(function (k) { return '<option value="' + k.hours + '"' + (k.hours === e.minHours ? ' selected' : '') + '>' + k.hours + ' hrs (' + k.label + ')</option>'; }).join('');
    var open = p.status === 'requested';
    return '<details class="card' + (open ? ' hot' : '') + '"' + (open ? ' open' : '') + '><summary style="cursor:pointer"><h4 style="display:inline">' + (p.estimate ? 'Revise estimate' : 'Send free estimate') + '</h4></summary>' +
      '<form class="form" data-form="estimate" style="margin-top:12px"><p>Preliminary from the brief: ' + C.hrs(p.preliminary.low) + ' to ' + C.hrs(p.preliminary.high) + '.</p>' +
      '<div class="g2"><label>Low (hrs)<input name="low" type="number" step="0.25" min="0.5" value="' + e.low + '"></label><label>High (hrs)<input name="high" type="number" step="0.25" min="0.5" value="' + e.high + '"></label></div>' +
      '<label>Minimum to start<select name="minHours">' + opts + '</select></label><label>Note to the client<textarea name="note" id="est-note" data-keep rows="3" placeholder="Scope, assumptions, what is not included."></textarea></label>' +
      '<button class="btn sm" type="submit">' + (p.estimate ? 'Send revised estimate' : 'Send estimate') + '</button></form></details>';
  }
  function burnFormHtml(p) {
    return '<div class="card"><h4>Log hours</h4><p>' + C.hrs(p.balance) + ' left of ' + C.hrs(p.totals.bought) + '. The client sees every entry.</p><form class="form" data-form="burn">' +
      '<div class="chips">' + [0.25, 0.5, 1, 2, 4].map(function (h) { return '<button type="button" data-act="chip" data-h="' + h + '">' + h + 'h</button>'; }).join('') + '<button type="button" data-act="chip" data-h="' + p.balance + '">All left</button></div>' +
      '<div class="g2"><label>Hours<input name="hours" id="burn-h" type="number" step="0.25" min="0.25" max="' + p.balance + '" value="1"></label><label>For<input name="note" id="burn-note" data-keep placeholder="Assembly edit"></label></div>' +
      '<button class="btn sm" type="submit">Log hours</button></form></div>';
  }

  /* ---------- actions ---------- */
  function checkoutFlow(promise, what) {
    promise.then(function (r) {
      if (r.url) { location.href = r.url; return; }
      var title = what.kind === 'archive' ? 'Archive subscription' : what.pack.hours + ' prepaid hours';
      var price = what.kind === 'archive' ? C.money(C.PRICING.archive.priceCents) + ' / ' + C.PRICING.archive.interval : C.money(what.pack.priceCents);
      modal('<span class="tag">' + (DEMO ? 'Demo checkout' : 'Test checkout') + '</span><h3>' + esc(title) + '</h3>' +
        '<div class="line"><span>' + esc(project.title) + '</span><b>' + esc(price) + '</b></div>' +
        (what.kind === 'archive' ? '<div class="line"><span>Keeps</span><b>Project files, renders, finals</b></div>' : '<div class="line"><span>Balance after</span><b>' + esc(C.hrs(project.balance + what.pack.hours)) + '</b></div>') +
        '<p class="note" style="font-size:13px;margin:16px 0">No card is collected and nothing is charged. With Stripe connected, this step is Stripe Checkout.</p>' +
        '<div class="row"><button class="btn" type="button" data-ok>Complete ' + (DEMO ? 'demo' : 'test') + ' payment</button><button class="lnk" type="button" data-close>Cancel</button></div>', function (m, close) {
        m.querySelector('[data-ok]').addEventListener('click', function (e) {
          lock(e.target, true);
          apply(S.confirmMock(project.id, r.checkoutId), what.kind === 'archive' ? 'Archive subscription active.' : 'Hours added.').then(close, function () { lock(e.target, false); });
        });
      });
    }).catch(fail);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'logout') { S.logout().then(function () { me = null; go('#/login'); }); }
    if (act === 'sample-client') { var f = document.querySelector('[data-form=login]'); f.elements.email.value = 'client@example.com'; if (f.elements.name) f.elements.name.value = 'Sample Client'; f.requestSubmit(); }
    if (act === 'clock') {
      S.advanceClock(Number(b.getAttribute('data-days'))).then(function () { return S.retention(false); }).then(function (r) {
        var n = r.sourcePurged.length + r.projectsPurged.length;
        toast('Moved the demo date forward. Retention job ran' + (n ? ': ' + r.sourcePurged.length + ' source item(s) and ' + r.projectsPurged.length + ' project(s) cleared.' : ', nothing to remove.'));
        renderBar(); route.name === 'project' ? refresh() : onRoute();
      }).catch(fail);
    }
    if (act === 'reset-demo') {
      modal('<h3>Reset the demo?</h3><p class="sub" style="font-size:15px">Deletes every demo project, message and render stored in this browser.</p><div class="row"><button class="btn" type="button" data-ok>Reset</button><button class="lnk" type="button" data-close>Cancel</button></div>', function (m, close) {
        m.querySelector('[data-ok]').addEventListener('click', function () { S.reset().then(function () { close(); dropPlayer(); go('#/'); onRoute(); toast('Demo reset.'); }); });
      });
    }
    if (act === 'retention') {
      var dry = b.hasAttribute('data-dry');
      S.retention(dry).then(function (r) {
        var out = document.getElementById('ret-out');
        var msg = (dry ? 'Preview: ' : 'Done: ') + r.sourcePurged.length + ' source item(s), ' + r.projectsPurged.length + ' project(s) ' + (dry ? 'would be' : '') + ' cleared, ' + r.warnings.length + ' warning(s).';
        if (out) out.textContent = msg;
        if (!dry) toast(msg);
      }).catch(fail);
    }
    if (!project) return;
    if (act === 'buy') {
      var pack = C.packById(b.getAttribute('data-pack'));
      checkoutFlow(S.checkout(project.id, pack.id), { kind: 'hours', pack: pack });
    }
    if (act === 'archive') checkoutFlow(S.subscribeArchive(project.id), { kind: 'archive' });
    if (act === 'decline') {
      var when = new Date(Math.min(Date.parse(project.purgeAfter) || Infinity, S.now() + C.RETENTION.declinedDownloadDays * C.DAY));
      modal('<h3>Remove the files?</h3><p class="sub" style="font-size:15px">On <b>' + esc(fmtDate(when)) + '</b> every file in this project is removed: renders, finals, project files and footage. The message log and hour ledger stay. You can start a new project any time.</p>' +
        '<div class="row"><button class="btn" type="button" data-ok>Yes, remove them</button><button class="lnk" type="button" data-close>Keep my options open</button></div>', function (m, close) {
        m.querySelector('[data-ok]').addEventListener('click', function () { apply(S.declineArchive(project.id), 'Noted. Download anything you need before the removal date.').then(close); });
      });
    }
    if (act === 'cancel-archive') {
      modal('<h3>Cancel the archive?</h3><p class="sub" style="font-size:15px">It runs to ' + esc(fmtDate(project.archive.currentPeriodEnd)) + ', then you have ' + C.RETENTION.lapsedArchiveGraceDays + ' days to download before files are removed.</p><div class="row"><button class="btn" type="button" data-ok>Cancel subscription</button><button class="lnk" type="button" data-close>Keep it</button></div>', function (m, close) {
        m.querySelector('[data-ok]').addEventListener('click', function () { apply(S.cancelArchive(project.id), 'Subscription will end at the period end.').then(close); });
      });
    }
    if (act === 'take-back') apply(S.assignWork(project.id, { agent: '' }), 'Back in house.');
    if (act === 'work-state') apply(S.updateWork(project.id, { state: b.getAttribute('data-s') }), 'Work state updated.');
    if (act === 'simulate-agent') {
      lock(b, true);
      apply(S.simulateAgent(project.id), 'The agent pulled the job, cut in Resolve, posted a version and logged its hours.').catch(function () {}).then(function () { lock(b, false); });
    }
    if (act === 'packet') {
      Promise.all([S.packet(project.id, 'md'), S.packet(project.id)]).then(function (r) {
        modal('<span class="tag">Agent job packet</span><h3>What the agent pulls</h3><p class="note" style="font-size:13px;margin:0 0 12px">' + (DEMO ? 'Live mode: GET /editbox/api/agent/jobs/' + esc(project.id) + ' with the agent key (add ?format=md for Markdown).' : 'GET ' + esc(location.origin) + '/editbox/api/agent/jobs/' + esc(project.id) + ' · Authorization: Bearer &lt;agent key&gt;') + '</p>' +
          '<div class="chips" style="margin-bottom:10px"><button type="button" data-v="md">Markdown</button><button type="button" data-v="json">JSON</button><button type="button" data-copy>Copy</button></div>' +
          '<pre class="packet" id="packet-out"></pre><div class="row" style="margin-top:12px"><button class="lnk" type="button" data-close>Close</button></div>', function (m) {
          m.querySelector('.box').classList.add('wide');
          var out = m.querySelector('#packet-out'), cur = r[0];
          var show = function (v) { cur = v === 'json' ? JSON.stringify(r[1], null, 2) : r[0]; out.textContent = cur; };
          show('md');
          [].slice.call(m.querySelectorAll('[data-v]')).forEach(function (x) { x.addEventListener('click', function () { show(x.getAttribute('data-v')); }); });
          m.querySelector('[data-copy]').addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(cur).then(function () { toast('Copied.'); }); });
        });
      }).catch(fail);
    }
    if (act === 'chip') { var h = document.getElementById('burn-h'); if (h) h.value = b.getAttribute('data-h'); }
    if (act === 'seek' && player) { player.pause(); player.seek(Number(b.getAttribute('data-t'))); }
    if (act === 'resolve') apply(S.resolve(project.id, route.vid, b.getAttribute('data-cid')));
    if (act === 'vstatus') {
      var s = b.getAttribute('data-s');
      apply(S.setStatus(project.id, route.vid, s), s === 'approved' ? 'Approved. The editor has been told.' : 'Changes requested. Your notes are with the editor.');
    }
    if (act === 'open-file') {
      var a = project.assets.filter(function (x) { return x.id === b.getAttribute('data-aid'); })[0];
      if (a.url) { window.open(a.url, '_blank', 'noopener'); return; }
      S.fileUrl(project.id, a).then(function (u) { if (u) window.open(u, '_blank', 'noopener'); else toast('Demo: this file was recorded by name only.'); });
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target, kind = f.getAttribute('data-form');
    if (!kind) return;
    e.preventDefault();
    if (busy) return;
    var btn = f.querySelector('[type=submit]');
    if (kind === 'login') {
      lock(btn, true);
      S.login(val(f, 'email'), val(f, 'name')).then(function (r) {
        if (r.signedIn) { go('#/'); return; }
        var out = document.getElementById('login-out');
        out.innerHTML = r.devLink ? '<div class="devlink">Development mode: no email provider is configured, so here is your sign-in link.<br><a href="' + esc(r.devLink) + '">' + esc(r.devLink) + '</a></div>' : '<p class="note" style="color:var(--ok)">Check your inbox. The link works once, for 20 minutes.</p>';
      }).catch(fail).then(function () { lock(btn, false); });
      return;
    }
    if (kind === 'new') { submitNew(f, btn); return; }
    if (!project) return;
    var id = project.id, done = function () { lock(btn, false); };
    if (kind === 'message') {
      var body = val(f, 'body').trim();
      if (!body) return;
      lock(btn, true);
      apply(S.message(id, body)).then(function () { var c = document.getElementById('compose'); if (c) c.value = ''; }).catch(function () {}).then(done);
    }
    if (kind === 'assign') {
      lock(btn, true);
      apply(S.assignWork(id, { agent: val(f, 'agent'), task: val(f, 'task'), instructions: val(f, 'instructions') }), 'Handed to ' + val(f, 'agent') + '.').catch(function () {}).then(done);
    }
    if (kind === 'estimate') {
      lock(btn, true);
      apply(S.estimate(id, { low: val(f, 'low'), high: val(f, 'high'), minHours: val(f, 'minHours'), note: val(f, 'note') }), 'Estimate sent to the client.').then(function () { var n = document.getElementById('est-note'); if (n) n.value = ''; }).catch(function () {}).then(done);
    }
    if (kind === 'burn') {
      lock(btn, true);
      apply(S.burn(id, { hours: val(f, 'hours'), note: val(f, 'note') }), 'Hours logged.').then(function () { var n = document.getElementById('burn-note'); if (n) n.value = ''; }).catch(function () {}).then(done);
    }
    if (kind === 'comment') {
      var text = val(f, 'body').trim();
      if (!text) return;
      lock(btn, true);
      apply(S.comment(id, route.vid, { body: text, t: val(f, 'pin') ? playTime : null })).then(function () { var c = document.getElementById('cbody'); if (c) c.value = ''; }).catch(function () {}).then(done);
    }
    if (kind === 'upload') {
      var files = [].slice.call(f.elements.files.files), link = f.elements.link ? f.elements.link.value.trim() : '', k = f.elements.kind ? f.elements.kind.value : 'source';
      if (!files.length && !link) { toast('Choose a file or paste a link.', true); return; }
      lock(btn, true);
      f.querySelector('#queue').innerHTML = files.map(function (fl, i) { return '<div><span>' + esc(fl.name) + '</span><span>' + bytes(fl.size) + '</span></div><div class="prog"><i id="pu' + i + '"></i></div>'; }).join('');
      var chain = Promise.resolve();
      files.forEach(function (fl, i) { chain = chain.then(function () { return S.upload(id, fl, k, function (x) { var el = document.getElementById('pu' + i); if (el) el.style.width = Math.round(x * 100) + '%'; }); }); });
      if (link) chain = chain.then(function () { return S.addLink(id, link); });
      apply(chain, 'Added.').catch(function () {}).then(done);
    }
    if (kind === 'version') {
      var file = f.elements.file.files[0];
      var d = { label: val(f, 'label'), note: val(f, 'note'), externalUrl: val(f, 'ext').trim() || undefined, durationSec: f.elements.dur ? Number(f.elements.dur.value) : 60 };
      lock(btn, true);
      var step = file ? videoDuration(file).then(function (sec) {
        if (sec) d.durationSec = sec;
        btn.textContent = 'Uploading…';
        return S.upload(id, file, 'render');
      }).then(function (j) { d.assetId = j.result && j.result.id; }) : Promise.resolve();
      step.then(function () { return S.postVersion(id, d); }).then(function (j) {
        ['v-label', 'v-note'].forEach(function (x) { var el = document.getElementById(x); if (el) el.value = ''; });
        toast('Version posted. The client can review it now.');
        go('#/p/' + id + '/v/' + j.result.id);
      }).catch(fail).then(function () { done(); btn.textContent = 'Post for review'; });
    }
  });

  function videoDuration(file) {
    return new Promise(function (res) {
      var v = document.createElement('video'), u = URL.createObjectURL(file), t = setTimeout(function () { res(0); }, 8000);
      v.preload = 'metadata';
      v.onloadedmetadata = function () { clearTimeout(t); res(isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : 0); URL.revokeObjectURL(u); };
      v.onerror = function () { clearTimeout(t); res(0); };
      v.src = u;
    });
  }

  function bindProject() {}

  S.onExternalChange(function () { renderBar(); if (route.name === 'project') refresh(); else if (route.name !== 'new') onRoute(); });
  if (!DEMO) setInterval(function () {
    var a = document.activeElement;
    if (route.name === 'project' && !document.hidden && !(a && /TEXTAREA|INPUT|SELECT/.test(a.tagName))) refresh();
  }, 20000);
  window.addEventListener('hashchange', onRoute);
  onRoute();
})();
