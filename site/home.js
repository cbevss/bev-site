/* Home page: how many servers BEV is in right now, from the same live check as the Status page. */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || !root.fetch) return;
  var box = doc.getElementById('livecount');
  var text = doc.getElementById('livetext');
  if (!box || !text) return;
  root.fetch('/api/status', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.online || !(d.servers > 0)) return;
      text.textContent = 'Online in ' + Number(d.servers).toLocaleString('en-GB') + ' server' + (d.servers === 1 ? '' : 's');
      box.hidden = false;
    })
    .catch(function () { /* the count just doesn't show */ });
})(window);
