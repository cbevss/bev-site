/*
 * Status page: asks this site's backend (/api/status) whether the bot is running, every 30 seconds.
 */
(function (root) {
  'use strict';
  var doc = root.document;

  function duration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function set(id, text) { doc.getElementById(id).textContent = text; }

  function draw(data) {
    var box = doc.getElementById('state');
    var online = data && data.online === true;
    box.className = 'bigstat ' + (online ? 'up' : 'down');
    set('statetext', online ? 'BEV is online' : data && data.reachable === false ? 'BEV is offline or starting up' : 'BEV is not connected to Discord right now');
    set('servers', online ? Number(data.servers).toLocaleString() : '—');
    set('ping', online && data.latency_ms !== null ? data.latency_ms + ' ms' : '—');
    set('uptime', online ? duration(data.uptime_s) : '—');
    set('commands', online ? String(data.commands) : '—');
    drawHistory(data && Array.isArray(data.history) ? data.history : []);
    set('checked', 'Last checked ' + new Date().toLocaleTimeString() + '. This page checks again every 30 seconds.');
  }

  // One bar per hour for the last 7 days: green when BEV was online all hour, amber for some downtime, red when offline.
  function drawHistory(hours) {
    var box = doc.getElementById('uptimebox');
    if (!box) return;
    var known = hours.filter(function (v) { return typeof v === 'number'; });
    if (!known.length) { box.hidden = true; return; }
    var bars = doc.getElementById('upbars');
    bars.replaceChildren();
    var now = new Date();
    now.setMinutes(0, 0, 0);
    hours.forEach(function (v, i) {
      var b = doc.createElement('span');
      var when = new Date(now.getTime() - (hours.length - 1 - i) * 3600000);
      var label = when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      b.dataset.when = label;
      if (typeof v !== 'number') { b.className = 'none'; b.dataset.what = 'No record'; }
      else {
        b.className = v >= 0.99 ? 'ok' : v > 0 ? 'part' : 'off';
        b.dataset.what = v >= 0.99 ? 'Online all hour' : v > 0 ? 'Online ' + Math.round(v * 100) + '% of the hour' : 'Offline';
      }
      bars.appendChild(b);
    });
    // The key only lists the colours that are actually in the bars.
    [['lgpart', function (v) { return typeof v === 'number' && v > 0 && v < 0.99; }], ['lgoff', function (v) { return v === 0; }],
     ['lgnone', function (v) { return typeof v !== 'number'; }]].forEach(function (k) {
      var el = doc.getElementById(k[0]);
      if (el) el.hidden = !hours.some(k[1]);
    });
    var pct = known.reduce(function (a, b) { return a + b; }, 0) / known.length * 100;
    var text = (pct >= 99.95 ? '100' : pct.toFixed(pct >= 99 ? 2 : 1)) + '% online';
    set('uppct', text);
    bars.setAttribute('aria-label', 'BEV was ' + text + ' over the last ' + (known.length >= 168 ? '7 days' : Math.round(known.length / 24 * 10) / 10 + ' days') + '.');
    box.hidden = false;
    wireTips();
    if (tipBar && !tipBar.isConnected) hideTip();
  }

  // The site's own tooltip (same look as the charts), shown after 0.2s on a bar.
  var tip = null, tipTimer = 0, tipBar = null;
  function hideTip() {
    root.clearTimeout(tipTimer);
    tipBar = null;
    if (tip) tip.hidden = true;
  }
  function showTip(bar) {
    var box = doc.getElementById('uptimebox');
    if (!tip) {
      tip = doc.createElement('div');
      tip.className = 'tip uptip';
      tip.setAttribute('role', 'tooltip');
      box.appendChild(tip);
    }
    var when = doc.createElement('span'), what = doc.createElement('b'), dot = doc.createElement('i');
    when.className = 'd';
    when.textContent = bar.dataset.when;
    dot.className = 'updot ' + bar.className;
    what.textContent = bar.dataset.what;
    tip.replaceChildren(when, dot, what);
    tip.hidden = false;
    var b = bar.getBoundingClientRect(), r = box.getBoundingClientRect();
    var left = b.left - r.left + b.width / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(8, Math.min(left, r.width - tip.offsetWidth - 8)) + 'px';
    tip.style.top = (b.top - r.top - tip.offsetHeight - 10) + 'px';
  }
  function armTip(bar) {
    if (bar === tipBar) return;
    root.clearTimeout(tipTimer);
    tipBar = bar;
    // Already showing one: move straight to the next bar; otherwise wait 0.2s.
    if (tip && !tip.hidden) showTip(bar);
    else tipTimer = root.setTimeout(function () { if (tipBar === bar) showTip(bar); }, 200);
  }
  function wireTips() {
    var bars = doc.getElementById('upbars');
    if (!bars || bars.dataset.tips) return;
    bars.dataset.tips = '1';
    bars.addEventListener('pointerover', function (e) {
      var bar = e.target.closest && e.target.closest('#upbars > span');
      if (bar) armTip(bar);
    });
    bars.addEventListener('pointerleave', hideTip);
    bars.addEventListener('pointerdown', function (e) {        // touch: tap a bar to see it
      var bar = e.target.closest && e.target.closest('#upbars > span');
      if (bar && e.pointerType !== 'mouse') { tipBar = bar; showTip(bar); }
    });
    root.addEventListener('scroll', hideTip, { passive: true });
  }

  function check() {
    root.fetch('/api/status', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(draw, function () { draw({ online: false, reachable: false }); });
  }

  if (doc && doc.getElementById('state')) {
    check();
    root.setInterval(check, 30000);
  }
})(window);
