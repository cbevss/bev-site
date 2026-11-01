/* Support chats (admin panel): website support tickets where someone asked BEV for a real person.
 * Waiting chats come first. Accept one to talk to them (they then see Support Agent instead of BEV), add private notes,
 * and close it when it's done. Everything comes from /api/admin/support, which only answers site admins.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var REFRESH_MS = 6000;
  var ERRORS = {
    forbidden: 'Only site admins can see support chats.',
    signed_out: 'You were signed out. Sign in again to keep going.',
    bot_unreachable: "The bot didn't answer in time. It may be busy or restarting. Try again in a minute.",
    bot_outdated: 'The bot needs updating before support chats work. Upload the newest bev_bot.py, then try again.',
    bot_not_configured: "The website isn't connected to the bot yet.",
    network: 'The BEV site could not be reached. Check your connection and try again.'
  };
  var state = { items: [], filter: 'open', picked: null, busy: false, me: '' };

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

  var TAG = { waiting: ['Waiting', ''], agent: ['Accepted', 'agent'], closed: ['Closed', 'closed'] };
  function shown() {
    return state.items.filter(function (t) {
      return state.filter === 'all' || (state.filter === 'open' ? t.status !== 'closed' : t.status === state.filter);
    });
  }
  function current() { return state.items.find(function (x) { return x.id === state.picked; }); }

  function drawList() {
    var list = $('jrlist');
    list.replaceChildren();
    var items = shown();
    var waiting = state.items.filter(function (t) { return t.status === 'waiting'; }).length;
    $('jrcount').textContent = waiting === 1 ? '1 chat waiting for someone' : waiting + ' chats waiting for someone';
    if (!items.length) { list.append(el('li', 'jrempty', 'Nothing here. Chats show up when someone asks BEV for a real person.')); return; }
    items.forEach(function (t) {
      var li = el('li');
      var b = el('button', 'jritem' + (state.picked === t.id ? ' on' : ''));
      b.type = 'button';
      if (state.picked === t.id) b.setAttribute('aria-current', 'true');
      b.append(avatar(t.avatar, nameOf(t), 'jrsmall'));
      var who = el('span', 'jrtx');
      var name = el('b', null, nameOf(t));
      var tag = TAG[t.status];
      if (tag) name.append(el('span', 'sptag ' + tag[1], t.status === 'agent' && t.agent ? tag[0] + ' by ' + t.agent : tag[0]));
      who.append(name, el('span', 'jruser', (t.topic_label || 'Ticket') + ' • #' + t.id), el('span', 'jrwhen', 'Last message ' + ago(t.updated)));
      b.append(who);
      b.addEventListener('click', function () { pick(t.id, true); });
      li.append(b);
      list.append(li);
    });
  }

  function drawLog(t) {
    var log = $('splog');
    var atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren();
    t.messages.forEach(function (m) {
      if (m.who === 'system') { log.append(el('p', 'bcsys', m.text)); return; }
      var row = el('div', 'bcmsg ' + (m.who === 'user' ? 'them' : m.who === 'note' ? 'note' : 'me'));
      row.append(el('span', 'bcname', m.who === 'user' ? nameOf(t) : m.who === 'bev' ? 'BEV (AI)' : m.who === 'note' ? '📝 Private note by ' + (m.agent || 'an admin') : 'Support Agent (' + (m.agent || 'an admin') + ')'));
      row.append(el('div', 'bcbub', m.text), el('span', 'bctime', when(m.at)));
      log.append(row);
    });
    if (atEnd || state.jump) { log.scrollTop = log.scrollHeight; state.jump = false; }
  }

  function drawActions(t) {
    var bar = $('spbar');
    bar.replaceChildren();
    var mine = t.status === 'agent' && t.agent_is_me;
    if (t.status === 'waiting') bar.append(button('✅ Accept this chat', 'jrok', function () { act('accept'); }));
    if (t.status === 'agent' && !mine) bar.append(el('p', 'fhelp', (t.agent || 'Another admin') + ' is handling this chat. You can still add private notes.'));
    if (t.status !== 'closed') bar.append(button('Close the ticket', 'jrno', function () { act('close'); }));
    else bar.append(el('p', 'fhelp', 'Closed' + (t.closed_by ? ' by ' + (t.closed_by === 'them' ? nameOf(t) : t.closed_by) : '') + '.'));
    $('spreply').hidden = t.status === 'closed';
    $('spsend').disabled = !mine;
    $('sptext').placeholder = mine ? 'Hi, I’m here to help…' : t.status === 'waiting' ? 'Accept the chat to reply (you can write a private note now)' : 'Only private notes';
  }
  function button(text, cls, fn) { var b = el('button', cls, text); b.type = 'button'; b.disabled = state.busy; b.addEventListener('click', fn); return b; }

  function pick(id, focus) {
    var t = state.items.find(function (x) { return x.id === id; });
    var changed = state.picked !== (t ? t.id : null);
    state.picked = t ? t.id : null;
    drawList();
    $('jrpick').hidden = !!t;
    $('jrcard').hidden = !t;
    $('jrbox').classList.toggle('reading', !!t);
    if (!t) return;
    if (changed) { $('jrnote').hidden = true; $('sptext').value = ''; state.jump = true; }
    $('jrav').replaceChildren(avatar(t.avatar, nameOf(t), 'jrbig'));
    $('jrname').textContent = nameOf(t);
    $('jruser').textContent = t.username ? '@' + t.username : '';
    var facts = $('jrfacts');
    facts.replaceChildren();
    facts.append(el('li', null, (t.topic_label || 'Ticket') + ' • #' + t.id));
    facts.append(el('li', null, 'Opened ' + when(t.created)));
    if (t.escalated) facts.append(el('li', null, 'Asked for a person ' + ago(t.escalated)));
    if (t.user_id) facts.append(el('li', null, 'Discord ID ' + t.user_id));
    drawLog(t);
    drawActions(t);
    if (focus) $('jrdetail').focus({ preventScroll: true });
  }

  function act(action) {
    var t = current();
    if (!t || state.busy) return;
    var text = $('sptext').value.trim();
    if ((action === 'reply' || action === 'note') && !text) { $('sptext').focus(); return; }
    state.busy = true;
    drawActions(t);
    var note = $('jrnote');
    request('/api/admin/support/act', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ id: t.id, action: action, text: text })
    }).then(function (r) {
      state.busy = false;
      if (r.status !== 200 || !r.data || !r.data.ticket) {
        note.hidden = false; note.className = 'fnote no'; note.textContent = errorText(r);
        drawActions(t);
        return;
      }
      var i = state.items.findIndex(function (x) { return x.id === t.id; });
      if (i >= 0) state.items[i] = r.data.ticket;
      if (action === 'reply' || action === 'note') $('sptext').value = '';
      state.jump = true;
      note.hidden = true;
      var said = { accept: 'Accepted. They now see Support Agent.', reply: 'Sent.', note: 'Note saved.', close: 'Ticket closed.' }[action];
      say(said);
      pick(t.id, false);
    });
  }

  function load(quiet) {
    if (!quiet) show('jrbusy');
    return request('/api/admin/support').then(function (r) {
      if (r.status === 401) { root.location.assign('/auth/login'); return; }
      if (r.status !== 200 || !Array.isArray(r.data.tickets)) { if (!quiet) fail("Couldn't load the support chats", errorText(r)); return; }
      var typing = $('sptext').value;
      state.items = r.data.tickets;
      show('jrbox');
      if (state.picked && state.items.some(function (x) { return x.id === state.picked; })) { pick(state.picked, false); $('sptext').value = typing; }
      else { drawList(); if (state.picked) pick(null); }
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
    $('spsend').addEventListener('click', function () { act('reply'); });
    $('spnote').addEventListener('click', function () { act('note'); });
    $('sptext').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) act($('spsend').disabled ? 'note' : 'reply'); });
    load(false);
    root.setInterval(function () { if (!state.busy && !doc.hidden) load(true); }, REFRESH_MS);
  }
  if (doc && $('jrlist')) boot();
})(window);
