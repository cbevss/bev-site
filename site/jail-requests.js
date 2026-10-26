/* Requests to be freed: opened from the Jail card on the dashboard, for one server (?guild=<id>).
 * Lists jailed members who sent a request, newest first. Picking one shows their message with Approve and Deny.
 * Everything comes from this site's own backend (/api/config and /api/action), which checks the person is an admin there.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var ID_RE = /^\d{15,25}$/;
  var REFRESH_MS = 30000;
  var ERRORS = {
    forbidden: 'You can only see requests in servers where you are an administrator and BEV has been added.',
    bot_not_in_server: "BEV isn't in that server any more.",
    bot_unreachable: "The bot didn't answer in time. It may be busy or restarting. Try again in a minute.",
    bot_starting: 'The bot is still starting up. Try again in a moment.',
    discord_unavailable: 'Discord could not be reached. Try again in a moment.',
    network: 'The BEV site could not be reached. Check your connection and try again.',
    maintenance: 'The site is being worked on right now. Try again soon.'
  };
  var state = { guild: null, pleas: [], picked: null, busy: false, options: [] };

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
  function when(seconds) {
    return new Date(seconds * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function ago(seconds) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
    if (s < 60) return 'just now';
    var units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][0]) { var n = Math.floor(s / units[i][0]); return n + ' ' + units[i][1] + (n === 1 ? '' : 's') + ' ago'; }
    }
    return 'just now';
  }
  function nameOf(p) { return p.display || 'Someone who left the server'; }

  function request(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options || {});
    return root.fetch(path, opts).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return {}; })
        .then(function (data) { return { status: res.status, data: data || {} }; });
    }, function () { return { status: 0, data: { error: 'network' } }; });
  }
  function errorText(r) {
    if (r.status === 401) return 'You were signed out. Sign in again to keep going.';
    var d = r.data || {};
    if (typeof d.message === 'string' && d.message && (d.error === 'refused' || r.status === 400)) return d.message;
    return ERRORS[d.error || ''] || "The bot had a problem. Try again, and if it keeps happening, check the bot's logs.";
  }

  function show(which) {
    ['jrbusy', 'jrerr', 'jrbox'].forEach(function (id) { $(id).hidden = id !== which; });
  }
  function fail(heading, text) {
    $('jrerrh').textContent = heading;
    $('jrerrmsg').textContent = text;
    show('jrerr');
  }

  /* ---------- the list ---------- */

  function drawList() {
    var list = $('jrlist');
    list.replaceChildren();
    var n = state.pleas.length;
    $('jrcount').textContent = n === 1 ? '1 request waiting' : n + ' requests waiting';
    if (!n) {
      list.append(el('li', 'jrempty', 'No requests right now. When someone in jail sends one, it shows up here.'));
      return;
    }
    state.pleas.forEach(function (p) {
      var li = el('li');
      var b = el('button', 'jritem' + (state.picked === p.id ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('data-id', p.id);
      if (state.picked === p.id) b.setAttribute('aria-current', 'true');
      b.append(avatar(p.avatar, nameOf(p), 'jrsmall'));
      var who = el('span', 'jrtx');
      who.append(el('b', null, nameOf(p)));
      if (p.name) who.append(el('span', 'jruser', '@' + p.name));
      who.append(el('span', 'jrwhen', ago(p.at)));
      b.append(who);
      b.addEventListener('click', function () { pick(p.id, true); });
      li.append(b);
      list.append(li);
    });
  }

  function pick(id, focus) {
    var p = state.pleas.find(function (x) { return x.id === id; });
    state.picked = p ? p.id : null;
    drawList();
    $('jrpick').hidden = !!p;
    $('jrcard').hidden = !p;
    $('jrbox').classList.toggle('reading', !!p);
    $('jrnote').hidden = true;
    if (!p) return;
    var av = $('jrav');
    av.replaceChildren(avatar(p.avatar, nameOf(p), 'jrbig'));
    $('jrname').textContent = nameOf(p);
    $('jruser').textContent = p.name ? '@' + p.name : '';
    var facts = $('jrfacts');
    facts.replaceChildren();
    $('jrwhytext').textContent = p.reason || 'No reason was given when they were jailed.';
    $('jrwhy').classList.toggle('none', !p.reason);
    facts.append(el('li', null, 'Asked ' + when(p.at) + ' (' + ago(p.at) + ')'));
    if (p.since) facts.append(el('li', null, 'In jail since ' + when(p.since)));
    facts.append(el('li', null, p.until ? 'Freed automatically ' + when(p.until) : 'Stays in jail until the staff free them'));
    if (!p.here) facts.append(el('li', 'warn', "They've left the server. Approving just takes them off the jail list."));
    $('jrmsg').textContent = p.text;
    var hist = Array.isArray(p.history) ? p.history : [];
    var hl = $('jrhistlist');
    hl.replaceChildren();
    hist.forEach(function (h) {
      var li = el('li');
      var word = h.status === 'approved' ? '✅ ' + (h.outcome || 'Freed') : h.status === 'denied' ? '❌ Denied' : '🕊️ Freed another way first';
      li.append(el('b', null, word + ' • asked ' + when(h.at)), el('span', 'jrhq', '“' + h.text + '”'));
      if (h.note) li.append(el('span', 'jrhn', 'Staff note: ' + h.note));
      hl.append(li);
    });
    $('jrhist').hidden = !hist.length;
    setButtons(false);
    if (focus) {
      $('jrdetail').focus({ preventScroll: true });
      if (root.matchMedia && root.matchMedia('(max-width: 760px)').matches) $('jrdetail').scrollIntoView({ block: 'start' });
    }
  }

  function setButtons(disabled) {
    $('jrapprove').disabled = disabled;
    $('jrdeny').disabled = disabled;
  }

  /* ---------- approve or deny ---------- */

  // Asks before approving or denying. opts.choices: how to free them; opts.reason: a box for why (shown to them).
  function ask(title, text, ok, opts) {
    opts = opts || {};
    var box = $('jrask');
    $('jraskh').textContent = title;
    $('jraskt').textContent = text;
    $('jraskyes').textContent = ok;
    var pick = $('jraskpick');
    pick.replaceChildren();
    (opts.choices || []).forEach(function (c) { var o = el('option', null, c.label); o.value = c.value; pick.append(o); });
    $('jraskpickw').hidden = !(opts.choices && opts.choices.length);
    $('jraskreasonw').hidden = !opts.reason;
    $('jraskreasonl').textContent = opts.reason || 'Why (optional)';
    $('jraskreason').value = '';
    return new Promise(function (resolve) {
      function answer(yes) { return yes ? { choice: pick.value || null, reason: $('jraskreason').value.trim() } : null; }
      if (typeof box.showModal !== 'function') { resolve(answer(root.confirm(title + '\n\n' + text))); return; }
      function done(yes) {
        $('jraskyes').onclick = null; $('jraskno').onclick = null; box.oncancel = null;
        var result = answer(yes);
        if (box.open) box.close();
        resolve(result);
      }
      $('jraskyes').onclick = function () { done(true); };
      $('jraskno').onclick = function () { done(false); };
      box.oncancel = function (e) { e.preventDefault(); done(false); };
      box.showModal();
      $('jraskno').focus();
    });
  }

  function decide(decision) {
    var p = state.pleas.find(function (x) { return x.id === state.picked; });
    if (!p || state.busy) return;
    var approve = decision === 'approve';
    ask(approve ? 'Free ' + nameOf(p) + '?' : 'Deny ' + nameOf(p) + "'s request?",
      approve ? 'They get their access back straight away, and BEV tells them by DM.'
        : "They stay in jail and BEV tells them in the jail channel. They can send a new request in 7 days.",
      approve ? '✅ Approve' : '❌ Deny',
      approve ? { choices: state.options, reason: 'A note for them (optional, sent with their DM)' }
        : { reason: 'Why (optional, they’ll see this in the jail channel)' }).then(function (got) {
      if (!got) return;
      if (approve && got.choice) decision = got.choice;
      state.busy = true;
      setButtons(true);
      var guild = state.guild;
      request('/api/action', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ guild_id: guild, owner: 'jail', action: 'plea', values: { plea: p.id, decision: decision, reason: got.reason || '' } })
      }).then(function (r) {
        state.busy = false;
        var ok = r.status === 200 && r.data && r.data.ok;
        if (!ok) {
          setButtons(false);
          var note = $('jrnote');
          note.hidden = false;
          note.className = 'fnote no';
          note.textContent = errorText(r);
          return;
        }
        if (Array.isArray(r.data.data)) state.pleas = r.data.data;
        pick(null);
        var done = $('jrpick');
        done.replaceChildren(el('p', 'jrdone', r.data.note || 'Done.'));
        say(r.data.note || 'Done.');
        drawList();
        var first = doc.querySelector('.jritem');
        if (first) first.focus();
      });
    });
  }

  /* ---------- loading ---------- */

  function load(quiet) {
    if (!quiet) show('jrbusy');
    var guild = state.guild;
    return Promise.all([request('/api/config?guild_id=' + encodeURIComponent(guild)), request('/api/servers')]).then(function (rs) {
      var r = rs[0], servers = rs[1];
      if (servers.status === 200 && Array.isArray(servers.data.servers)) {
        var s = servers.data.servers.find(function (x) { return String(x.id) === guild; });
        if (s) {
          $('jrguild').textContent = s.name;
          doc.title = 'BEV | Requests to be freed | ' + s.name;
          var icon = $('jrgicon');
          icon.replaceChildren(avatar(s.icon && /^(a_)?[0-9a-f]{32}$/.test(s.icon) ? 'https://cdn.discordapp.com/icons/' + guild + '/' + s.icon + '.png?size=64' : null, s.name, 'jrtiny'));
        }
      }
      if (r.status === 401) { root.location.assign('/auth/login'); return; }
      if (r.status !== 200) {
        if (!quiet) fail("Couldn't load the requests", errorText(r));
        return;
      }
      var jail = (r.data.features || []).find(function (f) { return f.key === 'jail'; });
      if (!jail || !jail.enabled) { fail('Jail is switched off', 'Switch Jail on in the dashboard to use requests to be freed.'); return; }
      if (jail.pleas_on === false) {
        fail('Asking to be freed is switched off', 'Switch on "Let people in jail ask to be freed" in Jail\'s settings on the dashboard.');
        return;
      }
      var before = state.picked;
      state.pleas = Array.isArray(jail.pleas) ? jail.pleas : [];
      state.options = Array.isArray(jail.plea_options) && jail.plea_options.length ? jail.plea_options : [{ value: 'approve', label: 'Freed' }];
      show('jrbox');
      if (before && state.pleas.some(function (p) { return p.id === before; })) { drawList(); }
      else { pick(null); drawList(); }
    });
  }

  function boot() {
    var guild = new URLSearchParams(root.location.search).get('guild') || '';
    if (!ID_RE.test(guild)) { fail('No server picked', 'Open this page from the Jail card on the dashboard.'); return; }
    state.guild = guild;
    $('jrback').href = '/dashboard?guild=' + guild + '#f-jail';
    $('jrapprove').addEventListener('click', function () { decide('approve'); });
    $('jrdeny').addEventListener('click', function () { decide('deny'); });
    $('jrbacklist').addEventListener('click', function () {
      var id = state.picked;
      pick(null);
      var b = id && doc.querySelector('.jritem[data-id="' + id + '"]');
      $('jrlist').scrollIntoView({ block: 'start' });
      if (b) b.focus();
    });
    $('jrreload').addEventListener('click', function () { load(true); });
    load(false);
    root.setInterval(function () { if (!doc.hidden && !state.busy && !$('jrask').open) load(true); }, REFRESH_MS);
  }

  boot();
})(window);
