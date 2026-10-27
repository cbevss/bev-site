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
      if (typeof v !== 'number') { b.className = 'none'; b.title = label + ': no record'; }
      else {
        b.className = v >= 0.99 ? 'ok' : v > 0 ? 'part' : 'off';
        b.title = label + ': ' + (v >= 0.99 ? 'online' : v > 0 ? 'online ' + Math.round(v * 100) + '% of the hour' : 'offline');
      }
      bars.appendChild(b);
    });
    var pct = known.reduce(function (a, b) { return a + b; }, 0) / known.length * 100;
    var text = (pct >= 99.95 ? '100' : pct.toFixed(pct >= 99 ? 2 : 1)) + '% online';
    set('uppct', text);
    bars.setAttribute('aria-label', 'BEV was ' + text + ' over the last ' + (known.length >= 168 ? '7 days' : Math.round(known.length / 24 * 10) / 10 + ' days') + '.');
    box.hidden = false;
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
