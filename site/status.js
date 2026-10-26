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
    set('checked', 'Last checked ' + new Date().toLocaleTimeString() + '. This page checks again every 30 seconds.');
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
