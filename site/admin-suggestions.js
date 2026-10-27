/* Suggestions (admin panel): ideas for BEV sent with /suggest or on the website's Suggest page.
 * Lists them newest first (waiting ones by default). Picking one shows it with Approve and Deny. BEV can DM the person:
 * a box saying it was approved or denied, a message from the team, or both together in one box.
 * Everything comes from this site's own backend (/api/admin/suggestions), which only answers site admins.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var REFRESH_MS = 30000;
  var ERRORS = {
    forbidden: 'Only site admins can see suggestions.',
    signed_out: 'You were signed out. Sign in again to keep going.',
    bot_unreachable: "The bot didn't answer in time. It may be busy or restarting. Try again in a minute.",
    bot_outdated: 'The bot needs updating before suggestions work. Upload the newest bev_bot.py, then try again.',
    bot_not_configured: "The website isn't connected to the bot yet.",
    network: 'The BEV site could not be reached. Check your connection and try again.'
  };
  var state = { items: [], filter: 'pending', picked: null, busy: false };

  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function say(text) { $('jrlive').textContent = text; }
  function initials(name) { return Array.from(String(name || '').trim()).slice(0, 2).join('').toUpperCase() || '?'; }
  function avatar(url, label, cls) {
    function fallback() { var f = el('span', cls + ' letter', initials(label)); f.setAttribute('aria-hidden', 'true'); return f; }
    if (!url || !/^https:\/\/cdn\.discordapp\.com\//.test(url)) return fallback();
    var img = el('img', cls);
    img.src = url; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () { img.replaceWith(fallback()); });
    return img;
  }
  function when(seconds) { return new Date(seconds * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  function ago(seconds) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
    if (s < 60) return 'just now';
    var units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][0]) { var n = Math.floor(s / units[i][0]); return n + ' ' + units[i][1] + (n === 1 ? '' : 's') + ' ago'; }
    }
    return 'just now';
  }
  function nameOf(p) { return p.display || p.username || 'Someone'; }

  function request(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options || {});
    return root.fetch(path, opts).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return {}; })
        .then(function (data) { return { status: res.status, data: data || {} }; });
    }, function () { return { status: 0, data: { error: 'network' } }; });
  }
  function errorText(r) {
    if (r.status === 401) return ERRORS.signed_out;
    var d = r.data || {};
    if (typeof d.message === 'string' && d.message) return d.message;
    return ERRORS[d.error || ''] || "The bot had a problem. Try again, and if it keeps happening, check the bot's logs.";
  }
  function show(which) { ['jrbusy', 'jrerr', 'jrbox'].forEach(function (id) { $(id).hidden = id !== which; }); }
  function fail(heading, text) { $('jrerrh').textContent = heading; $('jrerrmsg').textContent = text; show('jrerr'); }

  function shown() {
    return state.items.filter(function (s) { return state.filter === 'all' || s.status === state.filter; });
  }

  /* ---------- the list ---------- */
  function drawList() {
    var list = $('jrlist');
    list.replaceChildren();
    var items = shown();
    var waiting = state.items.filter(function (s) { return s.status === 'pending'; }).length;
    $('jrcount').textContent = state.filter === 'pending' ? (waiting === 1 ? '1 suggestion waiting' : waiting + ' suggestions waiting')
      : items.length + ' ' + (state.filter === 'all' ? 'suggestion' : state.filter) + (items.length === 1 ? '' : (state.filter === 'all' ? 's' : ''));
    if (!items.length) {
      list.append(el('li', 'jrempty', state.filter === 'pending' ? 'No suggestions waiting. New ones from /suggest and the website show up here.' : 'Nothing here yet.'));
      return;
    }
    items.forEach(function (p) {
      var li = el('li');
      var b = el('button', 'jritem' + (state.picked === p.id ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('data-id', p.id);
      if (state.picked === p.id) b.setAttribute('aria-current', 'true');
      b.append(avatar(p.avatar, nameOf(p), 'jrsmall'));
      var who = el('span', 'jrtx');
      who.append(el('b', null, nameOf(p)));
      if (p.username) who.append(el('span', 'jruser', '@' + p.username));
      who.append(el('span', 'jrwhen', ago(p.created) + (p.status !== 'pending' ? (p.status === 'approved' ? ' • ✅ approved' : ' • ❌ denied') : '')));
      b.append(who);
      b.addEventListener('click', function () { pick(p.id, true); });
      li.append(b);
      list.append(li);
    });
  }

  function hint() {
    var tell = $('sgtell').checked, note = $('sgnote').value.trim();
    $('sghint').textContent = tell && note ? 'BEV sends one DM box saying whether it was approved or denied, with your message in it.'
      : tell ? 'BEV DMs them to say whether it was approved or denied.'
      : note ? 'BEV DMs them your message.'
      : 'Nothing is sent to them. It is just marked here.';
  }

  function pick(id, focus) {
    var p = state.items.find(function (x) { return x.id === id; });
    state.picked = p ? p.id : null;
    drawList();
    $('jrpick').hidden = !!p;
    $('jrcard').hidden = !p;
    $('jrbox').classList.toggle('reading', !!p);
    $('jrnote').hidden = true;
    if (!p) return;
    $('jrav').replaceChildren(avatar(p.avatar, nameOf(p), 'jrbig'));
    $('jrname').textContent = nameOf(p);
    $('jruser').textContent = p.username ? '@' + p.username : '';
    var facts = $('jrfacts');
    facts.replaceChildren();
    facts.append(el('li', null, 'Sent ' + when(p.created) + ' (' + ago(p.created) + ')'));
    facts.append(el('li', null, p.source === 'website' ? 'From the website' : 'With /suggest' + (p.guild ? ' in ' + p.guild : '')));
    facts.append(el('li', null, 'Suggestion #' + p.id));
    $('jrmsg').textContent = p.text;
    var done = $('sgdone');
    var answered = p.status !== 'pending';
    done.hidden = !answered;
    done.replaceChildren();
    if (answered) {
      done.className = 'sgdone ' + p.status;
      done.append(el('b', null, (p.status === 'approved' ? '✅ Approved' : '❌ Denied') + (p.decided_at ? ' ' + when(p.decided_at) : '') + (p.decided_by ? ' by ' + p.decided_by.replace(/\s*\(\d+\)$/, '') : '')));
      done.append(el('p', null, p.told ? 'They were sent a DM.' : 'No DM was sent.'));
      if (p.note) done.append(el('p', 'sgnoteold', '💬 ' + p.note));
    }
    $('sganswer').hidden = answered;
    $('sgnote').value = '';
    $('sgtell').checked = true;
    hint();
    if (focus) $('jrdetail').focus({ preventScroll: true });
  }

  function answer(decision) {
    var p = state.items.find(function (x) { return x.id === state.picked; });
    if (!p || state.busy) return;
    state.busy = true;
    ['jrapprove', 'jrdeny'].forEach(function (id) { $(id).disabled = true; });
    var note = $('jrnote');
    note.hidden = false;
    note.className = 'fnote';
    note.textContent = 'Working on it…';
    request('/api/admin/suggestions/answer', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, decision: decision, note: $('sgnote').value.trim(), tell: $('sgtell').checked })
    }).then(function (r) {
      state.busy = false;
      ['jrapprove', 'jrdeny'].forEach(function (id) { $(id).disabled = false; });
      if (r.status !== 200 || !r.data || !r.data.suggestion) {
        note.className = 'fnote no';
        note.textContent = errorText(r);
        return;
      }
      var i = state.items.findIndex(function (x) { return x.id === p.id; });
      if (i >= 0) state.items[i] = r.data.suggestion;
      var text = (decision === 'approved' ? '✅ Approved.' : '❌ Denied.') + (r.data.dm === true ? ' BEV sent them a DM.' : r.data.dm === false ? " BEV couldn't DM them (their DMs may be closed)." : '');
      pick(p.id, false);
      note.hidden = false;
      note.className = 'fnote ' + (r.data.dm === false ? 'no' : 'ok');
      note.textContent = text;
      say(text);
    });
  }

  function load(quiet) {
    if (!quiet) show('jrbusy');
    return request('/api/admin/suggestions').then(function (r) {
      if (r.status === 401) { root.location.assign('/auth/login'); return; }
      if (r.status !== 200 || !Array.isArray(r.data.suggestions)) {
        if (!quiet) fail("Couldn't load the suggestions", errorText(r));
        return;
      }
      state.items = r.data.suggestions;
      show('jrbox');
      drawList();
      if (state.picked && !state.items.some(function (x) { return x.id === state.picked; })) pick(null);
    });
  }

  function boot() {
    doc.querySelectorAll('.sgfilter button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-f');
        doc.querySelectorAll('.sgfilter button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        drawList();
      });
    });
    $('jrreload').addEventListener('click', function () { load(false); });
    $('jrbacklist').addEventListener('click', function () { pick(null); });
    $('jrapprove').addEventListener('click', function () { answer('approved'); });
    $('jrdeny').addEventListener('click', function () { answer('denied'); });
    $('sgtell').addEventListener('change', hint);
    $('sgnote').addEventListener('input', hint);
    load(false);
    root.setInterval(function () { if (!state.busy && !doc.hidden) load(true); }, REFRESH_MS);
  }
  if (doc && $('jrlist')) boot();
})(window);
