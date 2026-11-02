/* Appeal a ban: someone banned from a server with Ban Appeals on asks its staff to unban them (through /api/appeal).
 * Who is appealing always comes from their sign-in; the page only says which server. */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || !doc.getElementById('apform')) return;
  function $(id) { return doc.getElementById(id); }
  var guild = (new URLSearchParams(root.location.search).get('guild') || '').trim();
  var signedIn = /(?:^|;\s*)bev_in=1(?:;|$)/.test(doc.cookie);
  var min = 20, max = 2000;

  function show(id) { ['apin', 'apmsg', 'apform'].forEach(function (x) { $(x).hidden = x !== id; }); }
  function message(title, text) { $('apmsgh').textContent = title; $('apmsgp').textContent = text; show('apmsg'); }
  function day(t) { return new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function call(method, body) {
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var url = '/api/appeal' + (method === 'GET' ? '?guild_id=' + encodeURIComponent(guild) : '');
    return root.fetch(url, opts).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d || {} }; }, function () { return { status: r.status, data: {} }; });
    }, function () { return { status: 0, data: {} }; });
  }

  if (!/^\d{5,25}$/.test(guild)) {
    message('Which server?', 'Open the appeal link the server or BEV gave you. It ends with ?guild= and the server’s ID.');
    return;
  }
  $('apsignin').href = '/auth/login?next=' + encodeURIComponent('/appeal?guild=' + guild);
  if (!signedIn) { show('apin'); return; }

  function draw(d) {
    if (d.guild && d.guild.name) {
      $('aph').textContent = 'Appeal your ban from ' + d.guild.name;
      $('apname').textContent = d.guild.name;
      if (d.guild.icon && /^https:\/\/cdn\.discordapp\.com\//.test(d.guild.icon)) { $('apicon').src = d.guild.icon; $('apicon').hidden = false; }
    }
    min = Number(d.min) || min; max = Number(d.max) || max;
    $('aptext').maxLength = max;
    var a = d.appeal;
    if (!d.enabled) return message('Appeals are closed', 'This server doesn’t take ban appeals on BEV’s website.');
    if (a && a.status === 'pending') return message('Your appeal is waiting', 'Appeal #' + a.id + ' was sent on ' + day(a.created) + '. The staff haven’t answered yet. BEV will DM you when they do.');
    if (!d.banned) {
      if (a && a.status === 'approved') return message('You’ve been unbanned', 'Your appeal was accepted. You can rejoin the server with an invite link.' + (a.note ? ' Note from the staff: ' + a.note : ''));
      return message('You aren’t banned', 'You aren’t banned from this server, so there’s nothing to appeal.');
    }
    if (!d.can_appeal) {
      var why = a && a.status === 'denied' ? 'Your last appeal wasn’t accepted' + (a.note ? ' (note from the staff: ' + a.note + ')' : '') + '. ' : '';
      return message('You can’t appeal right now', why + (d.wait_until ? 'You can appeal again from ' + day(d.wait_until) + '.' : 'This server doesn’t take another appeal.'));
    }
    $('apintro').textContent = d.intro || '';
    $('apintro').hidden = !d.intro;
    show('apform');
    count();
  }
  function count() {
    var n = $('aptext').value.trim().length;
    $('apcount').textContent = $('aptext').value.length + ' / ' + max;
    $('apsend').disabled = n < min;
  }
  $('aptext').addEventListener('input', count);
  $('apsend').addEventListener('click', function () {
    var text = $('aptext').value.trim();
    if (text.length < min) return;
    $('apsend').disabled = true;
    var note = $('apnote');
    note.hidden = false; note.className = 'fnote'; note.textContent = 'Sending…';
    call('POST', { guild_id: guild, text: text }).then(function (r) {
      if (r.status === 401) { show('apin'); return; }
      if (r.status === 200 && r.data.ok) {
        message('Appeal sent', 'Appeal #' + r.data.id + ' is with the staff. BEV will DM you their answer, so keep your DMs open.');
        return;
      }
      $('apsend').disabled = false;
      note.className = 'fnote no';
      note.textContent = r.data.message || 'It couldn’t be sent right now. Try again in a minute.';
    });
  });

  message('Checking…', 'Looking up your ban.');
  call('GET').then(function (r) {
    if (r.status === 401) { show('apin'); return; }
    if (r.status === 200) return draw(r.data);
    message('Something went wrong', r.data.message || 'BEV couldn’t check right now. Try again in a minute.');
  });
})(window);
