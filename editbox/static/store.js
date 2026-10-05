/* Data layer for the portal and studio. Two adapters with one interface:
 *  DemoStore: runs the shared core ops against localStorage (blobs in IndexedDB). No network, no charges.
 *  LiveStore: talks to the Edit Box server API (editbox/server). */
(function () {
  'use strict';
  var C = window.EditBoxCore;
  var CFG = window.EDITBOX_CONFIG || { mode: 'demo' };

  /* ---------- tiny IndexedDB blob store for demo renders ---------- */
  var idb = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error('no idb')); return; }
        var r = indexedDB.open('editbox-demo', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('blobs'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('blobs', mode), s = t.objectStore('blobs'), out = fn(s);
          t.oncomplete = function () { res(out && out.result); };
          t.onerror = function () { rej(t.error); };
        });
      });
    }
    return {
      put: function (k, b) { return tx('readwrite', function (s) { s.put(b, k); }); },
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
      del: function (k) { return tx('readwrite', function (s) { s.delete(k); }).catch(function () {}); },
      clear: function () { return tx('readwrite', function (s) { s.clear(); }).catch(function () {}); }
    };
  })();

  /* ---------- demo ---------- */
  function DemoStore(role) {
    var KEY = 'editbox-demo-v1';
    var EDITOR = { email: 'editor@dwimlogic.demo', role: 'editor', name: 'Yan · DWIM Logic' };
    var state;
    var listeners = [];

    function load() {
      try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) { state = null; }
      if (!state || !state.db) state = { db: C.emptyDb(), offset: 0, client: null };
    }
    function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
    load();
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) { load(); listeners.forEach(function (f) { f(); }); }
    });

    function now() { return Date.now() + (state.offset || 0); }
    function actor() { return role === 'editor' ? EDITOR : state.client && { email: state.client.email, role: 'client', name: state.client.name || state.client.email }; }
    function need() {
      var a = actor();
      if (!a) return Promise.reject(C.EditBoxError(401, 'Sign in first.'));
      return a;
    }
    /* Load, apply, save in one synchronous step so tabs sharing localStorage never write stale state. Reads never save. */
    function run(fn, readOnly) {
      return new Promise(function (resolve) {
        load();
        var a = need();
        if (a.then) { resolve(a); return; }
        var out = fn(a, now());
        if (!readOnly) save();
        resolve(out);
      });
    }
    function view(id) {
      return run(function (a) { return C.publicProject(C.find(state.db, a, id)); }, true);
    }
    function mut(id, fn) { return run(function (a, t) { var r = fn(a, t); return { project: C.publicProject(C.find(state.db, a, id)), result: r && r.id ? r : undefined }; }); }

    return {
      mode: 'demo',
      role: role,
      payments: 'demo',
      onExternalChange: function (f) { listeners.push(f); },
      now: now,
      me: function () { load(); return Promise.resolve({ me: actor() || null }); },
      login: function (email, name) {
        email = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Promise.reject(C.EditBoxError(400, 'Enter a valid email address.'));
        state.client = { email: email, name: String(name || '').trim() || email };
        save();
        return Promise.resolve({ ok: true, signedIn: true });
      },
      logout: function () { state.client = null; save(); return Promise.resolve(); },
      listProjects: function () { return run(function (a) { return C.listProjects(state.db, a).map(C.publicProject); }, true); },
      getProject: view,
      createProject: function (input) {
        input.demo = true;
        return run(function (a, t) { return C.publicProject(C.createProject(state.db, a, input, t)); });
      },
      message: function (id, body) { return mut(id, function (a, t) { return C.postMessage(state.db, a, id, body, t); }); },
      estimate: function (id, d) { return mut(id, function (a, t) { return C.sendEstimate(state.db, a, id, d, t); }); },
      burn: function (id, d) { return mut(id, function (a, t) { return C.burnHours(state.db, a, id, d, t); }); },
      checkout: function (id, packId) { return Promise.resolve({ mock: true, checkoutId: 'hours:' + packId }); },
      subscribeArchive: function () { return Promise.resolve({ mock: true, checkoutId: 'archive' }); },
      confirmMock: function (id, checkoutId) {
        return mut(id, function (a, t) {
          C.find(state.db, a, id);
          if (checkoutId === 'archive') return C.activateArchive(state.db, id, { source: 'demo' }, t);
          return C.creditHours(state.db, id, { packId: checkoutId.split(':')[1], source: 'demo', amountCents: 0 }, t);
        });
      },
      cancelArchive: function (id) { return mut(id, function (a, t) { return C.cancelArchive(state.db, a, id, t); }); },
      declineArchive: function (id) { return mut(id, function (a, t) { return C.declineArchive(state.db, a, id, t); }); },
      addLink: function (id, url) { return mut(id, function (a, t) { return C.addAsset(state.db, a, id, { kind: 'source', url: url }, t); }); },
      upload: function (id, file, kind, onProgress) {
        // Demo keeps renders and finals in this browser so they play back; source footage is recorded by name only.
        var keep = kind !== 'source' && file.size < 1024 * 1048576;
        var assetId = C.id('ast');
        var key = keep ? 'idb:' + assetId : null;
        var p = keep ? idb.put(key, file).catch(function () { key = null; }) : Promise.resolve();
        return p.then(function () {
          if (onProgress) onProgress(1);
          return mut(id, function (a, t) { return C.addAsset(state.db, a, id, { id: assetId, kind: kind, name: file.name, size: file.size, type: file.type, key: key }, t); });
        });
      },
      postVersion: function (id, d) { return mut(id, function (a, t) { return C.postVersion(state.db, a, id, d, t); }); },
      comment: function (id, vid, d) { return mut(id, function (a, t) { return C.addComment(state.db, a, id, vid, d, t); }); },
      resolve: function (id, vid, cid) { return mut(id, function (a, t) { return C.resolveComment(state.db, a, id, vid, cid, t); }); },
      setStatus: function (id, vid, s) { return mut(id, function (a, t) { return C.setVersionStatus(state.db, a, id, vid, s, t); }); },
      fileUrl: function (projectId, asset) {
        run(function (a, t) { try { C.touchAsset(state.db, a, projectId, asset.id, t); } catch (e) {} });
        var raw = state.db.projects.filter(function (p) { return p.id === projectId; })[0];
        var full = raw && raw.assets.filter(function (x) { return x.id === asset.id; })[0];
        if (!full || !full.key) return Promise.resolve(null);
        return idb.get(full.key).then(function (b) { return b ? URL.createObjectURL(b) : null; }).catch(function () { return null; });
      },
      retention: function (dryRun) {
        return run(function (a, t) {
          var r = C.runRetention(state.db, t, { dryRun: dryRun });
          if (!dryRun) r.deleteKeys.forEach(function (k) { if (/^idb:/.test(k)) idb.del(k); });
          return r;
        }, dryRun);
      },
      agents: function () { return Promise.resolve(['grok-bot', 'cursor-agent']); },
      assignWork: function (id, d) { return mut(id, function (a, t) { return C.assignWork(state.db, a, id, d, t); }); },
      updateWork: function (id, d) { return mut(id, function (a, t) { return C.updateWork(state.db, a, id, d, t); }); },
      packet: function (id, format) {
        return run(function (a) {
          var k = C.jobPacket(C.find(state.db, a, id), function (x) { return x.key ? 'demo-blob://' + x.id : null; });
          return format === 'md' ? C.jobPacketMarkdown(k) : k;
        }, true);
      },
      /* Plays the agent's side of the loop so the demo shows it end to end: claim, read, log hours, post a cut. */
      simulateAgent: function (id) {
        return run(function (a, t) {
          var p = C.find(state.db, a, id);
          var name = p.work.assignee && p.work.assignee.kind === 'agent' ? p.work.assignee.name : 'grok-bot';
          var bot = { email: 'agent:' + name, role: 'agent', name: name };
          var task = p.work.task || C.taskFor(p);
          C.claimWork(state.db, bot, id, t);
          var k = C.jobPacket(p);
          var notes = k.openNotes.length;
          var bal = C.balance(p);
          var h = Math.min(bal, task === 'first_cut' ? Math.min(3, Math.max(1, Math.floor(bal / 2))) : 1);
          if (task === 'deliver_finals') {
            C.burnHours(state.db, bot, id, { hours: Math.min(bal, 0.5), note: 'Final renders to spec from DaVinci Resolve' }, t + 1000);
            if (p.status === 'active') {
              C.addAsset(state.db, bot, id, { kind: 'deliverable', name: p.title.replace(/\W+/g, '_') + '_FINAL_' + (k.delivery.resolution || '').split(' ')[0] + '.mp4', size: 412000000 }, t + 2000);
              C.postMessage(state.db, bot, id, 'Finals are rendered and in Files. Resolve project archived alongside them.', t + 3000);
              C.updateWork(state.db, bot, id, { state: 'awaiting_client' }, t + 3000);
            }
            return;
          }
          C.postMessage(state.db, bot, id, 'Pulled the job packet: ' + k.media.length + ' media item(s), ' + k.messages.length + ' logged messages' + (notes ? ', ' + notes + ' open review note(s)' : '') + '. ' + (task === 'first_cut' ? 'Building the timeline in DaVinci Resolve now.' : 'Working through the notes in Resolve.'), t + 1000);
          C.postVersion(state.db, bot, id, { label: task === 'first_cut' ? 'First cut' : 'Revision ' + p.versions.length, note: task === 'first_cut' ? 'First pass against the brief. Timestamped notes welcome.' : 'Notes from the last version addressed.', durationSec: Math.round(Math.min(90, Math.max(20, (p.brief.finishedMinutes || 1) * 30))) }, t + 2000);
          if (h > 0) C.burnHours(state.db, bot, id, { hours: h, note: task === 'first_cut' ? 'Assembly and first cut in Resolve' : 'Revision: ' + notes + ' note(s) addressed' }, t + 3000);
        });
      },
      advanceClock: function (days) { load(); state.offset = (state.offset || 0) + days * C.DAY; save(); return Promise.resolve(now()); },
      reset: function () { localStorage.removeItem(KEY); load(); return idb.clear(); }
    };
  }

  /* ---------- live ---------- */
  function LiveStore(role) {
    function api(method, path, body) {
      return fetch('/editbox/api' + path, {
        method: method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-EditBox': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw C.EditBoxError(r.status, j.error || 'Request failed.');
          return j;
        });
      });
    }
    var P = function (id) { return '/projects/' + encodeURIComponent(id); };
    function put(url, file, onProgress) {
      return new Promise(function (res, rej) {
        var x = new XMLHttpRequest();
        x.open('PUT', url);
        if (file.type) x.setRequestHeader('Content-Type', file.type);
        x.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        x.onload = function () { x.status < 300 ? res() : rej(C.EditBoxError(x.status, 'Upload failed (' + x.status + ').')); };
        x.onerror = function () { rej(C.EditBoxError(0, 'Upload failed. Check your connection.')); };
        x.send(file);
      });
    }
    return {
      mode: 'live',
      role: role,
      payments: CFG.payments,
      onExternalChange: function () {},
      now: function () { return Date.now(); },
      me: function () { return api('GET', '/me'); },
      login: function (email) { return api('POST', '/auth/request', { email: email, next: role === 'editor' ? 'studio' : 'portal' }); },
      logout: function () { return api('POST', '/auth/logout', {}); },
      listProjects: function () { return api('GET', '/projects').then(function (j) { return j.projects; }); },
      getProject: function (id) { return api('GET', P(id)).then(function (j) { return j.project; }); },
      createProject: function (input) { return api('POST', '/projects', input).then(function (j) { return j.project; }); },
      message: function (id, body) { return api('POST', P(id) + '/messages', { body: body }); },
      estimate: function (id, d) { return api('POST', P(id) + '/estimate', d); },
      burn: function (id, d) { return api('POST', P(id) + '/burn', d); },
      checkout: function (id, packId) { return api('POST', P(id) + '/checkout', { packId: packId }); },
      subscribeArchive: function (id) { return api('POST', P(id) + '/archive/subscribe', {}); },
      confirmMock: function (id, checkoutId) { return api('POST', '/checkouts/' + encodeURIComponent(checkoutId) + '/confirm-mock', {}); },
      cancelArchive: function (id) { return api('POST', P(id) + '/archive/cancel', {}); },
      declineArchive: function (id) { return api('POST', P(id) + '/archive/decline', {}); },
      addLink: function (id, url) { return api('POST', P(id) + '/links', { url: url }); },
      upload: function (id, file, kind, onProgress) {
        return api('POST', P(id) + '/uploads', { name: file.name, size: file.size, type: file.type, kind: kind }).then(function (j) {
          return put(j.upload.url, file, onProgress).then(function () {
            return api('POST', P(id) + '/assets/' + j.asset.id + '/complete', {});
          });
        });
      },
      postVersion: function (id, d) { return api('POST', P(id) + '/versions', d); },
      comment: function (id, vid, d) { return api('POST', P(id) + '/versions/' + vid + '/comments', d); },
      resolve: function (id, vid, cid) { return api('POST', P(id) + '/versions/' + vid + '/comments/' + cid + '/resolve', {}); },
      setStatus: function (id, vid, s) { return api('POST', P(id) + '/versions/' + vid + '/status', { status: s }); },
      fileUrl: function (projectId, asset) { return Promise.resolve(asset.hasFile ? '/editbox/api' + P(projectId) + '/assets/' + asset.id + '/file' : null); },
      agents: function () { return api('GET', '/me').then(function (j) { return j.agents || []; }); },
      assignWork: function (id, d) { return api('POST', P(id) + '/work/assign', d); },
      updateWork: function (id, d) { return api('POST', P(id) + '/work', d); },
      packet: function (id, format) {
        if (format !== 'md') return api('GET', '/agent/jobs/' + encodeURIComponent(id)).then(function (j) { return j.job; });
        return fetch('/editbox/api/agent/jobs/' + encodeURIComponent(id) + '?format=md', { credentials: 'same-origin' }).then(function (r) { return r.text(); });
      },
      retention: function (dryRun) { return api('POST', '/admin/retention', { dryRun: !!dryRun }).then(function (j) { return j.report; }); }
    };
  }

  window.EditBoxStore = function (role) { return CFG.mode === 'live' ? LiveStore(role) : DemoStore(role); };
})();
