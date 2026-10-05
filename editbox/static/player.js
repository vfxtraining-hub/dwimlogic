/* Review player: one control set for a real <video> or a synthetic "demo render" drawn on canvas.
 * Exposes currentTime/seek/pause and comment markers on the scrub bar. */
(function () {
  'use strict';
  var FPS = 24;

  function tc(t) {
    t = Math.max(0, t || 0);
    var f = Math.floor((t % 1) * FPS), s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    var z = function (n) { return (n < 10 ? '0' : '') + n; };
    return z(h) + ':' + z(m) + ':' + z(s) + ':' + z(f);
  }
  function shortTc(t) {
    t = Math.max(0, t || 0);
    var s = Math.floor(t) % 60, m = Math.floor(t / 60);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + Math.floor((t % 1) * FPS).toString().padStart(2, '0');
  }

  /* Synthetic render: a slate, colour bars, a moving "edit" and burned-in timecode. */
  function Synthetic(canvas, meta) {
    var ctx = canvas.getContext('2d'), W = canvas.width = 1280, H = canvas.height = 720;
    var t = 0, playing = false, last = 0, raf = 0, listeners = [];
    var dur = meta.duration || 45;
    var shots = [];
    var hue = (meta.n * 47) % 360;
    for (var i = 0, x = 0; x < dur; i++) { var len = 2.5 + ((i * 7919 + meta.n * 31) % 50) / 10; shots.push({ at: x, len: len, h: (hue + i * 33) % 360 }); x += len; }
    function draw() {
      var shot = shots[0];
      for (var i = 0; i < shots.length; i++) if (shots[i].at <= t) shot = shots[i];
      var k = (t - shot.at) / shot.len;
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, 'hsl(' + shot.h + ',45%,' + (14 + 6 * Math.sin(k * 3)) + '%)');
      g.addColorStop(1, 'hsl(' + ((shot.h + 40) % 360) + ',55%,6%)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = 'hsl(' + shot.h + ',80%,60%)';
      ctx.beginPath(); ctx.arc(W * (0.2 + 0.6 * k), H * (0.45 + 0.12 * Math.sin(t * 1.3)), 150 + 40 * Math.sin(t), 0, 6.283); ctx.fill();
      ctx.restore();
      if (t < 3) {
        var bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
        ctx.globalAlpha = Math.max(0, 1 - t / 3) * 0.9;
        bars.forEach(function (c, i) { ctx.fillStyle = c; ctx.fillRect(i * W / 7, 0, W / 7 + 1, H * 0.66); });
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, 64); ctx.fillRect(0, H - 64, W, 64);
      ctx.fillStyle = '#fff'; ctx.font = '400 34px Anton, Impact, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText((meta.title || 'Project').toUpperCase(), 28, 33);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ff4b3a'; ctx.font = '500 20px "IBM Plex Mono", monospace';
      ctx.fillText('V' + meta.n + ' · ' + (meta.label || ''), W - 28, 33);
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '500 26px "IBM Plex Mono", monospace';
      ctx.fillText(tc(t), 28, H - 32);
      ctx.textAlign = 'right'; ctx.fillStyle = '#9aa5b3'; ctx.font = '500 16px "IBM Plex Mono", monospace';
      ctx.fillText('DEMO RENDER · SHOT ' + (shots.indexOf(shot) + 1), W - 28, H - 32);
      ctx.textAlign = 'left';
    }
    function loop(ts) {
      if (!playing) return;
      if (last) t += (ts - last) / 1000;
      last = ts;
      if (t >= dur) { t = dur; playing = false; emit('pause'); }
      draw(); emit('timeupdate');
      if (playing) raf = requestAnimationFrame(loop);
    }
    function emit(n) { listeners.forEach(function (l) { if (l[0] === n) l[1](); }); }
    draw();
    return {
      get currentTime() { return t; },
      set currentTime(v) { t = Math.max(0, Math.min(dur, v)); draw(); emit('timeupdate'); },
      get duration() { return dur; },
      get paused() { return !playing; },
      play: function () { if (t >= dur) t = 0; playing = true; last = 0; raf = requestAnimationFrame(loop); emit('play'); return Promise.resolve(); },
      pause: function () { playing = false; cancelAnimationFrame(raf); emit('pause'); },
      addEventListener: function (n, f) { listeners.push([n, f]); },
      destroy: function () { playing = false; cancelAnimationFrame(raf); }
    };
  }

  function create(host, opts) {
    host.innerHTML = '<div class="player"><div class="screen"></div><div class="pctl">' +
      '<button type="button" data-p="play">Play</button><button type="button" data-p="back" title="Back 2 seconds">−2s</button>' +
      '<div class="scrub" role="slider" aria-label="Scrub" tabindex="0"><div class="rail"></div><div class="fill"></div></div>' +
      '<span class="tc">00:00:00:00</span></div></div>';
    var screen = host.querySelector('.screen'), btn = host.querySelector('[data-p=play]'), scrub = host.querySelector('.scrub'),
      fill = host.querySelector('.fill'), tcEl = host.querySelector('.tc');
    var media, markers = [], onTime = opts.onTime || function () {};
    if (opts.src) {
      media = document.createElement('video');
      media.src = opts.src; media.preload = 'metadata'; media.playsInline = true;
      screen.appendChild(media);
    } else if (opts.synthetic) {
      var cv = document.createElement('canvas');
      screen.appendChild(cv);
      media = Synthetic(cv, opts.synthetic);
    } else {
      screen.innerHTML = '<div class="gone">' + (opts.missing || 'This file is no longer available.') + '</div>';
      media = { currentTime: 0, duration: opts.duration || 0, paused: true, play: function () { return Promise.resolve(); }, pause: function () {}, addEventListener: function () {} };
    }
    function dur() { return isFinite(media.duration) && media.duration > 0 ? media.duration : (opts.duration || 1); }
    function paint() {
      fill.style.width = (media.currentTime / dur() * 100) + '%';
      tcEl.textContent = tc(media.currentTime) + ' / ' + tc(dur());
      btn.textContent = media.paused ? 'Play' : 'Pause';
      onTime(media.currentTime);
    }
    function drawMarkers() {
      [].slice.call(scrub.querySelectorAll('.mk')).forEach(function (m) { m.remove(); });
      markers.forEach(function (c) {
        if (c.t == null) return;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'mk' + (c.resolved ? ' res' : '');
        b.style.left = Math.min(100, c.t / dur() * 100) + '%';
        b.title = shortTc(c.t) + ' ' + c.body;
        b.addEventListener('click', function (e) { e.stopPropagation(); seek(c.t); if (opts.onMarker) opts.onMarker(c); });
        scrub.appendChild(b);
      });
    }
    function seek(t) { media.currentTime = Math.max(0, Math.min(dur(), t)); paint(); }
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'seeked'].forEach(function (n) { media.addEventListener(n, function () { paint(); if (n === 'loadedmetadata') drawMarkers(); }); });
    btn.addEventListener('click', function () { media.paused ? media.play() : media.pause(); });
    host.querySelector('[data-p=back]').addEventListener('click', function () { seek(media.currentTime - 2); });
    function fromEvent(e) { var r = scrub.getBoundingClientRect(); return (e.clientX - r.left) / r.width * dur(); }
    var dragging = false;
    scrub.addEventListener('pointerdown', function (e) { if (e.target.classList.contains('mk')) return; dragging = true; scrub.setPointerCapture(e.pointerId); seek(fromEvent(e)); });
    scrub.addEventListener('pointermove', function (e) { if (dragging) seek(fromEvent(e)); });
    scrub.addEventListener('pointerup', function () { dragging = false; });
    scrub.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { seek(media.currentTime - 1 / FPS * (e.shiftKey ? 24 : 1)); e.preventDefault(); }
      if (e.key === 'ArrowRight') { seek(media.currentTime + 1 / FPS * (e.shiftKey ? 24 : 1)); e.preventDefault(); }
      if (e.key === ' ') { btn.click(); e.preventDefault(); }
    });
    paint();
    return {
      get currentTime() { return media.currentTime; },
      get duration() { return dur(); },
      seek: seek,
      pause: function () { media.pause(); },
      setMarkers: function (list) { markers = list || []; drawMarkers(); },
      destroy: function () { if (media.destroy) media.destroy(); if (media.pause) media.pause(); host.innerHTML = ''; }
    };
  }

  window.EditBoxPlayer = { create: create, tc: tc, shortTc: shortTc };
})();
