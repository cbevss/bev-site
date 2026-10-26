/*
 * BEV "My servers" page.
 *
 * Sign-in happens on the server (/auth/login -> Discord -> /auth/callback, see _worker.js).
 * This script only asks that backend who is signed in and which of their servers BEV is in.
 * No Discord token and no secret ever reaches the browser, so none belongs in this file.
 */
(function (root) {
  'use strict';

  var CLIENT_ID = '1562204643755429980';
  var BOT_INVITE = 'https://discord.com/oauth2/authorize?client_id=' + CLIENT_ID +
    '&permissions=8&integration_type=0&scope=bot+applications.commands';
  var ID_RE = /^\d{5,25}$/;
  var HASH_RE = /^[a-z0-9_]{5,64}$/i;

  var MESSAGES = {
    setup: 'Sign-in is not set up on this site yet. If you run this site, DISCORD_CLIENT_SECRET and SESSION_SECRET still need adding in Cloudflare.',
    secret_short: 'Sign-in is not set up yet: SESSION_SECRET in Cloudflare must be at least 32 characters long.',
    client: 'Discord refused this site\'s sign-in details. If you run this site, copy the Client Secret again from the Discord Developer Portal (OAuth2 page) into DISCORD_CLIENT_SECRET in Cloudflare, then redeploy.',
    grant: 'Discord turned down the sign-in. Try again. If it keeps happening and you run this site, check that https://bevbotdiscord.com/auth/callback is listed under OAuth2 > Redirects in the Discord Developer Portal.',
    state: 'The sign-in response did not match this browser, so it was ignored. Please try again.',
    cancelled: 'Sign-in was cancelled. Nothing was shared.',
    token: 'Discord did not accept the sign-in. Please try again.',
    discord: 'Discord could not be reached. Please try again in a moment.',
    network: 'The BEV site could not be reached. Check your connection and try again.'
  };

  /* ---------- pure helpers (also exported for tests) ---------- */

  // String concatenation on purpose: URLSearchParams would turn the + in the scope into %2B.
  function inviteFor(guildId) {
    return BOT_INVITE + '&guild_id=' + guildId + '&disable_guild_select=true';
  }

  function iconUrl(server) {
    if (!server.icon || !HASH_RE.test(server.icon) || !ID_RE.test(server.id)) return null;
    return 'https://cdn.discordapp.com/icons/' + server.id + '/' + server.icon + '.png?size=64';
  }

  function avatarUrl(user) {
    if (!user || !user.avatar || !HASH_RE.test(user.avatar) || !ID_RE.test(user.id)) return null;
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64';
  }

  function initials(name) {
    return Array.from(String(name).trim()).slice(0, 2).join('').toUpperCase() || '?';
  }

  // Servers where BEV already is, and the rest. A server whose status is unknown counts as "rest".
  function partition(servers, term) {
    var t = String(term || '').trim().toLowerCase();
    var out = { here: [], add: [] };
    servers.forEach(function (s) {
      if (t && String(s.name).toLowerCase().indexOf(t) === -1) return;
      (s.botPresent === true ? out.here : out.add).push(s);
    });
    return out;
  }

  /* ---------- page ---------- */

  var doc = root.document;
  function $(id) { return doc.getElementById(id); }
  var PANELS = ['busy', 'out', 'deny', 'err', 'in'];
  function show(name) { PANELS.forEach(function (p) { $(p).hidden = p !== name; }); }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function setFlow(step, dashboardOpen) {
    ['f1', 'f2', 'f3'].forEach(function (id, i) {
      var li = $(id);
      li.className = '';
      if (i + 1 < step) li.className = 'done';
      else if (i + 1 === step) li.className = 'now';
      else if (i === 2 && dashboardOpen) li.className = 'done';
    });
  }

  // back = the problem is not about signing in, so offer a way back instead of a new sign-in
  function fail(message, heading, back) {
    $('errh').textContent = heading || 'Sign-in did not finish';
    $('errmsg').textContent = message;
    var retry = $('errretry');
    retry.textContent = back ? 'Back to my servers' : 'Try again';
    retry.href = back ? '/servers.html' : '/auth/login';
    if (!back) setFlow(1);
    show('err');
  }

  function avatarNode(url, label, cls) {
    var node;
    function fallback() {
      var f = el('span', cls, initials(label));
      f.setAttribute('aria-hidden', 'true');
      return f;
    }
    if (!url) return fallback();
    node = el('img', cls);
    node.src = url; node.alt = ''; node.width = 48; node.height = 48;
    node.loading = 'lazy'; node.referrerPolicy = 'no-referrer';
    node.addEventListener('error', function () { node.replaceWith(fallback()); });
    return node;
  }

  function stat(text, here) {
    return el('span', 'stat' + (here ? ' here' : ''), text);
  }

  function card(s) {
    var row = el('div', 'srv');
    var nm = el('div', 'nm');
    var name = el('b', '', s.name);
    name.title = s.name;
    nm.append(name, el('span', '', s.owner ? 'Owner' : 'Administrator'));

    var acts = el('div', 'acts');
    if (s.botPresent === true) {
      acts.append(stat('BEV is here', true));
      if (s.dashboard) {
        var dash = el('a', 'mini', 'Dashboard');
        dash.href = '/dashboard?guild=' + s.id;
        dash.setAttribute('aria-label', 'Open the dashboard for ' + s.name);
        acts.append(dash);
      }
    } else {
      var add = el('a', 'mini', 'Add BEV');
      add.href = inviteFor(s.id);
      add.target = '_blank'; add.rel = 'noopener noreferrer';
      add.setAttribute('aria-label', 'Add BEV to ' + s.name);
      acts.append(add);
    }
    row.append(avatarNode(iconUrl(s), s.name, 'av'), nm, acts);
    return row;
  }

  function drawLists(servers) {
    var term = $('filter').value;
    var parts = partition(servers, term);
    [['here', parts.here], ['add', parts.add]].forEach(function (g) {
      var list = $('list-' + g[0]);
      list.replaceChildren();
      g[1].forEach(function (s) { list.append(card(s)); });
      $('g-' + g[0]).hidden = g[1].length === 0;
      $('c-' + g[0]).textContent = g[1].length ? '(' + g[1].length + ')' : '';
    });
  }

  function drawDashboard(data) {
    var open = data.canDashboard === true;
    $('dashgo').hidden = !open;
    var s = $('dashstat');
    s.className = 'stat' + (open ? ' here' : '');
    s.textContent = open ? 'Unlocked' : 'Locked';
    $('dashmsg').textContent = open
      ? 'Change every BEV setting for the servers below that have BEV: pick a server at the top of the dashboard, make your changes and press Save. Changes only affect that server.'
      : 'Add BEV to a server you administer, then come back here to manage it from the dashboard.';
  }

  function render(data) {
    var servers = Array.isArray(data.servers) ? data.servers : [];
    var user = data.user || {};
    $('who').textContent = user.name || 'your account';
    var av = avatarNode(avatarUrl(user), user.name || '?', 'av sm');
    $('meav').replaceChildren(av);

    doc.dispatchEvent(new root.CustomEvent('bev:signedin', { detail: { user: user } }));
    if (!servers.length) {
      $('denymsg').textContent = 'None of your servers give you the Administrator permission, so there is nothing to show here. Ask a server administrator to add BEV, or sign in with a different Discord account.';
      $('denyback').hidden = true;
      setFlow(2);
      return show('deny');
    }

    drawDashboard(data);
    $('botnote').hidden = data.botKnown !== false;
    var filter = $('filter');
    filter.hidden = servers.length < 8;
    filter.value = '';
    filter.oninput = function () { drawLists(servers); };
    drawLists(servers);
    setFlow(2, data.canDashboard === true);
    show('in');
  }

  function request(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options);
    return root.fetch(path, opts).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return {}; })
        .then(function (data) { return { status: res.status, data: data }; });
    }, function () { return { status: 0, data: {} }; });
  }

  // Both this page's Sign out buttons and the one in the top bar (nav.js) end up here.
  function signedOut() {
    ['list-here', 'list-add'].forEach(function (id) { $(id).replaceChildren(); });
    setFlow(1);
    show('out');
  }

  function logout() {
    request('/auth/logout', { method: 'POST' }).then(function (r) {
      if (r.status === 200) doc.dispatchEvent(new root.Event('bev:signedout'));
      else fail('Sign-out did not go through, so you are still signed in. Please try again.', 'Could not sign out', true);
    });
  }

  function boot() {
    doc.querySelectorAll('[data-logout]').forEach(function (b) { b.addEventListener('click', logout); });
    doc.addEventListener('bev:signedout', signedOut);
    setFlow(1);
    show('busy');

    var q = new URLSearchParams(root.location.search);
    var notice = q.get('error');
    if (notice) root.history.replaceState(null, '', root.location.pathname);

    request('/api/servers').then(function (r) {
      if (r.status === 200) {
        render(r.data);
        if (notice === 'denied') {
          $('denymsg').textContent = 'You can only open the dashboard for servers where you are an administrator. None of your servers give you that permission.';
          $('denyback').hidden = false;
          show('deny');
        }
        return;
      }
      if (notice && MESSAGES[notice]) return fail(MESSAGES[notice]);
      if (r.status === 401) { setFlow(1); return show('out'); }
      if (r.status === 503) return fail(MESSAGES.setup);
      fail(r.status === 0 ? MESSAGES.network : MESSAGES.discord);
    });
  }

  var exported = { inviteFor: inviteFor, iconUrl: iconUrl, avatarUrl: avatarUrl, initials: initials, partition: partition, BOT_INVITE: BOT_INVITE, MESSAGES: MESSAGES };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (doc) boot();
})(typeof window !== 'undefined' ? window : globalThis);
