/* Suggest an idea: signed-in visitors send a suggestion for BEV to the BEV team (through /api/suggest). */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || !doc.getElementById('sgform')) return;
  function $(id) { return doc.getElementById(id); }
  var signedIn = /(?:^|;\s*)bev_in=1(?:;|$)/.test(doc.cookie);
  $('sgform').hidden = !signedIn;
  $('sgin').hidden = signedIn;
  var box = $('sgtext'), send = $('sgsend'), note = $('sgnote');
  function count() {
    var n = box.value.trim().length;
    $('sgcount').textContent = box.value.length + ' / 1500';
    send.disabled = n < 5;
  }
  box.addEventListener('input', count);
  send.addEventListener('click', function () {
    var text = box.value.trim();
    if (text.length < 5) return;
    send.disabled = true;
    note.hidden = false;
    note.className = 'fnote';
    note.textContent = 'Sending…';
    root.fetch('/api/suggest', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' },
                                 body: JSON.stringify({ text: text }) })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d || {} }; }, function () { return { status: r.status, data: {} }; }); },
            function () { return { status: 0, data: {} }; })
      .then(function (r) {
        if (r.status === 401) { $('sgform').hidden = true; $('sgin').hidden = false; return; }
        if (r.status === 200 && r.data.ok) {
          box.value = '';
          count();
          note.className = 'fnote ok';
          note.textContent = '💡 Thanks! Suggestion #' + r.data.id + ' was sent to the BEV team. BEV will DM you when they answer, so keep your DMs open.';
          return;
        }
        send.disabled = false;
        note.className = 'fnote no';
        note.textContent = r.data.message || "It couldn't be sent right now. Try again in a minute.";
      });
  });
  count();
})(window);
