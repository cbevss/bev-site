/*
 * BEV dashboard.
 *
 * Everything on this page comes from the bot, through this site's own backend (_worker.js): the list of
 * features, their settings, and the picked server's channels and roles. Nothing changes until you press
 * Save changes, and then only for the server picked at the top. No token or secret reaches the browser.
 */
(function (root) {
  'use strict';

  var CLIENT_ID = '1562204643755429980';
  var BOT_INVITE = 'https://discord.com/oauth2/authorize?client_id=' + CLIENT_ID + '&permissions=8&integration_type=0&scope=bot+applications.commands';
  var ID_RE = /^\d{5,25}$/;
  var HASH_RE = /^[a-z0-9_]{5,64}$/i;

  var ERRORS = {
    forbidden: 'You can only change servers where you are an administrator and BEV has been added.',
    no_access: 'You don’t have access to that part of this server’s dashboard. Ask one of the server’s admins if you need it.',
    bot_not_in_server: 'BEV isn\'t in that server any more. Add it again, then reload.',
    bot_not_configured: 'The website isn\'t connected to the bot yet. If you run this site, add BOT_API_BASE and BOT_API_KEY in Cloudflare.',
    bot_unreachable: 'The bot didn\'t answer in time. It may be busy or restarting (for example after an update). Try again in a minute.',
    bot_starting: 'The bot is still starting up. Try again in a moment.',
    bot_rejected_key: 'The bot refused the website\'s key. If you run this site, BOT_API_KEY in Cloudflare must be exactly the same as BOT_API_KEY in the bot\'s settings.',
    bot_error: 'The bot had a problem. Try again, and if it keeps happening, check the bot\'s logs.',
    discord_unavailable: 'Discord could not be reached. Try again in a moment.',
    not_configured: 'Sign-in is not set up on this site yet.',
    too_large: 'That is too many changes at once. Save some of them first, then the rest.',
    bad_request: 'The bot couldn\'t read that. Reload the page and try again.',
    bot_outdated: 'The bot needs updating before this works. Upload the newest bev_bot.py, then try again.',
    refused: 'The bot couldn\'t do that. Check the values and try again.',
    network: 'The BEV site could not be reached. Check your connection and try again.'
  };

  /* ---------- pure helpers (exported for tests) ---------- */

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function inviteFor(guildId) { return BOT_INVITE + '&guild_id=' + guildId + '&disable_guild_select=true'; }

  function iconUrl(server) {
    if (!server || !server.icon || !HASH_RE.test(server.icon) || !ID_RE.test(String(server.id))) return null;
    return 'https://cdn.discordapp.com/icons/' + server.id + '/' + server.icon + '.png?size=64';
  }

  function avatarUrl(user) {
    if (!user || !user.avatar || !HASH_RE.test(user.avatar) || !ID_RE.test(String(user.id))) return null;
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64';
  }

  function initials(name) { return Array.from(String(name || '').trim()).slice(0, 2).join('').toUpperCase() || '?'; }

  // The values shown by the page, split from the rest of the bot's answer.
  function valuesOf(config) {
    var out = { features: {}, settings: {} };
    (config.features || []).forEach(function (f) {
      out.features[f.key] = f.enabled === true;
      (f.settings || []).forEach(function (s) { out.settings[s.key] = clone(s.value === undefined ? null : s.value); });
    });
    return out;
  }

  // Only what differs from the last saved state is sent.
  function changes(original, draft) {
    var out = { features: {}, settings: {}, count: 0 };
    Object.keys(draft.features).forEach(function (k) {
      if (draft.features[k] !== original.features[k]) { out.features[k] = draft.features[k]; out.count++; }
    });
    Object.keys(draft.settings).forEach(function (k) {
      if (!same(draft.settings[k], original.settings[k])) { out.settings[k] = draft.settings[k]; out.count++; }
    });
    return out;
  }

  function wordsFrom(text) {
    return String(text || '').split(/\r?\n/).map(function (w) { return w.trim(); }).filter(Boolean);
  }

  function newItem(setting) {
    var item = {};
    (setting.fields || []).forEach(function (f) { item[f.key] = clone(f.value === undefined ? null : f.value); });
    return item;
  }

  function channelLabel(c) {
    var mark = c.type === 'voice' ? '🔊 ' : c.type === 'category' ? '📁 ' : '#';
    return mark + c.name + (c.category && c.type !== 'category' ? '  (' + c.category + ')' : '');
  }

  function searchText(feature) {
    return [feature.name, feature.about, feature.command || '', (feature.member_commands || []).join(' ')]
      .concat((feature.settings || []).map(function (s) { return s.label + ' ' + (s.help || ''); })).join(' ').toLowerCase();
  }

  /* ---------- page ---------- */

  var doc = root.document;
  var state = { user: null, servers: [], guild: null, config: null, original: null, draft: null, saving: false, token: 0, dismissed: null, keep: {}, barWanted: false };
  var problems = {};

  function $(id) { return doc.getElementById(id); }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var PANELS = ['busy', 'err', 'addbev', 'board', 'builder'];
  var panel = 'busy';
  function show(name) {
    panel = name;
    PANELS.forEach(function (p) { $(p).hidden = p !== name; });
    showBar();
  }
  // The save bar only appears once something has been changed, and stays (showing the result) after saving until it's dismissed.
  function showBar() { $('savebar').hidden = !(panel === 'board' && state.barWanted && state.dismissed === null); }

  function say(text) { $('live').textContent = text; }

  function request(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options || {});
    return root.fetch(path, opts).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return {}; })
        .then(function (data) { return { status: res.status, data: data || {} }; });
    }, function () { return { status: 0, data: { error: 'network' } }; });
  }

  function errorText(r) {
    if (r.status === 401) return 'You were signed out. Sign in again to keep going.';
    if (r.data && r.data.error === 'refused' && typeof r.data.message === 'string' && r.data.message) return r.data.message;
    return ERRORS[(r.data && r.data.error) || ''] || ERRORS.bot_error;
  }

  function fail(r, heading) {
    $('errh').textContent = heading || 'Something went wrong';
    $('errmsg').textContent = errorText(r);
    var retry = $('retry');
    if (r.status === 401) {
      retry.textContent = 'Sign in again';
      retry.onclick = function () { root.location.assign('/auth/login'); };
    } else {
      retry.textContent = 'Try again';
      retry.onclick = function () { state.guild ? loadGuild(state.guild) : boot(); };
    }
    show('err');
  }

  function avatarNode(url, label, cls) {
    function fallback() { var f = el('span', cls, initials(label)); f.setAttribute('aria-hidden', 'true'); return f; }
    if (!url) return fallback();
    var node = el('img', cls);
    node.src = url; node.alt = ''; node.width = 36; node.height = 36;
    node.referrerPolicy = 'no-referrer';
    node.addEventListener('error', function () { node.replaceWith(fallback()); });
    return node;
  }

  /* ---------- the server list at the top ---------- */

  function fillServers() {
    var select = $('guild');
    select.replaceChildren();
    var here = state.servers.filter(function (s) { return s.dashboard; });
    var add = state.servers.filter(function (s) { return !s.dashboard; });
    [['BEV is in these servers', here], ['Add BEV to these first', add]].forEach(function (group) {
      if (!group[1].length) return;
      var og = el('optgroup');
      og.label = group[0];
      group[1].forEach(function (s) {
        var o = el('option', null, s.name + (s.dashboard ? (s.access === 'limited' ? '  (limited access)' : '') : '  (add BEV first)'));
        o.value = s.id;
        og.append(o);
      });
      select.append(og);
    });
    $('pick').hidden = false;
  }

  function serverById(id) { return state.servers.find(function (s) { return s.id === id; }) || null; }

  function pickServer(id) {
    var server = serverById(id);
    if (!server) return;
    $('guild').value = id;
    $('gicon').replaceChildren(avatarNode(iconUrl(server), server.name, 'av sm'));
    try { root.localStorage.setItem('bev_last_guild', id); } catch (e) { /* storage blocked: fine */ }
    var url = new URL(root.location.href);
    url.searchParams.set('guild', id);
    root.history.replaceState(null, '', url.pathname + url.search);
    if (!server.dashboard) {
      state.guild = null;
      state.config = null;
      $('addname').textContent = server.name;
      $('addlink').href = inviteFor(server.id);
      return show('addbev');
    }
    loadGuild(id);
  }

  function dirtyCount() {
    return state.original && state.draft ? changes(state.original, state.draft).count : 0;
  }

  function onServerChange() {
    var id = $('guild').value;
    if (state.guild && dirtyCount() && !root.confirm('You have unsaved changes for this server. Switch servers and lose them?')) {
      $('guild').value = state.guild;
      return;
    }
    pickServer(id);
  }

  /* ---------- loading one server's settings ---------- */

  function loadGuild(id) {
    var token = ++state.token;
    builder.picked = {};
    builder.changed = false;
    builder.wipe = false;
    if ($('bwipe')) $('bwipe').checked = false;
    $('bnote').hidden = true;
    designer.pick = 0;
    designer.note = null;
    state.guild = id;
    $('busyh').textContent = 'Loading ' + ((serverById(id) || {}).name || 'the server') + '’s settings';
    $('slow').hidden = true;
    show('busy');
    var slow = root.setTimeout(function () { $('slow').hidden = false; }, 6000);
    request('/api/config?guild_id=' + encodeURIComponent(id)).then(function (r) {
      root.clearTimeout(slow);
      if (token !== state.token) return;   // another server was picked meanwhile
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.features)) return fail(r, 'Couldn’t load the settings');
      useConfig(r.data);
      if (startBuilder && builderData()) { startBuilder = false; builder.open = false; openBuilder(true); root.history.replaceState(null, '', root.location.pathname + root.location.search + '#builder'); }
      else if (builder.open && builderData()) { drawBuilder(); show('builder'); }
      else { builder.open = false; show('board'); }
      say('Settings loaded for ' + r.data.guild.name);
    });
  }

  function useConfig(config) {
    state.config = config;
    var limited = config.access && config.access.limited;
    var note = $('accessnote');
    if (note) {
      note.hidden = !limited;
      if (limited) {
        var n = (config.features || []).length + (config.tools || []).length + (config.builder ? 1 : 0);
        note.textContent = '🔑 Limited access: an admin of this server gave you ' + (n === 1 ? '1 part' : n + ' parts') +
          ' of the dashboard. Only those are shown here, and you can only change them.';
      }
    }
    state.barWanted = false;
    state.original = valuesOf(config);
    state.draft = clone(state.original);
    state.keep = {};
    problems = {};
    renderBoard();
    updateDirty();
    drawBuilderEntry();
  }

  /* ---------- drawing the settings ---------- */

  // Cards that fill a whole row go after the others in their section, so the two-column grid has no gaps.
  var WIDE = { custom_messages: true, dashboard_access: true, 'tool:members': true, brackets: true, security_timeline: true };
  function isWide(f) { return !!WIDE[f.tool ? 'tool:' + f.key : f.key]; }

  function inOrder(feats) {
    return feats.filter(function (f) { return !isWide(f); }).concat(feats.filter(isWide));
  }

  function renderBoard() {
    var config = state.config;
    var cats = $('cats');
    var sections = $('sections');
    cats.replaceChildren();
    sections.replaceChildren();
    (config.categories || []).forEach(function (cat) {
      // Tool cards (no switch, no settings) come first in their section, then the features.
      var tools = (config.tools || []).filter(function (t) { return t && t.category === cat.key; }).map(function (t) { return Object.assign({ tool: true }, t); });
      var feats = inOrder(tools.concat(config.features.filter(function (f) { return f.category === cat.key; })));
      if (!feats.length) return;
      var pill = el('a', 'pill', cat.icon + ' ' + cat.name);
      pill.href = '#cat-' + cat.key;
      cats.append(pill);
      var sec = el('section', 'msec dsec');
      sec.id = 'cat-' + cat.key;
      var head = el('div', 'shead');
      head.append(el('span', 'ico emo', cat.icon));
      var h = el('h2', 'disp', cat.name);
      head.append(h);
      var acts = el('div', 'sacts');
      var count = el('span', 'stat');
      count.id = 'n-' + cat.key;
      acts.append(count, allButton(cat));
      head.append(acts);
      sec.append(head);
      var grid = el('div', 'feats');
      feats.forEach(function (f) { grid.append(f.tool ? toolCard(f) : featureCard(f)); });
      sec.append(grid);
      sections.append(sec);
    });
    applyFind();
    updateCounts();
    jumpToHash();
  }

  // A link like /dashboard?guild=…#f-tags (from a button in Discord) opens that card's settings and scrolls to it.
  // The address loses the #f-… part once a server is picked, so it's read when the page opens.
  var startHash = (root.location && root.location.hash) || '';
  var startBuilder = startHash === '#builder';
  var jumped = false;
  function jumpToHash() {
    var hash = startHash;
    if (jumped || !/^#[ft]-[a-z0-9_]{1,64}$/.test(hash)) return;
    var card = doc.getElementById(hash.slice(1));
    if (!card) return;
    jumped = true;
    var details = card.querySelector('details.fset');
    if (details) details.open = true;
    card.classList.add('flash');
    root.setTimeout(function () { card.classList.remove('flash'); }, 2600);
    root.setTimeout(function () { card.scrollIntoView({ block: 'start', behavior: 'instant' }); }, 0);
  }

  /* ---------- switching a whole section on or off ---------- */

  // Server Lockdown locks every channel, so it's only ever switched on its own, never by a section button.
  var NOT_IN_ALL = { lockdown: true };

  function sectionFeatures(catKey) {
    return state.config.features.filter(function (f) { return f.category === catKey && !NOT_IN_ALL[f.key]; });
  }

  function allButton(cat) {
    var b = el('button', 'mini allbtn');
    b.type = 'button';
    b.id = 'all-' + cat.key;
    var skipped = state.config.features.filter(function (f) { return f.category === cat.key && NOT_IN_ALL[f.key]; });
    function turnsOn() { return sectionFeatures(cat.key).some(function (f) { return !state.draft.features[f.key]; }); }
    function draw() {
      var on = turnsOn();
      b.textContent = on ? 'Turn all on' : 'Turn all off';
      b.setAttribute('aria-label', (on ? 'Turn on' : 'Turn off') + ' every feature in ' + cat.name);
      b.title = skipped.length ? skipped.map(function (f) { return f.name; }).join(', ') + ' is left as it is.' : '';
      b.hidden = !sectionFeatures(cat.key).length;
    }
    b.addEventListener('click', function () {
      var on = turnsOn();
      sectionFeatures(cat.key).forEach(function (f) { state.draft.features[f.key] = on; });
      doc.querySelectorAll('#cat-' + cat.key + ' .switch.fsw').forEach(function (s) { if (s.redraw) s.redraw(); });
      updateDirty();
      say('Every feature in ' + cat.name + (skipped.length ? ' except ' + skipped.map(function (f) { return f.name; }).join(', ') : '') +
          ' is now ' + (on ? 'on' : 'off') + '. Press Save changes to keep it.');
    });
    b.redraw = draw;
    draw();
    return b;
  }

  /* ---------- what switching a feature off deletes ---------- */

  var KIND_MARK = { category: '📁 ', voice: '🔊 ', channel: '#', role: '@' };

  function madeLabel(m) { return (KIND_MARK[m.kind] || '') + m.name; }

  // What saving would delete for a feature: it was on, it's switched off now, and BEV made things for it.
  function goingAway(f) {
    if (!state.original || !state.original.features[f.key] || state.draft.features[f.key]) return [];
    return (f.made || []).filter(function (m) { return m && !m.stays; });
  }

  function cleanupBox(f) {
    var made = (f.made || []).filter(Boolean);
    if (!made.some(function (m) { return !m.stays; })) return null;
    var box = el('div', 'gone');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'What switching ' + f.name + ' off does');
    var head = el('p', 'goneh');
    var list = el('ul', 'gonelist');
    made.forEach(function (m) {
      var li = el('li', m.stays ? 'stays' : null, madeLabel(m));
      if (m.stays) li.append(el('span', 'why', ' (stays: ' + m.stays + ')'));
      list.append(li);
    });
    box.append(head, list);
    if (f.made_note) box.append(el('p', 'gonenote', f.made_note));
    var label = el('label', 'chk keep');
    var tick = el('input');
    tick.type = 'checkbox';
    tick.addEventListener('change', function () {
      if (tick.checked) state.keep[f.key] = true; else delete state.keep[f.key];
      draw();
    });
    label.append(tick, doc.createTextNode('Keep them instead (only switch it off)'));
    var undo = el('p', 'gonenote', 'Deleting can’t be undone.');
    box.append(label, undo);
    function draw() {
      var kept = !!state.keep[f.key];
      box.hidden = !goingAway(f).length;
      box.classList.toggle('kept', kept);
      tick.checked = kept;
      head.textContent = kept ? '⛔ Saving switches it off and keeps what BEV made for it:' : '⚠️ Saving deletes the channels, categories and roles BEV made for it:';
      undo.hidden = kept;
    }
    box.redraw = draw;
    draw();
    return box;
  }

  // One line per feature whose things the next save deletes, for the "are you sure?" question.
  function deletions(diff) {
    var out = [];
    (state.config.features || []).forEach(function (f) {
      if (diff.features[f.key] !== false || state.keep[f.key]) return;
      var going = goingAway(f);
      if (going.length) out.push(f.icon + ' ' + f.name + ': ' + going.map(madeLabel).join(', '));
    });
    return out;
  }

  // Every card has the same three rows (top, text, settings), shared with the card beside it, so cards side by
  // side are the same height and their Settings lines sit level. Any spare space goes just above the Settings line.
  function featureCard(f) {
    var card = el('article', 'feat');
    card.id = 'f-' + f.key;
    if (f.key === 'dashboard_access') card.classList.add('wide');
    card.setAttribute('data-search', searchText(f));
    card.setAttribute('data-key', f.key);
    var head = el('div', 'fhead');
    head.append(el('span', 'ficon', f.icon));
    var title = el('div', 'ftitle');
    title.append(el('h3', null, f.name));
    if (f.command) title.append(el('span', 'key', '/' + f.command + ' in Discord'));
    head.append(title);
    var sw = switchButton(f.name, function () { return state.draft.features[f.key]; }, function (on) {
      state.draft.features[f.key] = on;
      updateDirty();
    });
    sw.classList.add('fsw');
    head.append(sw);
    card.append(head);
    var main = el('div', 'fmain');
    var gone = cleanupBox(f);
    if (gone) {
      main.append(gone);
      card.redrawGone = gone.redraw;
    }
    main.append(el('p', 'desc', f.about));
    card.append(main);
    var meta = el('div', 'fmeta');
    if (f.member_commands && f.member_commands.length) {
      meta.append(el('p', 'uses', 'Members use: ' + f.member_commands.map(function (c) { return '/' + c; }).join('  ')));
    }
    if (f.needs_setup && !f.setup_ok) {
      meta.append(el('p', 'miss', 'Needs setting up: pick its channel or role below, or switch it on and press Save so BEV can create one.'));
    }
    if (f.problem) meta.append(el('p', 'miss', '⚠️ ' + f.problem));
    if (f.info && f.info.length) meta.append(infoList(f.info));
    // Buttons that belong next to one setting (like Write it with AI under the listing description) go there instead.
    var NEAR = { listing: { ai_write: 'listing_description' } };
    var near = NEAR[f.key] || {};
    var cardButtons = (f.buttons || []).filter(function (b) { return !near[b.key]; });
    if (cardButtons.length) meta.append(actionRow(f.key, cardButtons));
    if (f.key === 'jail' && f.enabled && f.pleas_on) meta.append(pleaButton(f));
    if (f.previews && f.previews.length) meta.append(previewButton(f));
    if (meta.childNodes.length) main.append(meta);
    var templates = f.key === 'custom_messages' && (f.settings || []).find(function (s) { return s.key === 'message_templates'; });
    if (templates) {
      card.classList.add('wide');
      card.append(designerBox(f, templates));
      return card;
    }
    if (f.key === 'security_timeline' && state.config.security_timeline) {
      card.classList.add('wide');
      var tb = timelineBox(state.config.security_timeline);
      var tset = el('div', 'fields brksettings');
      (f.settings || []).forEach(function (s) { tset.append(fieldFor(s)); });
      tb.prepend(tset);
      card.append(tb);
      return card;
    }
    if (f.key === 'brackets' && Array.isArray(state.config.brackets)) {
      card.classList.add('wide');
      var bb = bracketBox(f);
      if (f.settings && f.settings.length) {
        var bset = el('div', 'fields brksettings');
        f.settings.forEach(function (s) { bset.append(fieldFor(s)); });
        bb.prepend(bset);
      }
      card.append(bb);
      return card;
    }
    if (f.settings && f.settings.length) {
      var box = el('details', 'fset');
      var sum = el('summary', null, 'Settings (' + f.settings.length + ')');
      box.append(sum);
      // Which cards had their settings open is remembered for this server, so they stay open after saving or reloading.
      if (openCards()[f.key]) box.open = true;
      box.addEventListener('toggle', function () {
        if (box.hasAttribute('data-findopen')) return;
        var open = openCards();
        if (box.open) open[f.key] = 1; else delete open[f.key];
        storeOpenCards(open);
      });
      var fields = el('div', 'fields');
      var making = (f.actions || []).find(function (a) { return a && a.key === 'level_roles'; });
      if (f.key === 'jail' && Array.isArray(f.jailed)) fields.append(jailList(f));
      f.settings.forEach(function (s) {
        if (making && s.key === 'level_rewards') fields.append(levelRolesBox(making));
        var field = fieldFor(s);
        fields.append(field);
        var here = (f.buttons || []).filter(function (b) { return near[b.key] === s.key; });
        if (here.length) {
          var row = actionRow(f.key, here);
          row.classList.add('fnear');
          field.append(row);
        }
      });
      box.append(fields);
      card.append(box);
    } else {
      card.append(el('p', 'fnone', 'No extra settings: just switch it on or off.'));
    }
    return card;
  }

  // Jail: requests to be freed open in their own window, with a count of the ones waiting.
  function pleaButton(f) {
    var n = Array.isArray(f.pleas) ? f.pleas.length : 0;
    var url = '/jail-requests?guild=' + encodeURIComponent(state.guild);
    var a = el('a', 'mini jreq', '📨 Requests to be freed');
    a.id = 'jreq';
    a.href = url;          // opens in this tab; its Back to the dashboard button comes back to the Jail card
    var badge = el('span', 'jrn' + (n ? '' : ' zero'), String(n));
    badge.setAttribute('aria-label', n === 1 ? '1 waiting' : n + ' waiting');
    a.append(badge);
    var row = el('div', 'row');
    row.append(a);
    return row;
  }

  // Jail: everyone in jail, each with a Free button.
  function jailList(f) {
    var box = el('div', 'jlist');
    box.id = 'jlist';
    var head = el('p', 'flabel');
    var list = el('ul', 'jitems');
    var note = el('p', 'fnote');
    note.setAttribute('role', 'status');
    note.hidden = true;
    box.append(head, list, note);
    function draw(people) {
      f.jailed = people;
      head.textContent = 'In jail now (' + people.length + ')';
      list.replaceChildren();
      if (!people.length) { list.append(el('li', 'jempty', 'Nobody is in jail.')); return; }
      people.forEach(function (p) {
        var li = el('li', 'jitem');
        li.setAttribute('data-id', p.id);
        li.append(avatarNode(p.avatar, p.display || p.id, 'av sm'));
        var who = el('div', 'jwho');
        who.append(el('b', null, p.display || 'Someone who left the server'));
        var bits = [];
        if (p.name) bits.push('@' + p.name);
        if (p.since) bits.push('jailed ' + new Date(p.since * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }));
        bits.push(p.until ? 'freed automatically ' + new Date(p.until * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'until staff free them');
        who.append(el('span', 'jmeta', bits.join(' • ')));
        if (p.reason) who.append(el('span', 'jmeta', 'Reason: ' + p.reason));
        var b = el('button', 'mini jfree', '🕊️ Free');
        b.type = 'button';
        b.setAttribute('aria-label', 'Free ' + (p.display || p.id));
        b.addEventListener('click', function () {
          if (!root.confirm('Free ' + (p.display || 'this member') + ' from jail?')) return;
          b.disabled = true;
          var guild = state.guild;
          request('/api/action', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ guild_id: guild, owner: 'jail', action: 'free', values: { member: p.id } })
          }).then(function (r) {
            if (guild !== state.guild) return;
            b.disabled = false;
            var ok = r.status === 200 && r.data && r.data.ok;
            note.hidden = false;
            note.className = 'fnote ' + (ok ? 'ok' : 'no');
            note.textContent = ok ? (r.data.note || 'Done.') : ((r.data && r.data.message) || errorText(r));
            if (ok && Array.isArray(r.data.data)) draw(r.data.data);
            if (ok) say(note.textContent);
          });
        });
        li.append(who, b);
        list.append(li);
      });
    }
    draw(f.jailed);
    return box;
  }

  // The few facts a card shows, like "Current number: 37" or "Saved backups: 3".
  function infoList(info) {
    var list = el('dl', 'finfo');
    info.slice(0, 6).forEach(function (i) {
      var row = el('div');
      row.append(el('dt', null, i.name), el('dd', null, i.value));
      list.append(row);
    });
    return list;
  }

  /* ---------- buttons on cards: BEV does something now, like "Back up now" ---------- */

  var formCount = 0;
  var flashes = {};       // card key -> the result of its last button, shown again after the board is redrawn

  // extra: { skip: [field keys filled in by the card], values(): those values, onResult(answer), ready(): why not yet, or '' }
  function actionRow(owner, buttons, extra) {
    extra = extra || {};
    var box = el('div', 'fact');
    var row = el('div', 'fbtns');
    var form = el('div', 'actform');
    form.hidden = true;
    var note = el('p', 'fnote');
    note.setAttribute('role', 'status');
    note.hidden = true;
    box.append(row, form, note);
    var open = null;
    var busy = false;
    var made = [];
    buttons.forEach(function (b) {
      var btn = el('button', 'mini abtn' + (b.danger ? ' danger' : ''), (b.emoji ? b.emoji + ' ' : '') + b.label);
      btn.type = 'button';
      btn.setAttribute('data-action', b.key);
      var fields = (b.fields || []).filter(function (fd) { return (extra.skip || []).indexOf(fd.key) === -1; });
      if (fields.length) btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () {
        var wait = extra.ready ? extra.ready() : '';
        if (wait) return show(wait, false);
        if (!fields.length) return run(b, {});
        if (open === b.key) return closeForm();
        made.forEach(function (m) { m.setAttribute('aria-expanded', m === btn ? 'true' : 'false'); });
        open = b.key;
        buildForm(form, b, fields, function (values) { run(b, values); });
        form.hidden = false;
        var first = form.querySelector('select, input');
        if (first) first.focus();
      });
      made.push(btn);
      row.append(btn);
    });
    if (flashes[owner]) { show(flashes[owner].text, flashes[owner].ok); delete flashes[owner]; }

    function closeForm() {
      open = null;
      form.hidden = true;
      form.replaceChildren();
      made.forEach(function (m) { if (m.hasAttribute('aria-expanded')) m.setAttribute('aria-expanded', 'false'); });
    }

    function show(text, ok) {
      note.hidden = !text;
      note.textContent = text || '';
      note.className = 'fnote' + (ok === true ? ' ok' : ok === false ? ' no' : '');
    }

    function run(b, values) {
      if (busy) return;
      // A role menu too long for one box: ask before posting it as several.
      if (owner === 'role_menus' && b.key === 'post' && !values.split) {
        var rm = (state.config.features || []).find(function (x) { return x.key === 'role_menus'; });
        var boxes = rm && rm.menu_boxes ? Number(rm.menu_boxes[values.menu]) || 1 : 1;
        if (boxes > 1) {
          askDialog({
            title: 'This menu will be split into ' + boxes + ' boxes',
            text: 'Discord limits how much one message can hold, and this list is too long to fit in one box. BEV will post it as ' + boxes
              + ' boxes, one straight under the other: the title in the first box and the tip at the end of the last. Every role button still works.',
            hint: 'To keep it in one box, change the menu’s Layout to Buttons in rows, or use fewer roles.',
            ok: 'Post in ' + boxes + ' boxes',
            cancel: 'Go back'
          }).then(function (yes) {
            if (yes) run(b, Object.assign({}, values, { split: 'yes' }));
            else show('Not posted. Nothing was sent.', null);
          });
          return;
        }
      }
      if (b.confirm && !root.confirm(b.confirm)) return;
      busy = true;
      made.forEach(function (m) { m.disabled = true; });
      show('Working on it…', null);
      var guild = state.guild;
      request('/api/action', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ guild_id: guild, owner: owner, action: b.key, values: Object.assign({}, extra.values ? extra.values() : {}, values) })
      }).then(function (r) {
        busy = false;
        made.forEach(function (m) { m.disabled = false; });
        if (guild !== state.guild) return;
        if (r.status === 200 && r.data && r.data.ok) {
          closeForm();
          show(r.data.note || 'Done.', true);
          if (extra.onResult) extra.onResult(r.data);
          if (owner === 'backup' && b.key === 'history' && Array.isArray(r.data.data)) drawBackupHistory(r.data.data);
          if (owner === 'listing' && b.key === 'ai_write' && r.data.data) useListingSuggestion(r.data.data, r.data.note);
          if (r.data.reload) refreshAfterAction(owner, r.data.note || 'Done.', show);
          return;
        }
        show((r.data && r.data.message) || errorText(r), false);
      });
    }
    // Server Backups → History: the last 5 backups with when each was saved, each with its own Restore button.
    var hist = null;
    function drawBackupHistory(items) {
      if (!hist) { hist = el('ol', 'bhist'); hist.id = 'bhist'; box.append(hist); }
      hist.replaceChildren();
      var restore = buttons.find(function (x) { return x.key === 'restore'; });
      items.forEach(function (it, i) {
        var li = el('li', 'bhitem');
        var when = new Date(it.created * 1000);
        var head = el('b', null, when.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
        var meta = el('span', 'bhmeta', 'Backup #' + it.id + (i === 0 ? ' • newest' : '') + ' • ' + ago(it.created) + (it.label ? ' • ' + it.label : '') +
          ' • ' + it.roles + ' role' + (it.roles === 1 ? '' : 's') + ', ' + it.channels + ' channel' + (it.channels === 1 ? '' : 's'));
        var who = el('div', 'bhwho');
        who.append(head, meta);
        li.append(who);
        if (restore) {
          var go = el('button', 'mini danger', '♻️ Restore this one');
          go.type = 'button';
          go.setAttribute('aria-label', 'Restore backup #' + it.id + ' from ' + head.textContent);
          go.addEventListener('click', function () { run(restore, { backup: it.id }); });
          li.append(go);
        }
        hist.append(li);
      });
      if (!items.length) hist.append(el('li', 'bhempty', 'No backups yet. Press Back up now to make one.'));
    }
    function ago(t) {
      var s = Math.max(0, Math.round(Date.now() / 1000 - t));
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
      if (s < 86400) { var h = Math.round(s / 3600); return h + ' hour' + (h === 1 ? '' : 's') + ' ago'; }
      var d = Math.round(s / 86400); return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    }
    return box;
  }

  // Server Listing → Write it with AI: the suggestion fills the card as unsaved changes, to edit and then Save.
  function useListingSuggestion(d, note) {
    if (typeof d.description === 'string') set('listing_description', d.description);
    if (Array.isArray(d.tags)) set('listing_tags', d.tags.filter(function (t) { return typeof t === 'string'; }).slice(0, 5));
    var old = $('f-listing');
    var f = (state.config.features || []).find(function (x) { return x.key === 'listing'; });
    if (!old || !f) return;
    var fresh = featureCard(f);
    old.replaceWith(fresh);
    var box = fresh.querySelector('details.fset');
    if (box) box.open = true;
    var desc = fresh.querySelector('textarea');
    if (desc) desc.focus();
  }

  // A pop-up question with two clearly named answers. Resolves true for ok, false for cancel (Escape cancels too).
  function askDialog(o) {
    return new Promise(function (resolve) {
      if (typeof root.HTMLDialogElement !== 'function') { resolve(root.confirm(o.title + '\n\n' + o.text)); return; }
      var d = el('dialog', 'askbox');
      var hid = 'ask-' + (++formCount);
      d.setAttribute('aria-labelledby', hid);
      var h = el('h2', 'disp', o.title);
      h.id = hid;
      d.append(h, el('p', null, o.text));
      if (o.hint) d.append(el('p', 'askhint', o.hint));
      var row = el('div', 'row askrow');
      var no = el('button', 'mini', o.cancel);
      var yes = el('button', 'act save', o.ok);
      no.type = yes.type = 'button';
      no.id = 'askno';
      yes.id = 'askyes';
      row.append(no, ' ', yes);
      d.append(row);
      var answered = false;
      function done(value) {
        if (answered) return;
        answered = true;
        if (d.open) d.close();
        d.remove();
        resolve(value);
      }
      yes.addEventListener('click', function () { done(true); });
      no.addEventListener('click', function () { done(false); });
      d.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      doc.body.append(d);
      d.showModal();
      yes.focus();
    });
  }

  function buildForm(form, b, fields, submit) {
    form.replaceChildren();
    var inputs = {};
    fields.forEach(function (fd) {
      var id = 'af-' + (++formCount);
      var cell = el('div', 'icell');
      var label = el('label', 'flabel sm', fd.label);
      label.htmlFor = id;
      var node;
      if (fd.kind === 'choice') {
        node = el('select', 'field');
        optionsFor(node, (fd.options || []).map(function (o) { return { value: String(o.value), label: o.label }; }), String(((fd.options || [])[0] || {}).value || ''));
      } else if (fd.kind === 'role') {
        node = el('select', 'field');
        optionsFor(node, roleChoices(), '', 'Pick a role…');
      } else {
        node = el('input', 'field' + (fd.kind === 'number' ? ' num' : ''));
        node.type = fd.kind === 'number' ? 'number' : 'text';
        if (fd.kind === 'number') {
          if (fd.min !== undefined) node.min = fd.min;
          if (fd.max !== undefined) node.max = fd.max;
          node.inputMode = 'numeric';
        }
        if (fd.max_length) node.maxLength = fd.max_length;
        if (fd.placeholder) node.placeholder = fd.placeholder;
        node.autocomplete = 'off';
      }
      node.id = id;
      inputs[fd.key] = node;
      cell.append(label, node);
      form.append(cell);
    });
    var go = el('button', 'mini go' + (b.danger ? ' danger' : ''), (b.emoji ? b.emoji + ' ' : '') + b.label.replace(/…$/, ''));
    go.type = 'button';
    go.addEventListener('click', function () {
      var values = {};
      Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
      submit(values);
    });
    // Enter in a box presses this form's button (set, not added, so an earlier form's button never runs instead).
    form.onkeydown = function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); go.click(); }
    };
    form.append(go);
  }

  // Some buttons change what the card shows (a new backup, the count reset). Load the server again to show it,
  // unless that would lose changes that aren't saved yet.
  function refreshAfterAction(owner, text, show) {
    if (dirtyCount()) {
      show(text + ' Save or discard your changes, then reload the page to see it here.', true);
      return;
    }
    var guild = state.guild;
    request('/api/config?guild_id=' + encodeURIComponent(guild)).then(function (r) {
      if (guild !== state.guild || dirtyCount() || r.status !== 200 || !r.data || !Array.isArray(r.data.features)) return;
      var y = root.scrollY;
      flashes[owner] = { text: text, ok: true };
      useConfig(r.data);
      root.scrollTo(0, y);
    });
  }

  /* ---------- tool cards: Member tools, Security scan, Emojis, Health check ---------- */

  function toolCard(t) {
    var card = el('article', 'feat tool' + (isWide(t) ? ' wide' : ''));
    card.id = 't-' + t.key;
    card.setAttribute('data-search', [t.name, t.about].join(' ').toLowerCase());
    card.setAttribute('data-key', 'tool:' + t.key);
    var head = el('div', 'fhead');
    head.append(el('span', 'ficon', t.icon));
    var title = el('div', 'ftitle');
    title.append(el('h3', null, t.name));
    title.append(el('span', 'key', 'Tool'));
    head.append(title);
    card.append(head);
    var main = el('div', 'fmain');
    main.append(el('p', 'desc', t.about));
    // The buttons and what they show sit where the Settings line is on the card beside it.
    var meta = el('div', 'fmeta');
    // Scan and health results open below the buttons; the emoji list is always there, so it isn't "opened".
    var body = el('div', 'tres' + (t.key === 'scan' || t.key === 'health' ? ' grows' : ''));
    if (t.key === 'members') memberTool(t, meta, body);
    else if (t.key === 'emoji') emojiTool(t, meta, body);
    else {
      var draw = t.key === 'scan' ? scanResults : t.key === 'health' ? healthResults : null;
      meta.append(actionRow(t.key, t.buttons || [], { onResult: function (answer) { if (draw && answer.data) body.replaceChildren(draw(answer.data)); } }));
    }
    var lower = el('div', 'tbody');
    lower.append(meta, body);
    card.append(main, lower);
    return card;
  }

  function scanResults(data) {
    var wrap = el('div', 'results');
    var found = Array.isArray(data.findings) ? data.findings : [];
    if (!found.length) {
      wrap.append(el('p', 'allgood', '✅ Nothing risky found. Run it again after you change roles or add bots.'));
      return wrap;
    }
    var list = el('ul', 'findings');
    var names = { high: 'Serious', medium: 'Worth fixing', low: 'Good to know' };
    found.forEach(function (f) {
      var li = el('li', 'finding ' + (names[f.level] ? f.level : 'low'));
      var top = el('p', 'ftop');
      top.append(el('span', 'lvl', names[f.level] || 'Note'), el('b', null, f.title));
      li.append(top, el('p', 'fdetail', f.detail), el('p', 'ffix', 'How to fix: ' + f.fix));
      list.append(li);
    });
    wrap.append(list);
    return wrap;
  }

  function healthResults(d) {
    var wrap = el('div', 'results');
    var grid = el('dl', 'finfo');
    function line(name, value) { var row = el('div'); row.append(el('dt', null, name), el('dd', null, value)); grid.append(row); }
    line('Ping', d.ping_ms === null || d.ping_ms === undefined ? 'Unknown' : d.ping_ms + ' ms');
    line('Version', 'BEV ' + d.version);
    line('Features on', d.on + ' of ' + d.total);
    line('BEV’s role', '@' + d.role + (d.roles_above ? ' (' + d.roles_above + ' role' + (d.roles_above === 1 ? '' : 's') + ' above it: drag it higher)' : ' (at the top)'));
    line('Permissions', d.admin ? 'Administrator: everything BEV needs' : (d.missing && d.missing.length ? 'Missing: ' + d.missing.join(', ') : 'Everything BEV needs'));
    wrap.append(grid);
    var problems = Array.isArray(d.problems) ? d.problems : [];
    wrap.append(el('p', 'flabel sm', problems.length ? 'Switched-on features that need attention' : '✅ No switched-on feature needs attention.'));
    if (problems.length) {
      var list = el('ul', 'findings');
      problems.forEach(function (p) {
        var li = el('li', 'finding medium');
        var link = el('a', 'inl', p.icon + ' ' + p.name);
        link.href = '#f-' + p.key;
        link.addEventListener('click', function (e) {
          var card = doc.getElementById('f-' + p.key);
          if (!card) return;
          e.preventDefault();
          var details = card.querySelector('details.fset');
          if (details) details.open = true;
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        var top = el('p', 'ftop');
        top.append(link);
        li.append(top, el('p', 'fdetail', p.text));
        list.append(li);
      });
      wrap.append(list);
    }
    var extras = el('p', 'fdetail', (d.extras || []).map(function (x) { return (x.ok ? '✅ ' : '➖ ') + x.name; }).join('   '));
    wrap.append(extras);
    return wrap;
  }

  // Member tools: find someone, see their numbers, then use the buttons on them.
  function memberTool(t, meta, body) {
    var picked = null;
    var wrap = el('div', 'msearch');
    var id = 'mt-find';
    var label = el('label', 'flabel sm', 'Find a member');
    label.htmlFor = id;
    var input = el('input', 'field');
    input.type = 'search';
    input.id = id;
    input.placeholder = 'Type part of their name, or their ID';
    input.autocomplete = 'off';
    input.setAttribute('aria-controls', 'mt-found');
    var found = el('ul', 'mfound');
    found.id = 'mt-found';
    found.hidden = true;
    wrap.append(label, input, found);
    var summary = el('div', 'msum');
    summary.append(el('p', 'empty', 'Nobody picked yet. Search above, then pick someone.'));
    var buttons = (t.buttons || []).filter(function (b) { return b.key !== 'look'; });
    var actions = actionRow('members', buttons, {
      skip: ['member'],
      values: function () { return picked ? { member: picked.id } : {}; },
      ready: function () { return picked ? '' : 'Find and pick a member first.'; },
      onResult: function (answer) { if (answer.data && answer.data.id) drawSummary(answer.data); }
    });
    meta.append(wrap);
    body.append(summary, actions);

    var timer = null;
    var asked = 0;
    input.addEventListener('input', function () {
      root.clearTimeout(timer);
      var text = input.value.trim();
      if (text.length < 2 && !/^\d+$/.test(text)) { found.hidden = true; found.replaceChildren(); return; }
      timer = root.setTimeout(function () { search(text); }, 250);
    });

    function search(text) {
      var n = ++asked;
      request('/api/members?guild_id=' + encodeURIComponent(state.guild) + '&q=' + encodeURIComponent(text)).then(function (r) {
        if (n !== asked) return;
        found.replaceChildren();
        var list = r.status === 200 && r.data && Array.isArray(r.data.members) ? r.data.members : null;
        if (!list) { found.append(el('li', 'empty', errorText(r))); found.hidden = false; return; }
        if (!list.length) { found.append(el('li', 'empty', 'Nobody in the server matches that.')); found.hidden = false; return; }
        list.forEach(function (m) {
          var li = el('li');
          var b = el('button', 'mpick');
          b.type = 'button';
          b.append(avatarNode(m.avatar && /^https:\/\/cdn\.discordapp\.com\//.test(m.avatar) ? m.avatar : null, m.display, 'av xs'), el('b', null, m.display), el('span', 'mname', '@' + m.name));
          b.addEventListener('click', function () { pick(m); });
          li.append(b);
          found.append(li);
        });
        found.hidden = false;
      });
    }

    function pick(m) {
      picked = { id: m.id };
      found.hidden = true;
      input.value = m.display;
      summary.replaceChildren(el('p', 'empty', 'Loading ' + m.display + '…'));
      request('/api/action', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ guild_id: state.guild, owner: 'members', action: 'look', values: { member: m.id } })
      }).then(function (r) {
        if (!picked || picked.id !== m.id) return;
        if (r.status === 200 && r.data && r.data.data) return drawSummary(r.data.data);
        summary.replaceChildren(el('p', 'miss', (r.data && r.data.message) || errorText(r)));
      });
    }

    function drawSummary(d) {
      picked = { id: d.id };
      summary.replaceChildren();
      var top = el('div', 'mtop');
      top.append(avatarNode(d.avatar && /^https:\/\/cdn\.discordapp\.com\//.test(d.avatar) ? d.avatar : null, d.display, 'av'));
      var who = el('div');
      who.append(el('b', null, d.display), el('span', 'mname', '@' + d.name));
      top.append(who);
      summary.append(top);
      var facts = el('dl', 'finfo');
      function line(name, value) { var row = el('div'); row.append(el('dt', null, name), el('dd', null, value)); facts.append(row); }
      line('Level', d.level_name + (d.level >= 100 ? '' : ' (' + Number(d.xp).toLocaleString() + ' / ' + Number(d.needed).toLocaleString() + ' XP)'));
      line('Coins', Number(d.wallet).toLocaleString() + ' in their wallet, ' + Number(d.bank).toLocaleString() + ' in the bank');
      line('Warnings', String(d.warnings) + (d.jailed ? ' • in jail right now' : ''));
      if (d.verified !== null && d.verified !== undefined) line('Verified', d.verified ? 'Yes' : 'Not yet');
      if (d.ladder && typeof d.ladder === 'object') {
        var NEXT = { timeout: 'a timeout', jail: 'jail', ban: 'a ban' };
        line('Punishment Ladder', d.ladder.offences + ' offence' + (d.ladder.offences === 1 ? '' : 's') + ' • next: ' + (NEXT[d.ladder.next] || d.ladder.next)
          + ' • starts again ' + new Date(d.ladder.resets * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' if nothing else happens');
      }
      summary.append(facts);
      var pleas = Array.isArray(d.pleas) ? d.pleas : [];
      if (pleas.length) {
        summary.append(el('p', 'flabel', 'Requests to be freed from jail'));
        var plist = el('ul', 'mpleas');
        var WORD = { approved: '✅ Approved', denied: '❌ Denied', closed: '🕊️ Freed another way first' };
        pleas.forEach(function (pl) {
          var li = el('li');
          var head = (pl.status === 'approved' && pl.outcome ? '✅ ' + pl.outcome : (WORD[pl.status] || pl.status)) + ' • asked ' +
            new Date(pl.at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          li.append(el('b', null, head), el('span', 'mpq', '“' + pl.text + '”'));
          if (pl.note) li.append(el('span', 'mpn', 'Staff note: ' + pl.note));
          plist.append(li);
        });
        summary.append(plist);
      }
      var bag = Array.isArray(d.inventory) ? d.inventory : [];
      summary.append(el('p', 'flabel', '🎒 Inventory'));
      if (bag.length) {
        var blist = el('ul', 'minv');
        bag.forEach(function (it) {
          var li = el('li');
          li.append(el('b', null, it.name), el('span', 'minvq', '× ' + Number(it.qty).toLocaleString()));
          if (it.about) li.append(el('span', 'minva', it.about.replace(/<@&\d+>/g, 'a role')));
          blist.append(li);
        });
        summary.append(blist);
      } else summary.append(el('p', 'fhelp', 'Nothing in their inventory.'));
      var temp = Array.isArray(d.temp_roles) ? d.temp_roles : [];
      if (temp.length) {
        var list = el('ul', 'mtemp');
        temp.forEach(function (tr) {
          var li = el('li');
          li.append(el('span', null, '⏳ @' + tr.name + ' until ' + new Date(tr.until * 1000).toLocaleString()));
          var x = el('button', 'mini danger', 'Take away now');
          x.type = 'button';
          x.addEventListener('click', function () {
            x.disabled = true;
            request('/api/action', {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify({ guild_id: state.guild, owner: 'members', action: 'temprole_end', values: { member: d.id, role: tr.id } })
            }).then(function (r) {
              if (r.status === 200 && r.data && r.data.data) drawSummary(r.data.data);
              else { x.disabled = false; li.append(el('span', 'miss', ' ' + ((r.data && r.data.message) || errorText(r)))); }
            });
          });
          li.append(x);
          list.append(li);
        });
        summary.append(list);
      }
    }
  }

  // Emojis: every emoji in the server with a way to remove it, and a form to add one.
  function emojiTool(t, meta, body) {
    var data = t.data || { emojis: [], limit: 0 };
    var count = el('p', 'uses');
    var grid = el('ul', 'egrid');
    var problem = el('p', 'fnote no');
    problem.setAttribute('role', 'status');
    problem.hidden = true;
    meta.append(count, actionRow('emoji', t.buttons || [], { onResult: function (answer) { if (answer.data && answer.data.emojis) { data = answer.data; draw(); } } }));
    body.append(problem, grid);
    function draw() {
      count.textContent = data.emojis.length + ' of ' + data.limit + ' emoji slots used';
      grid.replaceChildren();
      if (!data.emojis.length) grid.append(el('li', 'empty', 'No emojis yet.'));
      data.emojis.forEach(function (e) {
        var li = el('li', 'eitem');
        var img = el('img');
        img.alt = ':' + e.name + ':';
        img.width = 28; img.height = 28; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
        if (/^https:\/\/cdn\.discordapp\.com\//.test(e.url)) img.src = e.url;
        var name = el('span', 'ename', ':' + e.name + ':');
        var x = el('button', 'ex', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove :' + e.name + ':');
        x.addEventListener('click', function () {
          if (!root.confirm('Remove :' + e.name + ': from the server?')) return;
          x.disabled = true;
          request('/api/action', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ guild_id: state.guild, owner: 'emoji', action: 'remove', values: { emoji: e.id } })
          }).then(function (r) {
            if (r.status === 200 && r.data && r.data.data && r.data.data.emojis) { problem.hidden = true; data = r.data.data; draw(); say(r.data.note || 'Removed.'); }
            else { x.disabled = false; problem.textContent = (r.data && r.data.message) || errorText(r); problem.hidden = false; }
          });
        });
        li.append(img, name, x);
        grid.append(li);
      });
    }
    draw();
  }

  function switchButton(name, get, put, small) {
    var b = el('button', 'switch' + (small ? ' sm' : ''));
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', name);
    var knob = el('span', 'knob');
    var text = el('span', 'slab');
    b.append(knob, text);
    function draw() {
      var on = !!get();
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      text.textContent = on ? 'On' : 'Off';
    }
    b.addEventListener('click', function () { put(!get()); draw(); });
    b.redraw = draw;
    draw();
    return b;
  }

  function set(key, value) {
    state.draft.settings[key] = value;
    if (problems[key]) { delete problems[key]; markProblems(); }
    showIfs();
    updateDirty();
  }

  // Settings that only matter for one choice of another setting (like the custom name, only for "Custom display name").
  // Every condition must hold: [{key, value}], like "Unlock GIF perms" on AND "Use a role I pick".
  function shownNow(wrap) {
    var conditions = [];
    try { conditions = JSON.parse(wrap.getAttribute('data-if') || '[]'); } catch (e) { conditions = []; }
    return conditions.every(function (c) { return String(state.draft.settings[c.key]) === String(c.value); });
  }

  function showIfs() {
    doc.querySelectorAll('.fld[data-if]').forEach(function (w) { w.hidden = !shownNow(w); });
  }

  function fieldFor(s) {
    var wrap = el('div', 'fld');
    wrap.setAttribute('data-key', s.key);
    var id = 's-' + s.key;
    var label = el('label', 'flabel', s.label);
    label.htmlFor = id;
    wrap.append(label);
    if (s.help) wrap.append(el('p', 'help', s.help));
    wrap.append(control(s, id, function () { return state.draft.settings[s.key]; }, function (v) { set(s.key, v); }, wrap));
    var err = el('p', 'ferr');
    err.hidden = true;
    wrap.append(err);
    var conditions = (Array.isArray(s.show_if) ? s.show_if : s.show_if ? [s.show_if] : [])
      .filter(function (c) { return c && typeof c.key === 'string'; }).map(function (c) { return { key: c.key, value: c.value }; });
    if (conditions.length) {
      wrap.setAttribute('data-if', JSON.stringify(conditions));
      wrap.hidden = !shownNow(wrap);
    }
    return wrap;
  }

  function optionsFor(select, list, current, emptyLabel) {
    select.replaceChildren();
    if (emptyLabel) {
      var none = el('option', null, emptyLabel);
      none.value = '';
      select.append(none);
    }
    list.forEach(function (o) {
      var opt = el('option', null, o.label);
      opt.value = String(o.value);
      if (o.disabled) opt.disabled = true;
      select.append(opt);
    });
    select.value = current === null || current === undefined ? '' : String(current);
    if (select.value !== (current === null || current === undefined ? '' : String(current)) && emptyLabel) select.value = '';
  }

  function channelChoices(types) {
    return (state.config.channels || []).filter(function (c) { return (types || ['text']).indexOf(c.type) !== -1; })
      .map(function (c) { return { value: c.id, label: channelLabel(c) }; });
  }

  function roleChoices() {
    return (state.config.roles || []).map(function (r) { return { value: r.id, label: '@' + r.name + (r.assignable ? '' : '  (above BEV’s role)') }; });
  }

  function nameOf(kind, idValue) {
    var list = kind === 'role' ? state.config.roles : state.config.channels;
    var found = (list || []).find(function (x) { return x.id === idValue; });
    if (!found) return kind === 'user' ? idValue : 'deleted (' + idValue + ')';
    return kind === 'role' ? '@' + found.name : channelLabel(found);
  }

  // One input for one setting. get() reads the current value; put(v) stores a new one.
  function control(s, id, get, put, wrap) {
    var kind = s.kind;
    var node;
    if (kind === 'toggle') {
      node = switchButton(s.label, get, put, true);
      node.id = id;
      return node;
    }
    if (kind === 'choice') {
      node = el('select', 'field');
      node.id = id;
      optionsFor(node, s.options.map(function (o) { return { value: o.value, label: o.label }; }), get());
      node.addEventListener('change', function () {
        var picked = s.options.find(function (o) { return String(o.value) === node.value; });
        put(picked ? picked.value : node.value);
      });
      return node;
    }
    if (kind === 'multi') {
      node = el('div', 'checks' + (s.options.length > 20 ? ' long' : ''));
      node.id = id;
      s.options.forEach(function (o) {
        var lab = el('label', 'chk');
        var box = el('input');
        box.type = 'checkbox';
        box.checked = (get() || []).some(function (v) { return String(v) === String(o.value); });
        box.addEventListener('change', function () {
          var now = s.options.filter(function (x, i) { return node.querySelectorAll('input')[i].checked; }).map(function (x) { return x.value; });
          put(now);
        });
        lab.append(box, el('span', null, o.label));
        node.append(lab);
      });
      return node;
    }
    if (kind === 'number') {
      node = el('input', 'field num');
      node.id = id;
      node.type = 'number';
      node.inputMode = 'numeric';
      node.step = '1';
      if (s.min !== undefined) node.min = String(s.min);
      if (s.max !== undefined) node.max = String(s.max);
      node.value = get() === null || get() === undefined ? '' : String(get());
      node.addEventListener('input', function () {
        var v = node.value.trim();
        put(/^-?\d+$/.test(v) ? Number(v) : v);
      });
      return node;
    }
    if (kind === 'text' && s.key === 'listing_invite_code') {
      // discord.gg/ is part of the box and can't be deleted; only the code after it is typed.
      var ibox = el('div', 'field invbox');
      var pre = el('span', 'invpre', 'discord.gg/');
      pre.setAttribute('aria-hidden', 'true');
      node = el('input', 'invin');
      node.id = id;
      node.type = 'text';
      node.autocomplete = 'off';
      node.spellcheck = false;
      node.maxLength = 32;
      node.placeholder = s.placeholder || 'your-server';
      node.setAttribute('aria-describedby', id + '-pre');
      var sr = el('span', 'sr', 'discord.gg/');
      sr.id = id + '-pre';
      node.value = get() || '';
      node.addEventListener('input', function () {
        // A pasted full link keeps only the code.
        var v = node.value.replace(/^\s*(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i, '').replace(/\s+/g, '');
        if (v !== node.value) node.value = v;
        put(v);
      });
      ibox.addEventListener('click', function (e) { if (e.target !== node) node.focus(); });
      ibox.append(pre, node, sr);
      return ibox;
    }
    if (kind === 'text') {
      var box = el('div', 'tbox');
      node = el(s.multiline ? 'textarea' : 'input', 'field' + (s.multiline ? ' ta' : ''));
      node.id = id;
      if (!s.multiline) node.type = 'text';
      if (s.max_length) node.maxLength = s.max_length;
      if (s.placeholder) node.placeholder = s.placeholder;
      node.value = get() || '';
      var count = el('span', 'count');
      function recount() { count.textContent = node.value.length + ' / ' + (s.max_length || '∞'); }
      node.addEventListener('input', function () { put(node.value); recount(); });
      recount();
      box.append(node, count);
      return box;
    }
    if (kind === 'words') {
      var wbox = el('div', 'tbox');
      node = el('textarea', 'field ta');
      node.id = id;
      node.rows = 4;
      node.placeholder = s.placeholder || 'One per line';
      node.value = (get() || []).join('\n');
      var wcount = el('span', 'count');
      function rewords() { var n = wordsFrom(node.value).length; wcount.textContent = n + ' of ' + (s.max_items || 25) + ' (one per line)'; }
      node.addEventListener('input', function () { put(wordsFrom(node.value)); rewords(); });
      rewords();
      wbox.append(node, wcount);
      return wbox;
    }
    if (kind === 'channel' || kind === 'role') {
      node = el('select', 'field');
      node.id = id;
      optionsFor(node, kind === 'channel' ? channelChoices(s.channel_types) : roleChoices(), get(), 'Not set');
      node.addEventListener('change', function () { put(node.value || null); });
      return node;
    }
    if (kind === 'channels' || kind === 'roles' || kind === 'users') {
      return pickList(s, id, get, put);
    }
    if (kind === 'list') {
      return listEditor(s, get, put, wrap);
    }
    return el('p', 'help', 'This setting can be changed in Discord.');
  }

  // Several channels, roles or members: chips with a remove button, and a way to add more.
  function pickList(s, id, get, put) {
    var box = el('div', 'picklist');
    var chips = el('div', 'pchips');
    var kind = s.kind === 'channels' ? 'channel' : s.kind === 'roles' ? 'role' : 'user';
    var adder;
    function draw() {
      chips.replaceChildren();
      var values = get() || [];
      if (!values.length) chips.append(el('span', 'empty', 'None picked'));
      values.forEach(function (v) {
        var chip = el('span', 'pchip', nameOf(kind, v));
        var x = el('button', 'x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove ' + nameOf(kind, v));
        x.addEventListener('click', function () { put((get() || []).filter(function (o) { return o !== v; })); draw(); });
        chip.append(x);
        chips.append(chip);
      });
      if (adder && adder.tagName === 'SELECT') {
        var taken = typeof s.exclude === 'function' ? s.exclude() : [];
        var options = (kind === 'channel' ? channelChoices(s.channel_types) : roleChoices()).filter(function (o) { return values.indexOf(o.value) === -1 && taken.indexOf(o.value) === -1; });
        optionsFor(adder, options, '', kind === 'channel' ? 'Add a channel…' : 'Add a role…');
        adder.disabled = values.length >= (s.max_items || 25);
      }
    }
    if (kind === 'user') {
      var row = el('div', 'row');
      adder = el('input', 'field');
      adder.id = id;
      adder.placeholder = 'Paste a member ID';
      adder.inputMode = 'numeric';
      var add = el('button', 'mini', 'Add');
      add.type = 'button';
      add.addEventListener('click', function () {
        var v = adder.value.trim();
        if (!ID_RE.test(v)) { adder.setCustomValidity('Paste a member’s ID: right-click them in Discord (with Developer Mode on) and Copy User ID.'); adder.reportValidity(); return; }
        adder.setCustomValidity('');
        var values = get() || [];
        if (values.indexOf(v) === -1) put(values.concat([v]));
        adder.value = '';
        draw();
      });
      row.append(adder, add);
      box.append(chips, row);
    } else {
      adder = el('select', 'field');
      adder.id = id;
      adder.addEventListener('change', function () {
        if (!adder.value) return;
        put((get() || []).concat([adder.value]));
        draw();
      });
      box.append(chips, adder);
    }
    draw();
    return box;
  }

  /* ---------- role menus: groups of roles that don't affect each other ---------- */

  var MENU_GROUPS_MAX = 5;
  var MENU_ROLES_MAX = 20;

  // A menu's groups, or (for a menu saved before groups) its one-at-a-time roles and the rest.
  function menuGroupsOf(menu) {
    if (menu && Array.isArray(menu.groups) && menu.groups.length) {
      return menu.groups.map(function (g) { return { roles: (g.roles || []).map(String), one: !!g.one, note: g.note || '' }; });
    }
    var roles = ((menu && menu.roles) || []).map(String);
    var swap = ((menu && menu.swap_roles) || []).map(String);
    var out = [];
    var one = roles.filter(function (r) { return swap.indexOf(r) !== -1; });
    var free = roles.filter(function (r) { return swap.indexOf(r) === -1; });
    if (one.length) out.push({ roles: one, one: true, note: '' });
    if (free.length || !out.length) out.push({ roles: free, one: false, note: '' });
    return out;
  }

  function menuGroups(get, put, index) {
    var box = el('div', 'mgroups');
    var head = el('div', 'mghelp');
    head.append(el('span', 'flabel sm', 'Roles in the menu'),
      el('p', 'help sm', 'Each group works on its own, so picking a role never removes one from another group. In a One at a time group, picking another role swaps it. On the menu, groups are split by a line.'));
    var list = el('div', 'mglist');
    var add = el('button', 'mini add', '＋ New group');
    add.type = 'button';
    box.append(head, list, add);
    function menu() { return (get() || [])[index]; }
    function save(groups) {
      var now = clone(get() || []);
      if (!now[index]) return;
      var all = [];
      groups.forEach(function (g) { g.roles.forEach(function (r) { if (all.indexOf(r) === -1) all.push(r); }); });
      now[index].groups = groups;
      now[index].roles = all;
      now[index].swap_roles = all.filter(function (r) { return groups.some(function (g) { return g.one && g.roles.indexOf(r) !== -1; }); });
      put(now);
    }
    function draw() {
      list.replaceChildren();
      var groups = menuGroupsOf(menu());
      var total = groups.reduce(function (n, g) { return n + g.roles.length; }, 0);
      groups.forEach(function (g, gi) {
        var card = el('div', 'mgroup');
        var top = el('div', 'mgtop');
        top.append(el('b', null, 'Group ' + (gi + 1)));
        var kind = el('select', 'field mgkind');
        kind.setAttribute('aria-label', 'How group ' + (gi + 1) + ' works');
        optionsFor(kind, [{ value: 'one', label: 'One at a time' }, { value: 'any', label: 'Pick as many as you like' }], g.one ? 'one' : 'any');
        kind.addEventListener('change', function () { groups[gi].one = kind.value === 'one'; save(groups); });
        top.append(kind);
        if (groups.length > 1) {
          var remove = el('button', 'mini danger', 'Remove group');
          remove.type = 'button';
          remove.addEventListener('click', function () { groups.splice(gi, 1); save(groups); draw(); });
          top.append(remove);
        }
        card.append(top);
        var picker = { kind: 'roles', max_items: MENU_ROLES_MAX - (total - g.roles.length),
          exclude: function () { var used = []; groups.forEach(function (o, oi) { if (oi !== gi) used = used.concat(o.roles); }); return used; } };
        card.append(pickList(picker, 's-rm-' + index + '-g' + gi, function () { return groups[gi].roles; },
          function (v) { groups[gi].roles = v.map(String); save(groups); draw(); }));
        var note = el('input', 'field mgnote');
        note.type = 'text';
        note.maxLength = 150;
        note.placeholder = 'Optional note, shown in small writing under this group';
        note.value = g.note || '';
        note.setAttribute('aria-label', 'Note under group ' + (gi + 1));
        note.addEventListener('input', function () { groups[gi].note = note.value; save(groups); });
        card.append(note);
        list.append(card);
      });
      add.disabled = groups.length >= MENU_GROUPS_MAX || total >= MENU_ROLES_MAX;
      add.onclick = function () { groups.push({ roles: [], one: true, note: '' }); save(groups); draw(); };
    }
    draw();
    return box;
  }

  // Lists of things (shop items, streamers, menus…): a small card per item, a remove button and Add.
  function listEditor(s, get, put, wrap) {
    // Items with one or two fields (level rewards, XP boosts) get one compact line each, so long lists stay short.
    var compact = (s.fields || []).length <= 2;
    var box = el('div', 'items' + (compact ? ' compact' : ''));
    function draw() {
      box.replaceChildren();
      var list = get() || [];
      if (!list.length) box.append(el('p', 'empty', 'No ' + (s.item || 'item') + 's yet.'));
      list.forEach(function (item, index) {
        var row = el('div', 'item');
        var top = el('div', 'ihead');
        top.append(el('b', compact ? 'sr' : null, (s.item || 'Item').replace(/^./, function (c) { return c.toUpperCase(); }) + ' ' + (index + 1)));
        var remove = el('button', 'mini danger', compact ? '×' : 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + (s.item || 'item') + ' ' + (index + 1));
        remove.addEventListener('click', function () {
          var now = clone(get() || []);
          now.splice(index, 1);
          put(now);
          draw();
        });
        top.append(remove);
        row.append(top);
        var grid = el('div', 'igrid');
        // Role menus: the reaction emojis only matter for the reactions style, the layout only for buttons.
        // Any list: a part with show_if only shows while another part of the same row has one of the given values.
        function rowFieldShown(f) {
          var conds = (Array.isArray(f.show_if) ? f.show_if : f.show_if ? [f.show_if] : []).filter(function (c) { return c && typeof c.key === 'string'; });
          var item = (get() || [])[index] || {};
          return conds.every(function (c) {
            var want = Array.isArray(c.value) ? c.value : [c.value];
            return want.some(function (v) { return String(item[c.key] === undefined || item[c.key] === null ? '' : item[c.key]) === String(v); });
          });
        }
        function menuFieldShown(key) {
          var style = ((get() || [])[index] || {}).style || 'buttons';
          return key === 'emojis' ? style === 'reactions' : key === 'layout' ? style === 'buttons' : true;
        }
        (s.fields || []).forEach(function (f) {
          if (s.key === 'role_menus' && (f.key === 'roles' || f.key === 'swap_roles')) return;     // shown as groups below
          var cell = el('div', 'icell k-' + f.kind);
          if (s.key === 'role_menus') { cell.setAttribute('data-field', f.key); cell.hidden = !menuFieldShown(f.key); }
          else if (f.show_if) { cell.setAttribute('data-rowif', f.key); cell.hidden = !rowFieldShown(f); }
          var fid = 's-' + s.key + '-' + index + '-' + f.key;
          var lab = el('label', 'flabel sm' + (compact && index ? ' sr' : ''), f.label);
          lab.htmlFor = fid;
          cell.append(lab);
          if (f.help && !compact) cell.append(el('p', 'help sm', f.help));
          cell.append(control(f, fid, function () { return (get() || [])[index] ? get()[index][f.key] : null; }, function (v) {
            var now = clone(get() || []);
            if (!now[index]) return;
            now[index][f.key] = v;
            put(now);
            grid.querySelectorAll('[data-rowif]').forEach(function (c) {
              var ff = (s.fields || []).find(function (x) { return x.key === c.getAttribute('data-rowif'); });
              if (ff) c.hidden = !rowFieldShown(ff);
            });
            if (s.key === 'role_menus' && f.key === 'style') {
              grid.querySelectorAll('[data-field]').forEach(function (c) { c.hidden = !menuFieldShown(c.getAttribute('data-field')); });
            }
          }));
          grid.append(cell);
        });
        row.append(grid);
        if (s.key === 'role_menus') row.append(menuGroups(get, put, index));
        box.append(row);
      });
      var add = el('button', 'mini add', 'Add a ' + (s.item || 'item'));
      add.type = 'button';
      add.disabled = list.length >= (s.max_items || 25);
      add.addEventListener('click', function () {
        put(clone(get() || []).concat([newItem(s)]));
        draw();
        var last = box.querySelectorAll('.item');
        if (last.length) { var first = last[last.length - 1].querySelector('input, select, textarea, button.switch'); if (first) first.focus(); }
      });
      box.append(add);
    }
    draw();
    return box;
  }

  /* ---------- making level roles (BEV creates roles named after levels) ---------- */

  var LEVEL_ERRORS = {
    bot_outdated: 'BEV needs the newest bot code before it can make level roles.',
    busy: 'BEV is already making level roles for this server. Give it a minute.',
    forbidden: 'Only this server’s administrators can do that.',
  };
  var levelJob = { timer: null, armed: null, count: 0 };

  function levelName(n) { return n >= 100 ? 'Max Level' : 'Level ' + n; }
  function levelPlan(count) {
    var seen = {};
    var out = [];
    for (var i = 1; i <= count; i++) {
      var n = Math.max(1, Math.round((i * 100) / count));
      if (!seen[n]) { seen[n] = true; out.push(n); }
    }
    return out.sort(function (a, b) { return a - b; });
  }
  function planText(levels) {
    var names = levels.map(levelName);
    return names.length <= 4 ? names.join(', ') : names[0] + ', ' + names[1] + ' … ' + names[names.length - 1];
  }

  function levelRolesBox(action) {
    var box = el('div', 'lvbox');
    box.id = 'lvroles';
    box.append(el('p', 'lvh', 'Make level roles for me'));
    box.append(el('p', 'help', 'BEV creates roles named after levels (Level 10, Level 20 … Max Level) and sets them as the level rewards below. '
      + 'You can still change or remove any of them afterwards, like any other reward.'));
    var row = el('div', 'lvrow');
    var lab = el('label', 'flabel sm', 'How many roles (1 to ' + (action.max || 100) + ')');
    lab.htmlFor = 'lvcount';
    var input = el('input', 'field lvnum');
    input.type = 'number';
    input.id = 'lvcount';
    input.min = '1';
    input.max = String(action.max || 100);
    input.step = '1';
    input.value = String(levelJob.count || (action.job && action.job.levels && action.job.levels.length) || 10);
    input.setAttribute('inputmode', 'numeric');
    var go = el('button', 'act save lvgo', 'Make 10 roles');
    go.type = 'button';
    go.id = 'lvgo';
    var cell = el('div', 'icell');
    cell.append(lab, input);
    row.append(cell, go);
    box.append(row);
    var plan = el('p', 'help lvplan');
    plan.id = 'lvplan';
    var prog = el('div', 'abar lvbar');
    prog.hidden = true;
    prog.append(el('span'));
    var status = el('p', 'note lvstatus');
    status.id = 'lvstatus';
    status.setAttribute('aria-live', 'polite');
    var fails = el('ul', 'lvfail');
    fails.hidden = true;
    box.append(plan, prog, status, fails);

    function count() {
      var n = Number(input.value);
      return Number.isInteger(n) && n >= 1 && n <= (action.max || 100) ? n : 0;
    }
    function draw(job) {
      var n = count();
      var running = !!(job && job.state === 'running');
      var dirty = ['level_rewards', 'level_rewards_stack'].some(function (k) { return !same(state.draft.settings[k], state.original.settings[k]); });
      plan.textContent = n ? 'Roles go to: ' + planText(levelPlan(n)) + '. Members keep only their latest level role.' : 'Type a number from 1 to ' + (action.max || 100) + '.';
      if (levelJob.armed !== n) disarmLevel();
      if (!go.classList.contains('armed')) go.textContent = running ? 'Making roles…' : n ? 'Make ' + n + ' role' + (n === 1 ? '' : 's') : 'Make roles';
      go.disabled = running || !n || dirty || state.saving;
      prog.hidden = !running;
      if (running) prog.firstChild.style.width = (job.total ? Math.round((job.done / job.total) * 100) : 0) + '%';
      if (running) status.textContent = 'Making roles… ' + job.done + ' of ' + job.total + ' done.';
      else if (dirty) status.textContent = 'Save or discard your changes to Level rewards first.';
      else if (job && job.finished) {
        status.textContent = '✅ Made ' + job.created + ' new role' + (job.created === 1 ? '' : 's')
          + (job.reused ? ' and used ' + job.reused + ' that already existed' : '') + '. They’re in Level rewards below.';
      } else status.textContent = '';
      fails.replaceChildren();
      ((job && job.state === 'done' && job.failed) || []).forEach(function (f) { fails.append(el('li', null, levelName(f.level) + ': ' + f.reason)); });
      fails.hidden = !fails.children.length;
    }
    function disarmLevel() {
      levelJob.armed = null;
      go.classList.remove('armed');
    }
    input.addEventListener('input', function () { draw(levelJobState()); });
    go.addEventListener('click', function () {
      var n = count();
      if (!n) return;
      if (levelJob.armed !== n) {
        levelJob.armed = n;
        go.classList.add('armed');
        go.textContent = 'Click again to make ' + n + ' role' + (n === 1 ? '' : 's');
        root.setTimeout(function () { if (levelJob.armed === n) { disarmLevel(); draw(levelJobState()); } }, 6000);
        return;
      }
      disarmLevel();
      go.disabled = true;
      levelJob.count = n;
      var guild = state.guild;
      request('/api/level-roles', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ guild_id: guild, count: n })
      }).then(function (r) {
        if (guild !== state.guild) return;
        if (r.status !== 200 || !r.data) {
          draw(levelJobState());
          status.textContent = '❌ ' + ((r.data && r.data.message) || LEVEL_ERRORS[r.data && r.data.error] || errorText(r));
          return;
        }
        setLevelJob(r.data.job);
        say('Making ' + n + ' level roles.');
        followLevelJob();
      });
    });
    box.redraw = draw;
    draw(action.job);
    if (action.job && action.job.state === 'running') root.setTimeout(followLevelJob, 0);
    return box;
  }

  function levelJobState() {
    var f = state.config && (state.config.features || []).find(function (x) { return x.key === 'leveling'; });
    var a = f && (f.actions || []).find(function (x) { return x.key === 'level_roles'; });
    return a ? a.job : null;
  }
  function setLevelJob(job) {
    var f = (state.config.features || []).find(function (x) { return x.key === 'leveling'; });
    var a = f && (f.actions || []).find(function (x) { return x.key === 'level_roles'; });
    if (a) a.job = job;
    var box = $('lvroles');
    if (box && box.redraw) box.redraw(job);
  }

  // While BEV makes the roles, check how far it got; when it's done, bring in the new rewards without touching other unsaved edits.
  function followLevelJob() {
    root.clearTimeout(levelJob.timer);
    var guild = state.guild;
    levelJob.timer = root.setTimeout(function () {
      request('/api/level-roles?guild_id=' + guild).then(function (r) {
        if (guild !== state.guild) return;
        if (r.status !== 200 || !r.data) { followLevelJob(); return; }
        setLevelJob(r.data.job);
        if (r.data.job && r.data.job.state === 'running') { followLevelJob(); return; }
        request('/api/config?guild_id=' + guild).then(function (c) {
          if (guild !== state.guild || c.status !== 200 || !c.data || !c.data.features) return;
          var fresh = valuesOf(c.data);
          state.config.roles = c.data.roles || state.config.roles;
          ['level_rewards', 'level_rewards_stack'].forEach(function (k) {
            state.original.settings[k] = clone(fresh.settings[k]);
            state.draft.settings[k] = clone(fresh.settings[k]);
          });
          (state.config.features || []).forEach(function (f) {
            (f.settings || []).forEach(function (s) { if (s.key === 'level_rewards' || s.key === 'level_rewards_stack') s.value = clone(fresh.settings[s.key]); });
          });
          var open = $('f-leveling') && $('f-leveling').querySelector('details.fset');
          var wasOpen = !!(open && open.open);
          renderBoard();
          updateDirty();
          var again = $('f-leveling') && $('f-leveling').querySelector('details.fset');
          if (again && wasOpen) again.open = true;
          say('The level roles are ready.');
        });
      });
    }, 1200);
  }

  /* ---------- the Message Designer: design a message with a live preview, then send it ---------- */

  var MSG_ERRORS = {
    bot_outdated: 'BEV needs the newest bot code before it can send designed messages.',
    forbidden: 'Only this server’s administrators can do that.',
    busy: 'BEV is busy with this server. Try again in a moment.'
  };
  var BOX_PARTS = ['author', 'title', 'description', 'image', 'thumbnail', 'footer'];
  var designer = { pick: 0, armed: null, timer: null, note: null };

  /* ---------- Message Designer: mild swearing only (the same check as the bot's b11_message_language.py) ---------- */

  var EXTREME_WORDS = [['fuck', true], ['fuk', true], ['fck', true], ['motherfuck', true], ['cunt', true], ['nigger', true], ['nigga', true], ['coon', false], ['paki', false], ['chink', false], ['gook', false], ['spic', false], ['spick', false], ['wetback', true], ['kike', false], ['raghead', true], ['towelhead', true], ['beaner', false], ['gyppo', false], ['gypo', false], ['faggot', true], ['fag', false], ['dyke', false], ['tranny', false], ['trannies', false], ['shemale', true], ['retard', false], ['retarded', false], ['spastic', false], ['spaz', false], ['rape', false], ['raped', false], ['raping', false], ['rapist', true], ['cocksucker', true], ['whore', true], ['slut', true], ['kys', false]];
  var EXTREME_PHRASES = ['kill (?:your ?self|yo ?self|ur ?self|yourselves)', 'sieg heil', 'heil hitler'];
  var LOOKALIKES = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't' };
  var EXTREME_RE = new RegExp('(?<![a-z])(?:' + EXTREME_WORDS.map(function (w) {
    return w[0].split('').map(function (c) { return c + '+'; }).join('') + (w[1] ? '[a-z]*' : '(?:e?s|z)?');
  }).join('|') + ')(?![a-z])|(?<![a-z])(?:' + EXTREME_PHRASES.join('|') + ')(?![a-z])');
  var LANGUAGE_PARTS = [['text', 'Text above the box'], ['author', 'Small heading'], ['title', 'Title'], ['description', 'Main text'],
    ['footer', 'Footer'], ['button_label', 'Button text'], ['link', 'Title link'], ['button_link', 'Button link'], ['image', 'Big picture'],
    ['thumbnail', 'Small picture']];

  function languageText(text) {
    var t = String(text || '').replace(/<(?:@[!&]?|#)\d+>|<a?:(\w+):\d+>/g, function (m, name) { return name || ' '; });
    t = t.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
    t = t.replace(/[013457@$!|+]/g, function (c) { return LOOKALIKES[c]; });
    t = t.replace(/[^a-z]+/g, ' ');
    t = t.replace(/(?<![a-z])(?:[a-z] ){2,}[a-z](?![a-z])/g, function (m) { return m.replace(/ /g, ''); });
    return t.split(' ').filter(Boolean).join(' ');
  }
  function isExtreme(text) { return EXTREME_RE.test(languageText(text)); }
  function extremeParts(t) { return LANGUAGE_PARTS.filter(function (p) { return isExtreme(t[p[0]] || ''); }).map(function (p) { return p[1]; }); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function validUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s<>"]{3,495}$/.test(u.trim()); }
  function validColour(c) { var m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? '#' + m[1].toUpperCase() : null; }
  function hasBox(t) { return BOX_PARTS.some(function (k) { return String(t[k] || '').trim(); }); }
  function boxLength(t) { return ['author', 'title', 'description', 'footer'].reduce(function (n, k) { return n + String(t[k] || '').length; }, 0); }
  var pvNames = {};          // names for the members, roles and channels a preview mentions (from the bot)
  function nameFor(kind, id) {
    var list = state.config ? (kind === 'role' ? state.config.roles : state.config.channels) : null;
    var found = (list || []).find(function (x) { return x.id === id; });
    if (found) return found.name;
    var extra = kind === 'role' ? (pvNames.roles || {})[id] : (pvNames.channels || {})[id];
    if (extra) return typeof extra === 'string' ? extra : extra.name;
    return kind === 'role' ? 'deleted-role' : 'deleted-channel';
  }

  // Discord-style formatting for the preview. Everything is escaped first, so only these tags can appear.
  function inlineMd(s) {
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]\n]{1,256})\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>').replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/\|\|([^|\n]+)\|\|/g, '<span class="mspoil">$1</span>');
    s = s.replace(/&lt;@&amp;(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">@' + esc(nameFor('role', id)) + '</span>'; })
      .replace(/&lt;#(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">#' + esc(nameFor('channel', id)) + '</span>'; })
      .replace(/&lt;@!?(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">@' + esc((pvNames.users || {})[id] || 'member') + '</span>'; })
      .replace(/(^|[^\w])@(everyone|here)\b/g, '$1<span class="dmention">@$2</span>')
      .replace(/\u2063@([^\u2063<\n]{1,64})\u2063/g, '<span class="dmention">@$1</span>');   // a person named in a preview, shown like a mention
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }

  function mdToHtml(text) {
    var out = [];
    var list = null;
    var code = null;
    function closeList() { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } }
    esc(text || '').split('\n').forEach(function (line) {
      if (/^```/.test(line)) {
        if (code) { out.push('<pre><code>' + code.join('\n') + '</code></pre>'); code = null; } else { closeList(); code = []; }
        return;
      }
      if (code) { code.push(line); return; }
      var m = /^[-*] (.+)$/.exec(line);
      if (m) { (list = list || []).push('<li>' + inlineMd(m[1]) + '</li>'); return; }
      closeList();
      if ((m = /^(#{1,3}) (.+)$/.exec(line))) { out.push('<p class="mh' + m[1].length + '">' + inlineMd(m[2]) + '</p>'); return; }
      if ((m = /^-# (.+)$/.exec(line))) { out.push('<p class="msub">' + inlineMd(m[1]) + '</p>'); return; }
      if ((m = /^&gt; ?(.*)$/.exec(line))) { out.push('<p class="mquote">' + (inlineMd(m[1]) || '&#8203;') + '</p>'); return; }
      out.push('<p>' + (inlineMd(line) || '&#8203;') + '</p>');
    });
    if (code) out.push('<pre><code>' + code.join('\n') + '</code></pre>');
    closeList();
    return out.join('');
  }

  function pingLead(t) {
    if (t.ping === 'here' || t.ping === 'everyone') return '@' + t.ping;
    if (t.ping === 'role' && t.ping_role) {
      var ids = Array.isArray(t.ping_role) ? t.ping_role : [t.ping_role];
      return ids.filter(Boolean).map(function (id) { return '@' + nameFor('role', String(id)); }).join(' ');
    }
    return '';
  }

  function pictureNode(url, cls) {
    var img = el('img', cls);
    img.src = url.trim();
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () { img.replaceWith(el('span', cls + ' mbroken', 'This picture couldn’t be loaded. Check the link.')); });
    return img;
  }


  /* ---------- Message Designer: Advanced (JSON) ---------- */
  var JSON_STYLES = { primary: 1, blue: 1, secondary: 2, grey: 2, gray: 2, success: 3, green: 3, danger: 4, red: 4 };
  function jsonMessage(t) {
    var data;
    try { data = JSON.parse(String(t.json || '')); } catch (e) { return { error: 'That isn’t valid JSON yet: ' + e.message }; }
    if (data && Array.isArray(data.messages) && data.messages.length) data = (data.messages[0] || {}).data || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'The JSON must be an object, starting with {' };
    var embeds = Array.isArray(data.embeds) ? data.embeds : data.embed ? [data.embed] : [];
    if (embeds.length > 10) return { error: 'A message can have up to 10 boxes.' };
    var out = { where: t.channel ? '#' + nameFor('channel', t.channel) : 'No channel picked yet', content: String(data.content || ''), embeds: [], components: [] };
    var lead = pingLead(t);
    if (lead) out.content = lead + (out.content ? ' ' + out.content : '');
    embeds.forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var c = e.color != null ? e.color : e.colour;
      var colour = typeof c === 'number' ? c : validColour(c) ? parseInt(validColour(c).slice(1), 16) : parseInt((validColour(t.color) || '#2563EB').slice(1), 16);
      var pic = function (v) { return typeof v === 'string' ? { url: v } : v || undefined; };
      out.embeds.push({ title: e.title, description: e.description, url: e.url, color: colour,
        author: typeof e.author === 'string' ? { name: e.author } : e.author, footer: typeof e.footer === 'string' ? { text: e.footer } : e.footer,
        image: pic(e.image), thumbnail: pic(e.thumbnail), fields: Array.isArray(e.fields) ? e.fields : [] });
    });
    (Array.isArray(data.components) ? data.components : []).slice(0, 5).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      if (r.type === 'select' || r.type === 'dropdown' || r.type === 'menu' || r.type === 3 || Array.isArray(r.options)) {
        out.components.push({ type: 1, components: [{ type: 3, placeholder: r.placeholder || 'Choose…' }] });
        return;
      }
      var buttons = (r.buttons || r.components || []).map(function (b) {
        return { type: 2, label: b.label, emoji: typeof b.emoji === 'string' ? { name: b.emoji } : b.emoji, style: b.url ? 5 : (typeof b.style === 'number' ? b.style : JSON_STYLES[String(b.style || 'secondary').toLowerCase()] || 2) };
      });
      out.components.push({ type: 1, components: buttons });
    });
    if (!out.content && !out.embeds.length) return { error: 'Add some content or at least one box.' };
    return out;
  }
  function jsonExample(t) {
    var e = {};
    if (String(t.title || '').trim()) e.title = t.title;
    if (String(t.description || '').trim()) e.description = t.description;
    if (validColour(t.color)) e.color = validColour(t.color);
    if (String(t.author || '').trim()) e.author = { name: t.author };
    if (String(t.footer || '').trim()) e.footer = { text: t.footer };
    if (validUrl(t.image)) e.image = { url: t.image.trim() };
    if (validUrl(t.thumbnail)) e.thumbnail = { url: t.thumbnail.trim() };
    if (!Object.keys(e).length) { e.title = 'Welcome!'; e.description = 'Pick your roles below.'; e.color = '#2563EB'; e.fields = [{ name: 'Rules', value: 'Be kind', inline: true }]; }
    var rows = [{ type: 'buttons', buttons: [{ label: 'Say hi', emoji: '👋', style: 'primary', reply: 'Hello! 👋' }] }];
    if (String(t.button_label || '').trim() && validUrl(t.button_link)) rows[0].buttons.unshift({ label: t.button_label, url: t.button_link.trim() });
    rows.push({ type: 'select', placeholder: 'Pick a role', options: [{ label: 'Pings', role: 'ROLE_ID_HERE', mode: 'toggle' }, { label: 'Info', reply: 'Some info just for you.' }] });
    return JSON.stringify({ content: String(t.text || ''), embeds: [e], components: rows }, null, 2);
  }

  function messagePreview(t) {
    if (t.mode === 'json') {
      var jm = jsonMessage(t);
      if (jm.error) { var bad = el('div', 'dprev mprev'); bad.append(el('p', 'mempty', '⚠️ ' + jm.error)); return bad; }
      var shown = previewMessage(jm, '');
      var w = shown.querySelector('.pvwhere'); if (w) w.remove();
      return shown;
    }
    var wrap = el('div', 'dprev mprev');
    var av = el('img', 'dav');
    av.src = '/bev-avatar.png'; av.alt = ''; av.width = 40; av.height = 40;
    var body = el('div', 'dbody');
    var head = el('p', 'dhead');
    var now = new Date();
    head.append(el('b', null, 'BEV'), ' ', el('span', 'dapp', 'APP'), ' ',
      el('span', 'dtime', 'Today at ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')));
    body.append(head);
    var lead = pingLead(t);
    var text = String(t.text || '').trim();
    if (lead || text) {
      var content = el('div', 'mtext mcontent');
      var html = text ? mdToHtml(text) : '';
      if (lead) {
        var chip = '<span class="dmention">' + esc(lead) + '</span> ';
        html = html.indexOf('<p>') === 0 ? '<p>' + chip + html.slice(3) : '<p>' + chip + '</p>' + html;
      }
      content.innerHTML = html;
      body.append(content);
    }
    if (hasBox(t)) {
      var box = el('div', 'dembed membed');
      box.style.borderLeftColor = validColour(t.color) || '#2563EB';
      var main = el('div', 'mmain');
      if (String(t.author || '').trim()) main.append(el('p', 'mauthor', t.author));
      if (String(t.title || '').trim()) {
        var title = el('p', 'dtitle');
        if (validUrl(t.link)) {
          var a = el('a', null, t.title);
          a.href = t.link.trim(); a.target = '_blank'; a.rel = 'noopener noreferrer';
          title.append(a);
        } else title.textContent = t.title;
        main.append(title);
      }
      if (String(t.description || '').trim()) {
        var d = el('div', 'mtext mdesc');
        d.innerHTML = mdToHtml(t.description);
        main.append(d);
      }
      if (validUrl(t.image)) main.append(pictureNode(t.image, 'mimage'));
      if (String(t.footer || '').trim()) main.append(el('p', 'dfoot', t.footer));
      box.append(main);
      if (validUrl(t.thumbnail)) box.append(pictureNode(t.thumbnail, 'mthumb'));
      body.append(box);
    }
    if (String(t.button_label || '').trim() && validUrl(t.button_link)) {
      var row = el('div', 'mbtns');
      var b = el('a', 'mbtn', t.button_label);
      b.href = t.button_link.trim(); b.target = '_blank'; b.rel = 'noopener noreferrer';
      b.append(el('span', 'mext', '↗'));
      row.append(b);
      body.append(row);
    }
    if (!lead && !text && !hasBox(t)) body.append(el('p', 'mempty', 'Nothing to show yet. Write some text or fill in the box.'));
    wrap.append(av, body);
    return wrap;
  }

  /* ---------- Preview buttons: what a feature posts, drawn like Discord. Nothing is sent. ---------- */
  function previewButton(f) {
    var btn = el('button', 'mini abtn pvbtn', '👀 Preview');
    btn.type = 'button';
    btn.setAttribute('data-preview', f.key);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.title = 'See what ' + f.name + ' posts, using the settings on this card. Nothing is sent.';
    btn.addEventListener('click', function () { openPreview(f); });
    return btn;
  }

  function cardDraft(f) {
    var out = {};
    var changed = false;
    (f.settings || []).forEach(function (s) {
      if (!state.draft || !Object.prototype.hasOwnProperty.call(state.draft.settings, s.key)) return;
      out[s.key] = state.draft.settings[s.key];
      if (state.original && !same(state.draft.settings[s.key], state.original.settings[s.key])) changed = true;
    });
    return { values: out, changed: changed };
  }

  function openPreview(f) {
    var draft = cardDraft(f);
    var d = el('dialog', 'askbox pvbox');
    var hid = 'pv-' + (++formCount);
    d.setAttribute('aria-labelledby', hid);
    var h = el('h2', 'disp', '👀 Preview: ' + f.name);
    h.id = hid;
    var close = el('button', 'mini pvclose', '✕');
    close.type = 'button';
    close.id = 'pvclose';
    close.setAttribute('aria-label', 'Close the preview');
    var top = el('div', 'pvtop');
    top.append(h, close);
    var sub = el('p', 'pvsub', 'This is how BEV’s messages will look' + (draft.changed ? ', including the changes you haven’t saved yet' : '') +
      '. Nothing is sent and nobody is pinged.');
    var body = el('div', 'pvlist');
    body.setAttribute('aria-live', 'polite');
    body.append(el('p', 'pvwait', 'Building the preview…'));
    d.append(top, sub, body);
    function done() { if (d.open) d.close(); d.remove(); }
    close.addEventListener('click', done);
    d.addEventListener('cancel', function (e) { e.preventDefault(); done(); });
    d.addEventListener('click', function (e) { if (e.target === d) done(); });
    doc.body.append(d);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    close.focus();
    var guild = state.guild;
    request('/api/preview', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: guild, feature: f.key, draft: draft.values })
    }).then(function (r) {
      body.replaceChildren();
      if (!(r.status === 200 && r.data && Array.isArray(r.data.items))) {
        body.append(el('p', 'fnote no', (r.data && r.data.message) || errorText(r)));
        return;
      }
      pvNames = r.data.names || {};
      (r.data.notes || []).forEach(function (n) { body.append(el('p', 'fnote', '⚠️ ' + n)); });
      r.data.items.forEach(function (item) {
        var sec = el('section', 'pvitem');
        sec.setAttribute('data-item', item.key);
        sec.append(el('h3', 'pvh', item.label));
        if (item.note) sec.append(el('p', 'pvnote', item.note));
        (item.messages || []).forEach(function (m) { sec.append(previewMessage(m, item.label)); });
        if (!(item.messages || []).length && !item.note) sec.append(el('p', 'pvnote', 'Nothing to show yet.'));
        body.append(sec);
      });
    });
  }

  // A picture in a preview: one that can't load (an expired avatar link, say) is just left out.
  function pvPicture(url, cls) {
    var img = el('img', cls);
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () { img.remove(); });
    return img;
  }

  function colourHex(n) {
    return typeof n === 'number' && n > 0 ? '#' + ('000000' + n.toString(16)).slice(-6) : '';
  }

  function emojiText(e) {
    if (!e) return '';
    return e.id ? ':' + (e.name || 'emoji') + ':' : (e.name || '');
  }

  function fileUrl(url, files) {
    if (typeof url !== 'string') return '';
    if (url.indexOf('attachment://') === 0) {
      var name = url.slice(13);
      var f = (files || []).find(function (x) { return x.name === name && x.data; });
      return f ? f.data : '';
    }
    return /^https:\/\//.test(url) ? url : '';
  }

  function textBlock(text, cls) {
    var d = el('div', 'mtext' + (cls ? ' ' + cls : ''));
    d.innerHTML = mdToHtml(text || '');
    return d;
  }

  function embedNode(e, files, used) {
    var box = el('div', 'dembed membed pvembed');
    box.style.borderLeftColor = colourHex(e.color) || '#1E1F22';
    var main = el('div', 'mmain');
    if (e.author && e.author.name) {
      var au = el('p', 'mauthor pvauthor');
      var aicon = fileUrl(e.author.icon_url, files);
      if (aicon) { var ai = pvPicture(aicon, 'pvaicon'); au.append(ai); }
      au.append(doc.createTextNode(e.author.name));
      main.append(au);
    }
    if (e.title) {
      var t = el('div', 'dtitle');
      if (e.url && /^https:\/\//.test(e.url)) {
        var a = el('a', null, e.title);
        a.href = e.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        t.append(a);
      } else t.innerHTML = mdToHtml(e.title).replace(/^<p>|<\/p>$/g, '');
      main.append(t);
    }
    if (e.description) main.append(textBlock(e.description, 'mdesc'));
    if (Array.isArray(e.fields) && e.fields.length) {
      var grid = el('div', 'pvfields');
      e.fields.forEach(function (fd) {
        var cell = el('div', 'pvfield' + (fd.inline ? ' inline' : ''));
        var name = el('div', 'pvfname');
        name.innerHTML = mdToHtml(fd.name || '').replace(/^<p>|<\/p>$/g, '');
        cell.append(name, textBlock(fd.value || ''));
        grid.append(cell);
      });
      main.append(grid);
    }
    var img = e.image && fileUrl(e.image.url, files);
    if (img) { main.append(pvPicture(img, 'mimage')); used[e.image.url] = true; }
    if ((e.footer && e.footer.text) || e.timestamp) {
      var parts = [];
      if (e.footer && e.footer.text) parts.push(e.footer.text);
      if (e.timestamp) parts.push('Today at ' + new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      main.append(el('p', 'dfoot', parts.join(' • ')));
    }
    box.append(main);
    var th = e.thumbnail && fileUrl(e.thumbnail.url, files);
    if (th) { box.append(pvPicture(th, 'mthumb')); used[e.thumbnail.url] = true; }
    return box;
  }

  var BUTTON_STYLES = { 1: 'blurple', 2: 'grey', 3: 'green', 4: 'red', 5: 'grey', 6: 'blurple' };
  function componentNode(c, files) {
    if (!c || typeof c !== 'object') return null;
    var node;
    switch (c.type) {
      case 1:
        node = el('div', 'mbtns pvrow');
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) node.append(n); });
        return node;
      case 2:
        node = el('span', 'mbtn pvb ' + (BUTTON_STYLES[c.style] || 'grey') + (c.disabled ? ' off' : ''));
        if (c.emoji) node.append(el('span', 'pvemoji', emojiText(c.emoji)));
        if (c.label) node.append(el('span', null, c.label));
        if (c.style === 5) node.append(el('span', 'mext', '↗'));
        return node;
      case 3: case 5: case 6: case 7: case 8:
        node = el('div', 'pvselect' + (c.disabled ? ' off' : ''));
        node.append(el('span', null, c.placeholder || 'Make a selection'), el('span', 'pvcaret', '⌄'));
        return node;
      case 9:
        node = el('div', 'pvsection');
        var texts = el('div', 'pvstext');
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) texts.append(n); });
        node.append(texts);
        var acc = componentNode(c.accessory, files);
        if (acc) { acc.classList.add('pvacc'); node.append(acc); }
        return node;
      case 10:
        return textBlock(c.content || '', 'pvtext');
      case 11:
        var u = fileUrl(c.media && c.media.url, files);
        return u ? pvPicture(u, 'mthumb') : null;
      case 12:
        node = el('div', 'pvgallery');
        (c.items || []).forEach(function (it) { var g = fileUrl(it.media && it.media.url, files); if (g) node.append(pvPicture(g, 'mimage')); });
        return node;
      case 14:
        return el('div', c.divider === false ? 'pvgap' : 'pvsep');
      case 17:
        node = el('div', 'pvcont');
        var ac = colourHex(c.accent_color);
        if (ac) node.style.borderLeftColor = ac;
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) node.append(n); });
        return node;
      default:
        return null;
    }
  }

  function previewMessage(m, itemLabel) {
    var outer = el('div', 'pvmsg');
    var where = el('p', 'pvwhere');
    var w = String(m.where || '');
    var isChannel = w.charAt(0) === '#';
    where.append(el('span', 'pvpin', isChannel ? '#' : w.indexOf('DM to') === 0 ? '✉️' : '⚠️'), ' ', doc.createTextNode(isChannel ? w.slice(1) : w));
    if (m.label && m.label !== itemLabel) where.append(el('span', 'pvlabel', m.label));
    outer.append(where);
    var wrap = el('div', 'dprev mprev pvprev');
    var av = el('img', 'dav');
    av.src = '/bev-avatar.png'; av.alt = ''; av.width = 40; av.height = 40;
    var body = el('div', 'dbody');
    if (m.reply) body.append(el('p', 'pvreply', '↪ Replying to a member’s message'));
    var head = el('p', 'dhead');
    var now = new Date();
    head.append(el('b', null, 'BEV'), ' ', el('span', 'dapp', 'APP'), ' ',
      el('span', 'dtime', 'Today at ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')));
    body.append(head);
    if (m.content) body.append(textBlock(m.content, 'mcontent'));
    var used = {};
    (m.embeds || []).forEach(function (e) { body.append(embedNode(e, m.files, used)); });
    (m.components || []).forEach(function (c) { var n = componentNode(c, m.files); if (n) body.append(n); });
    (m.files || []).forEach(function (f) {
      if (used['attachment://' + f.name]) return;
      if (f.data) body.append(pvPicture(f.data, 'mimage'));
      else body.append(el('p', 'pvfile', '📎 ' + f.name));
    });
    if ((m.reactions || []).length) {
      var rr = el('div', 'pvreacts');
      m.reactions.forEach(function (r) { rr.append(el('span', 'pvreact', r + ' 1')); });
      body.append(rr);
    }
    wrap.append(av, body);
    outer.append(wrap);
    var notes = [];
    if ((m.pings || []).length) {
      notes.push('🔔 Pings ' + m.pings.map(function (p) {
        var x = /^<@&(\d+)>$/.exec(p); if (x) return '@' + nameFor('role', x[1]);
        x = /^<@!?(\d+)>$/.exec(p); if (x) return '@' + ((pvNames.users || {})[x[1]] || 'member');
        return p;
      }).join(', '));
    }
    if (m.deletes) notes.push('🧹 Deletes itself after a few seconds');
    if (notes.length) outer.append(el('p', 'pvmeta', notes.join('   ·   ')));
    return outer;
  }

  function designerBox(f, s) {
    var wrap = el('div', 'fld designerwrap');
    wrap.setAttribute('data-key', s.key);
    var box = el('div', 'designer');
    box.id = 'designer';
    var err = el('p', 'ferr');
    err.hidden = true;
    wrap.append(box, err);
    var fields = {};
    (s.fields || []).forEach(function (x) { fields[x.key] = x; });

    function list() { return state.draft.settings[s.key] || []; }
    function current() { return list()[designer.pick] || null; }
    function action() { return (f.actions || []).find(function (a) { return a && a.key === 'send_message'; }) || null; }
    function posted(t) { var a = action(); return t && t.id && a && a.posted ? a.posted[t.id] || null : null; }
    function putField(key, value) {
      var now = clone(list());
      if (!now[designer.pick]) return;
      now[designer.pick][key] = value;
      designer.note = null;
      disarm();
      set(s.key, now);          // redraws the preview (through updateDirty)
      if (key === 'name') drawTabs();
      if (key === 'ping') { var role = form.querySelector('.mrole'); if (role) role.hidden = value !== 'role'; }
    }
    function cell(key, extra) {
      var fld = fields[key];
      var c = el('div', 'icell k-' + fld.kind + (extra ? ' ' + extra : ''));
      var id = 'm-' + key;
      var lab = el('label', 'flabel sm', fld.label);
      lab.htmlFor = id;
      c.append(lab);
      if (key === 'color') {
        var pair = el('div', 'mcolour');
        var picker = el('input', 'mswatch');
        picker.type = 'color';
        picker.id = id;
        picker.setAttribute('aria-label', 'Pick a colour');
        var code = el('input', 'field mcode');
        code.type = 'text'; code.maxLength = 7; code.placeholder = '#2563EB';
        code.setAttribute('aria-label', 'Colour code');
        code.value = current().color || '';
        picker.value = (validColour(current().color) || '#2563EB').toLowerCase();
        picker.addEventListener('input', function () { code.value = picker.value.toUpperCase(); putField('color', code.value); });
        code.addEventListener('input', function () { var v = validColour(code.value); if (v) picker.value = v.toLowerCase(); putField('color', code.value.trim()); });
        pair.append(picker, code);
        c.append(pair);
        return c;
      }
      c.append(control(fld, id, function () { return (current() || {})[key]; }, function (v) { putField(key, v); }));
      return c;
    }
    function group(title, keys) {
      var g = el('fieldset', 'mgroup');
      g.append(el('legend', null, title));
      var grid = el('div', 'igrid');
      keys.forEach(function (k) { if (k) grid.append(cell(k[0], k[1])); });
      g.append(grid);
      return g;
    }

    var tabs = el('div', 'mtabs');
    var form = el('div', 'mform');
    var side = el('div', 'mside');
    var grid = el('div', 'mgrid');
    grid.append(form, side);

    function drawTabs() {
      tabs.replaceChildren();
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Your messages');
      var items = list();
      items.forEach(function (t, i) {
        var b = el('button', 'mtab' + (i === designer.pick ? ' on' : ''), String(t.name || '').trim() || 'Message ' + (i + 1));
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', i === designer.pick ? 'true' : 'false');
        b.addEventListener('click', function () { designer.pick = i; designer.note = null; disarm(); draw(); });
        tabs.append(b);
      });
      var add = el('button', 'mini add mnew', 'New message');
      add.type = 'button';
      add.disabled = items.length >= (s.max_items || 10);
      add.addEventListener('click', function () {
        var now = clone(list()).concat([newItem(s)]);
        set(s.key, now);
        designer.pick = now.length - 1;
        designer.note = null;
        draw();
        var first = form.querySelector('input, textarea');
        if (first) first.focus();
      });
      tabs.append(add);
    }

    function drawForm() {
      form.replaceChildren();
      var t = current();
      if (!t) return;
      form.append(group('Where it goes', [['name'], ['channel'], ['ping'], ['ping_role', 'mrole']]));
      form.querySelector('.mrole').hidden = t.ping !== 'role';
      var seg = el('div', 'seg mmode');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Message type');
      [['simple', 'Simple'], ['json', 'Advanced (JSON)']].forEach(function (o) {
        var b = el('button', null, o[1]);
        b.type = 'button';
        b.setAttribute('data-mode', o[0]);
        b.setAttribute('aria-pressed', (t.mode === 'json' ? 'json' : 'simple') === o[0] ? 'true' : 'false');
        b.addEventListener('click', function () {
          if ((current().mode === 'json' ? 'json' : 'simple') === o[0]) return;
          if (o[0] === 'json' && !String(current().json || '').trim()) putField('json', jsonExample(current()));
          putField('mode', o[0]);
          drawForm();
        });
        seg.append(b);
      });
      form.append(seg);
      if (t.mode === 'json') {
        var jg = group('Advanced message', [['json', 'wide mjson']]);
        var help = el('p', 'help');
        help.innerHTML = 'Up to 10 boxes (<code>embeds</code>) with <code>fields</code>, plus up to 5 rows in <code>components</code>: a row of up to 5 <code>buttons</code>, or a <code>select</code> dropdown with up to 25 <code>options</code>. A button opens a <code>url</code>, or gives a <code>role</code> (<code>mode</code>: give, take or toggle) and/or sends a private <code>reply</code>. Dropdown options give roles or reply. JSON from Discohook works too.';
        jg.append(help);
        form.append(jg);
        var ta = form.querySelector('#m-json');
        if (ta) { ta.spellcheck = false; ta.classList.add('mono'); ta.rows = 18; }
      } else {
        form.append(group('Text above the box', [['text', 'wide']]));
      form.append(group('The box', [['color'], ['author'], ['title'], ['link'], ['description', 'wide'], ['image'], ['thumbnail'], ['footer', 'wide']]));
          form.append(group('Button (optional)', [['button_label'], ['button_link']]));
      }
      var remove = el('button', 'mini danger', 'Delete this message');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        var now = clone(list());
        now.splice(designer.pick, 1);
        set(s.key, now);
        designer.pick = Math.max(0, designer.pick - 1);
        draw();
      });
      form.append(remove);
    }

    function disarm() {
      designer.armed = null;
      root.clearTimeout(designer.timer);
    }

    function drawSide() {
      side.replaceChildren();
      var t = current();
      if (!t) return;
      side.append(el('p', 'mlab', 'Preview'));
      side.append(messagePreview(t));
      var n = boxLength(t);
      var count = el('p', 'help mcount' + (n > 6000 ? ' over' : ''), 'Box: ' + n.toLocaleString('en-GB') + ' of 6,000 characters');
      if (t.mode !== 'json') side.append(count);
      var dirty = !same(state.draft.settings[s.key], state.original.settings[s.key]);
      var on = state.original.features[f.key] === true;
      var channel = t.channel ? nameFor('channel', t.channel) : null;
      var post = posted(t);
      var acts = el('div', 'row mact');
      var send = el('button', 'act save msend', designer.armed === 'send' ? 'Click again to send in #' + channel : channel ? 'Send in #' + channel : 'Send');
      send.type = 'button';
      send.id = 'msend';
      var update = el('button', 'mini mupdate', designer.armed === 'update' ? 'Click again to update it' : 'Update the copy sent before');
      update.type = 'button';
      update.id = 'mupdate';
      var rude = extremeParts(t);
      var blocked = dirty || !on || !t.id || state.saving || rude.length > 0;
      send.disabled = blocked || !channel;
      update.disabled = blocked || !post;
      if (designer.armed === 'send') send.classList.add('armed');
      if (designer.armed === 'update') update.classList.add('armed');
      send.addEventListener('click', function () { go('send'); });
      update.addEventListener('click', function () { go('update'); });
      acts.append(send);
      if (post) acts.append(' ', update);
      side.append(acts);
      var status = el('p', 'note mstatus');
      status.id = 'mstatus';
      status.setAttribute('aria-live', 'polite');
      if (rude.length) {
        status.textContent = '⛔ BEV won’t send this: it has strong swearing, a slur or a threat in ' + rude.join(', ') + '. Mild words like damn or crap are fine.';
        status.classList.add('mrude');
      } else if (designer.note) status.textContent = designer.note;
      else if (dirty || !t.id) status.textContent = 'Save your changes first, then you can send this version.';
      else if (!on) status.textContent = 'Switch the Message Designer on and save, then you can send it.';
      else if (!channel) status.textContent = 'Pick a channel in Where it goes.';
      side.append(status);
      if (post) {
        var where = el('p', 'help msent');
        where.append('Last sent in #' + (post.channel_name || 'a deleted channel') + (post.at ? ', ' + new Date(post.at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '') + '. ');
        if (/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(post.url || '')) {
          var open = el('a', 'inl', 'Open in Discord');
          open.href = post.url; open.target = '_blank'; open.rel = 'noopener noreferrer';
          where.append(open);
        }
        side.append(where);
      }
    }

    function go(mode) {
      var t = current();
      if (!t || !t.id) return;
      if (designer.armed !== mode) {
        designer.armed = mode;
        drawSide();
        root.clearTimeout(designer.timer);
        designer.timer = root.setTimeout(function () { if (designer.armed === mode) { disarm(); drawSide(); } }, 6000);
        return;
      }
      disarm();
      var guild = state.guild;
      designer.note = mode === 'send' ? 'Sending…' : 'Updating…';
      drawSide();
      side.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      request('/api/messages', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ guild_id: guild, template_id: t.id, mode: mode })
      }).then(function (r) {
        if (guild !== state.guild) return;
        if (r.status === 200 && r.data && r.data.ok) {
          var a = action();
          if (a) { a.posted = a.posted || {}; a.posted[t.id] = r.data.posted || null; }
          var where = r.data.posted && r.data.posted.channel_name ? ' in #' + r.data.posted.channel_name : '';
          designer.note = mode === 'send' ? '✅ Sent' + where + '.' : '✅ Updated' + where + '.';
          say(designer.note);
        } else {
          designer.note = '❌ ' + ((r.data && r.data.message) || MSG_ERRORS[r.data && r.data.error] || errorText(r));
        }
        drawSide();
      });
    }

    function draw() {
      box.replaceChildren();
      drawTabs();
      box.append(tabs);
      if (!list().length) {
        box.append(el('p', 'empty', 'No messages yet. Press New message to design one. You’ll see exactly how it looks while you type.'));
        return;
      }
      if (designer.pick >= list().length) designer.pick = list().length - 1;
      drawForm();
      drawSide();
      box.append(grid);
    }
    box.redraw = function () { drawSide(); };
    draw();
    return wrap;
  }

  /* ---------- unsaved changes, counts and search ---------- */

  function featureKeysChanged() {
    var diff = changes(state.original, state.draft);
    var keys = {};
    Object.keys(diff.features).forEach(function (k) { keys[k] = true; });
    (state.config.features || []).forEach(function (f) {
      (f.settings || []).forEach(function (s) { if (s.key in diff.settings) keys[f.key] = true; });
    });
    return { diff: diff, keys: keys };
  }

  function updateDirty() {
    if (!state.config) return;
    var info = featureKeysChanged();
    var n = info.diff.count;
    // A dismissed bar comes back as soon as there's a change it hasn't shown yet.
    if (state.dismissed !== null && n && JSON.stringify(info.diff) !== state.dismissed) undismiss();
    if (n && !state.barWanted) { state.barWanted = true; showBar(); }
    $('dirty').textContent = n ? n + ' unsaved change' + (n === 1 ? '' : 's') + ' for ' + state.config.guild.name : 'No changes yet. Everything is saved.';
    $('save').disabled = !n || state.saving;
    $('discard').disabled = !n || state.saving;
    $('savebar').classList.toggle('busy', n > 0);
    doc.querySelectorAll('.feat').forEach(function (card) {
      card.classList.toggle('changed', !!info.keys[card.getAttribute('data-key')]);
      if (card.redrawGone) card.redrawGone();
    });
    doc.querySelectorAll('.allbtn').forEach(function (b) { if (b.redraw) b.redraw(); });
    var lv = $('lvroles');
    if (lv && lv.redraw) lv.redraw(levelJobState());
    var md = $('designer');
    if (md && md.redraw) md.redraw();
    updateCounts();
  }

  function updateCounts() {
    var config = state.config;
    var on = 0;
    (config.categories || []).forEach(function (cat) {
      var feats = config.features.filter(function (f) { return f.category === cat.key; });
      var n = feats.filter(function (f) { return state.draft.features[f.key]; }).length;
      on += n;
      var stat = $('n-' + cat.key);
      if (stat) { stat.textContent = n + ' of ' + feats.length + ' on'; stat.className = 'stat' + (n ? ' here' : ''); }
    });
    $('oncount').textContent = on + ' of ' + config.features.length + ' features on';
  }

  function openKey() { return 'bev_open_' + (state.guild || ''); }
  function openCards() {
    try { return JSON.parse(root.localStorage.getItem(openKey()) || '{}') || {}; } catch (e) { return {}; }
  }
  function storeOpenCards(open) {
    try { root.localStorage.setItem(openKey(), JSON.stringify(open)); } catch (e) { /* private window: just not remembered */ }
  }

  // The search also finds single settings: a card whose setting matches opens its settings and that setting is highlighted.
  function findSettings(words) {
    doc.querySelectorAll('.fld.findhit').forEach(function (f) { f.classList.remove('findhit'); });
    doc.querySelectorAll('details.fset[data-findopen]').forEach(function (d) { d.removeAttribute('data-findopen'); var card = d.closest('.feat'); d.open = !!(card && openCards()[card.getAttribute('data-key')]); });
    var q = words.join(' ');
    if (q.length < 3) return [];
    var hits = [];
    doc.querySelectorAll('.feat:not([hidden]) .fld').forEach(function (f) {
      var label = f.querySelector('.flabel');
      var text = ((label ? label.textContent : '') + ' ' + ((f.querySelector('.help') || {}).textContent || '')).toLowerCase();
      if (!words.every(function (w) { return text.indexOf(w) !== -1; })) return;
      f.classList.add('findhit');
      hits.push(f);
      var d = f.closest('details.fset');
      if (d && !d.open && hits.length <= 24) { d.setAttribute('data-findopen', ''); d.open = true; }
    });
    return hits;
  }

  function applyFind() {
    var words = $('find').value.toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    doc.querySelectorAll('.dsec').forEach(function (sec) {
      var visible = 0;
      sec.querySelectorAll('.feat').forEach(function (card) {
        var text = card.getAttribute('data-search') || '';
        var ok = words.every(function (w) { return text.indexOf(w) !== -1; });
        card.hidden = !ok;
        if (ok) visible++;
      });
      sec.hidden = visible === 0;
      shown += visible;
    });
    $('nofind').hidden = shown !== 0;
    var hits = findSettings(words);
    $('find').setAttribute('data-hits', String(hits.length));
  }

  function markProblems() {
    doc.querySelectorAll('.fld').forEach(function (f) {
      var key = f.getAttribute('data-key');
      var err = f.querySelector('.ferr');
      var msg = problems[key];
      f.classList.toggle('bad', !!msg);
      if (err) { err.hidden = !msg; err.textContent = msg || ''; }
    });
  }

  /* ---------- saving ---------- */

  function showNotes(lines, good) {
    var list = $('notes');
    list.replaceChildren();
    lines.slice(0, 50).forEach(function (line) { list.append(el('li', null, line)); });
    list.hidden = !lines.length;
    list.scrollTop = 0;
    // A list long enough to scroll can be scrolled with the keyboard too, and fades at the bottom while there's more.
    if (list.scrollHeight > list.clientHeight + 1) list.setAttribute('tabindex', '0'); else list.removeAttribute('tabindex');
    notesFade();
    $('savebar').classList.toggle('ok', !!good);
    $('savebar').classList.toggle('no', good === false);
  }

  /* ---------- hiding the save bar ---------- */

  function dismiss() {
    state.dismissed = JSON.stringify(changes(state.original, state.draft));
    $('savebar').hidden = true;
    say('Save bar hidden. It comes back when you change something.');
  }

  function undismiss() {
    state.dismissed = null;
    state.barWanted = true;
    showBar();
  }

  function notesFade() {
    var list = $('notes');
    list.classList.toggle('more', list.scrollHeight - list.scrollTop - list.clientHeight > 2);
  }

  // Scrolling over the save results scrolls only them: at the top or bottom of the list the page stays put.
  // (Browsers with overscroll-behavior already do this; this covers the rest.)
  function keepScrollInNotes(e) {
    var list = $('notes');
    if (list.scrollHeight <= list.clientHeight + 1) return;
    var atTop = list.scrollTop <= 0;
    var atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atEnd)) e.preventDefault();
  }

  function save() {
    var diff = changes(state.original, state.draft);
    if (!diff.count || state.saving) return;
    var gone = deletions(diff);
    if (gone.length) {
      var shown = gone.slice(0, 12).map(function (line) { return '• ' + (line.length > 180 ? line.slice(0, 179) + '…' : line); });
      if (gone.length > 12) shown.push('…and ' + (gone.length - 12) + ' more features');
      if (!root.confirm('Saving deletes these channels, categories and roles that BEV made:\n\n' + shown.join('\n') +
          '\n\nThis can’t be undone. Press OK to save and delete them.\nTo keep them, press Cancel and tick “Keep them instead” on the feature.')) {
        say('Nothing was saved.');
        return;
      }
    }
    var keep = Object.keys(diff.features).filter(function (k) { return diff.features[k] === false && state.keep[k]; });
    state.saving = true;
    updateDirty();
    $('save').textContent = 'Saving…';
    var guild = state.guild;
    request('/api/config', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: guild, features: diff.features, settings: diff.settings, keep: keep })
    }).then(function (r) {
      state.saving = false;
      $('save').textContent = 'Save changes';
      if (guild !== state.guild) return;
      if (r.status === 200 && r.data && r.data.config) {
        var notes = (r.data.notes || []).filter(Boolean);
        useConfig(r.data.config);
        $('dirty').textContent = '✅ Saved for ' + r.data.config.guild.name + '.';
        showNotes(notes, true);
        say('Saved');
        return;
      }
      if (r.status === 400 && r.data && r.data.problems && r.data.problems.length) {
        problems = {};
        r.data.problems.forEach(function (p) { problems[p.key] = p.message; });
        markProblems();
        updateDirty();
        undismiss();
        $('dirty').textContent = '❌ Nothing was saved. Fix the highlighted setting' + (r.data.problems.length === 1 ? '' : 's') + ' and try again.';
        showNotes(r.data.problems.map(function (p) { return p.message; }), false);
        var first = doc.querySelector('.fld.bad');
        if (first) {
          var details = first.closest('details');
          if (details) details.open = true;
          first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
      updateDirty();
      undismiss();
      $('dirty').textContent = '❌ Not saved. ' + errorText(r);
      showNotes([], false);
    });
  }

  function discard() {
    if (!state.config) return;
    state.draft = clone(state.original);
    state.keep = {};
    problems = {};
    renderBoard();
    updateDirty();
    showNotes([], null);
    state.barWanted = false;
    showBar();
    say('Changes discarded');
  }

  /* ---------- Server Builder: ready-made categories BEV adds to the server ---------- */

  var builder = { open: false, picked: {}, changed: false, busy: false, pushed: false };
  var STARTER = ['info', 'community', 'voice', 'staff'];
  var ACCESS_MARK = { 'public': '🌐', readonly: '📖', staff: '🔒' };

  function builderData() { return (state.config && state.config.builder && Array.isArray(state.config.builder.sets)) ? state.config.builder : null; }
  // With "delete everything first" ticked, every channel in a ticked set gets made again.
  function freshIn(s) { return builder.wipe ? s.channels.length : s.channels.filter(function (c) { return !c.exists; }).length; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function setTitle(s) { return String(s.name).replace(/^\S+\s+/, ''); }

  // The card at the top of the dashboard.
  function drawBuilderEntry() {
    var data = builderData();
    var stat = $('bentrystat');
    $('bentrynote').hidden = true;
    // People given Dashboard Access without the Server Builder don't see it at all.
    $('bentry').hidden = !data && !!(state.config && state.config.access && state.config.access.limited);
    if (!data) {
      stat.textContent = 'Upload the newest bev_bot.py to use the Server Builder.';
      $('bopen').disabled = true;
      return;
    }
    $('bopen').disabled = false;
    var done = data.sets.filter(function (s) { return !freshIn(s); }).length;
    stat.textContent = done ? done + ' of ' + data.sets.length + ' ready-made categories are already in your server.'
      : data.sets.length + ' ready-made categories to pick from.';
  }

  function openBuilder(fromHistory) {
    var note = $('bentrynote');
    if (!builderData()) return;
    if (dirtyCount()) {
      note.textContent = 'Save or discard your changes first, then open the server editor.';
      note.hidden = false;
      if (fromHistory) root.history.replaceState(null, '', root.location.pathname + root.location.search);
      return;
    }
    note.hidden = true;
    builder.open = true;
    builder.picked = {};
    $('bnote').hidden = true;
    drawBuilder();
    show('builder');
    if (!fromHistory && root.location.hash !== '#builder') {
      root.history.pushState({ builder: true }, '', root.location.pathname + root.location.search + '#builder');
      builder.pushed = true;
    }
    $('builder').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('bh').focus({ preventScroll: true });
    say('Server editor opened for ' + state.config.guild.name);
  }

  function closeBuilder(fromHistory) {
    if (!builder.open) return;
    builder.open = false;
    if (!fromHistory) {
      if (builder.pushed) { builder.pushed = false; root.history.back(); }
      else root.history.replaceState(null, '', root.location.pathname + root.location.search);
    } else {
      builder.pushed = false;
    }
    // Something was built: load the server again so new channels show up in the settings.
    if (builder.changed && state.guild) {
      builder.changed = false;
      loadGuild(state.guild);
    } else {
      show('board');
    }
    var top = $('bentry');
    if (top) top.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  function drawBuilder() {
    var data = builderData();
    if (!data) return;
    $('bname').textContent = state.config.guild.name;
    $('bperm').hidden = data.can !== false;
    var grid = $('bsets');
    grid.replaceChildren();
    data.sets.forEach(function (s) {
      var fresh = freshIn(s);
      var done = fresh === 0;
      if (done) delete builder.picked[s.key];
      var tile = el('label', 'bset' + (done ? ' done' : ''));
      tile.setAttribute('data-key', s.key);
      var head = el('div', 'bsh');
      head.append(el('span', 'bemo', s.emoji));
      var title = el('div', 'bst');
      title.append(el('h3', null, setTitle(s)), el('span', 'bacc', (ACCESS_MARK[s.access] || '') + ' ' + s.access_text));
      var box = el('input');
      box.type = 'checkbox';
      box.disabled = done || data.can === false || builder.busy;
      box.checked = !!builder.picked[s.key];
      box.setAttribute('aria-label', 'Add ' + setTitle(s));
      box.addEventListener('change', function () {
        if (box.checked) builder.picked[s.key] = true; else delete builder.picked[s.key];
        tile.classList.toggle('on', box.checked);
        builderSummary();
      });
      head.append(title, box);
      tile.append(head, el('p', 'babout', s.about));
      var list = el('ul', 'bch');
      list.setAttribute('aria-label', 'Channels in ' + setTitle(s));
      s.channels.forEach(function (c) {
        var li = el('li', c.exists ? 'have' : null);
        li.append(el('span', 'bk', c.kind === 'voice' ? '🔊' : '#'), el('span', 'bn', c.name));
        if (c.exists) li.append(el('span', 'btag', 'already there'));
        else {
          if (c.readonly && s.access !== 'readonly') li.append(el('span', 'btag ro', 'read-only'));
          if (c.for) li.append(el('span', 'btag use', 'for ' + c.for));
        }
        list.append(li);
      });
      tile.append(list);
      var foot;
      if (done) foot = '✓ Already in your server';
      else if (s.category_exists) foot = 'Adds ' + plural(fresh, 'channel') + ' to your ' + setTitle(s) + ' category';
      else if (fresh < s.channels.length) foot = 'New category with ' + plural(fresh, 'channel') + ' (' + (s.channels.length - fresh) + ' already there)';
      else foot = 'New category with ' + plural(fresh, 'channel');
      tile.append(el('p', 'bfoot', foot));
      tile.classList.toggle('on', box.checked);
      grid.append(tile);
    });
    var staff = $('bstaff');
    var was = staff.value;
    optionsFor(staff, (state.config.roles || []).map(function (r) { return { value: r.id, label: '@' + r.name }; }), was, 'No staff role');
    builderSummary();
    if (aib && !aib.busy && !$('baibuildrow').hidden) {
      $('baibuild').textContent = builder.wipe ? '🏗️ Delete everything and build it' : '🏗️ Build it';
      $('baibuild').classList.toggle('danger', !!builder.wipe);
    }
  }

  // What ticking those adds: new categories and channels, against Discord's 500 channel limit.
  function builderPlan() {
    var data = builderData();
    var cats = 0, chans = 0, keys = [];
    (data ? data.sets : []).forEach(function (s) {
      if (!builder.picked[s.key]) return;
      var fresh = freshIn(s);
      if (!fresh) return;
      keys.push(s.key);
      chans += fresh;
      if (!s.category_exists || builder.wipe) cats++;
    });
    return { keys: keys, cats: cats, chans: chans, room: data ? (builder.wipe ? data.limit : data.limit - data.count) : 0 };
  }

  function builderSummary() {
    var data = builderData();
    if (!data) return;
    var plan = builderPlan();
    var parts = [];
    if (plan.cats) parts.push(plural(plan.cats, 'new category', 'new categories'));
    if (plan.chans) parts.push(plural(plan.chans, 'new channel'));
    var over = plan.cats + plan.chans > plan.room;
    $('bsum').textContent = parts.length ? parts.join(' and ') : 'Nothing ticked yet';
    $('bcount').textContent = over ? 'That’s more than your server has room for (' + plan.room + ' left of Discord’s ' + data.limit + '). Tick fewer.'
      : 'Your server has ' + data.count + ' of ' + data.limit + ' channels.';
    $('bcount').classList.toggle('no', over);
    $('bgo').disabled = builder.busy || !plan.keys.length || over || data.can === false;
    $('bgo').textContent = builder.busy ? 'Building…' : builder.wipe ? 'Delete everything and build' : 'Add to server';
    $('bgo').classList.toggle('danger', !!builder.wipe);
  }

  function pickSets(keys) {
    var data = builderData();
    if (!data || builder.busy) return;
    builder.picked = {};
    data.sets.forEach(function (s) { if (keys.indexOf(s.key) !== -1 && freshIn(s)) builder.picked[s.key] = true; });
    drawBuilder();
  }

  function builderNote(text, ok) {
    var note = $('bnote');
    note.hidden = !text;
    note.textContent = text || '';
    note.className = 'fnote' + (ok === true ? ' ok' : ok === false ? ' no' : '');
  }

  function buildNow() {
    var plan = builderPlan();
    if (builder.busy || !plan.keys.length) return;
    var what = [plan.cats ? plural(plan.cats, 'category', 'categories') : '', plural(plan.chans, 'channel')].filter(Boolean).join(' and ');
    var typed = '';
    if (builder.wipe) {
      typed = root.prompt('This deletes EVERY channel and category in ' + state.config.guild.name + ' (' + builderData().count + ' now), then adds ' + what +
        '.\n\nType the server’s name to confirm:') || '';
      if (typed.trim().replace(/\s+/g, ' ').toLowerCase() !== String(state.config.guild.name).trim().replace(/\s+/g, ' ').toLowerCase()) {
        builderNote(typed ? 'That isn’t the server’s name, so nothing was deleted.' : 'Cancelled. Nothing was deleted.', false);
        return;
      }
    } else if (!root.confirm('Add ' + what + ' to ' + state.config.guild.name + '? Nothing that’s already in the server is changed.')) return;
    builder.busy = true;
    builderNote(builder.wipe ? 'BEV is deleting the old channels, then building. This can take a few minutes…' : 'BEV is building. Big picks can take up to a minute…', null);
    drawBuilder();
    var guild = state.guild;
    request('/api/action', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: guild, owner: 'builder', action: 'build',
                             values: { sets: plan.keys.join(','), staff_role: $('bstaff').value || '', hook: $('bhook').checked ? 'yes' : 'no',
                                       wipe: builder.wipe ? 'yes' : 'no', confirm_name: typed } })
    }).then(function (r) {
      builder.busy = false;
      if (guild !== state.guild) return;
      if (r.status === 200 && r.data && r.data.ok) {
        builder.changed = true;
        builder.picked = {};
        builder.wipe = false;             // deleting everything is a one-off: it never stays ticked for the next build
        if ($('bwipe')) $('bwipe').checked = false;
        if (r.data.data && Array.isArray(r.data.data.sets)) state.config.builder = r.data.data;
        builderNote(r.data.note || 'Done.', true);
        drawBuilder();
        drawBuilderEntry();
        say(r.data.note || 'Done.');
        return;
      }
      if (r.status === 504) builder.changed = true;     // still going on the bot
      builderNote((r.data && r.data.message) || errorText(r), false);
      drawBuilder();
    });
  }



  /* ---------- Tournament brackets: make one, then pick winners (with a confirm), add scores and fix misclicks ---------- */
  var brk = { pick: null, mode: 'players', count: 4, rows: [], random: false, scores: false, busy: false, note: null };
  function brkAct(action, values, then) {
    if (brk.busy) return;
    brk.busy = true;
    var guild = state.guild;
    request('/api/action', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: guild, owner: 'brackets', action: action, values: values })
    }).then(function (r) {
      brk.busy = false;
      if (guild !== state.guild) return;
      if (r.status === 200 && r.data && r.data.ok) {
        brk.note = { text: r.data.note || 'Done.', ok: true };
        say(brk.note.text);
        then(r.data.data || {});
      } else {
        brk.note = { text: (r.data && r.data.message) || errorText(r), ok: false };
      }
      drawBrackets();
    });
  }
  function brkPeople(b, ids) {
    return (ids || []).map(function (id) { return '@' + ((b.names || {})[id] || 'member'); }).join(', ');
  }
  function memberPicker(chosen, single, onChange) {
    // Search the server's members by name and pick them; picked members show as chips that can be removed.
    var wrap = el('div', 'brkpick');
    var chips = el('div', 'brkchips');
    var input = el('input', 'field');
    input.type = 'search';
    input.autocomplete = 'off';
    input.placeholder = single ? 'Name, or search a member' : 'Add a member: type their username';
    var found = el('ul', 'mfound');
    found.hidden = true;
    function drawChips() {
      chips.replaceChildren();
      chosen.forEach(function (m, i) {
        var c = el('span', 'pchip', '@' + m.name);
        var x = el('button', 'x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove ' + m.name);
        x.addEventListener('click', function () { chosen.splice(i, 1); drawChips(); onChange(); });
        c.append(x);
        chips.append(c);
      });
      chips.hidden = !chosen.length;
    }
    var timer = null, asked = 0;
    input.addEventListener('input', function () {
      root.clearTimeout(timer);
      var text = input.value.trim().replace(/^@/, '');
      if (single) onChange(input.value);
      if (text.length < 2) { found.hidden = true; return; }
      timer = root.setTimeout(function () {
        var n = ++asked;
        request('/api/members?guild_id=' + encodeURIComponent(state.guild) + '&q=' + encodeURIComponent(text)).then(function (r) {
          if (n !== asked) return;
          found.replaceChildren();
          var list = r.status === 200 && r.data && Array.isArray(r.data.members) ? r.data.members.slice(0, 6) : [];
          list.forEach(function (m) {
            var li = el('li');
            var b = el('button', 'mpick');
            b.type = 'button';
            b.append(el('b', null, m.display), el('span', 'mname', '@' + m.name));
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });
            b.addEventListener('click', function () {
              if (single) { chosen.length = 0; input.value = m.display; }
              else input.value = '';
              if (!chosen.some(function (c) { return c.id === m.id; })) chosen.push({ id: m.id, name: m.name });
              found.hidden = true;
              drawChips();
              onChange(single ? input.value : undefined);
            });
            li.append(b);
            found.append(li);
          });
          found.hidden = !list.length;
        });
      }, 220);
    });
    input.addEventListener('blur', function () { root.setTimeout(function () { found.hidden = true; }, 150); });
    wrap.append(input, found, chips);
    drawChips();
    return { node: wrap, input: input };
  }
  function brkRowsTo(n) {
    while (brk.rows.length < n) brk.rows.push({ name: '', members: [] });
    brk.rows.length = n;
  }
  function brkNewForm(f) {
    var form = el('div', 'brkform');
    var top = el('div', 'igrid');
    var nameCell = el('div', 'icell');
    var nameIn = el('input', 'field');
    nameIn.id = 'brk-name'; nameIn.maxLength = 80; nameIn.placeholder = 'Like: Spring Cup 2v2';
    nameIn.value = brk.title || '';
    nameIn.addEventListener('input', function () { brk.title = nameIn.value; });
    var nl = el('label', 'flabel sm', 'Name'); nl.htmlFor = 'brk-name';
    nameCell.append(nl, nameIn);
    var chCell = el('div', 'icell');
    var ch = el('select', 'field');
    ch.id = 'brk-channel';
    optionsFor(ch, channelChoices(['text']), brk.channel || '', 'Pick a channel…');
    ch.addEventListener('change', function () { brk.channel = ch.value; });
    var cl = el('label', 'flabel sm', 'Post it in'); cl.htmlFor = 'brk-channel';
    chCell.append(cl, ch);
    var countCell = el('div', 'icell');
    var count = el('input', 'field');
    count.id = 'brk-count'; count.type = 'number'; count.min = 2; count.max = 1024; count.value = brk.count;
    var ql = el('label', 'flabel sm', brk.mode === 'teams' ? 'How many teams' : 'How many players'); ql.htmlFor = 'brk-count';
    count.addEventListener('change', function () {
      var n = Math.max(2, Math.min(1024, parseInt(count.value, 10) || 2));
      count.value = n; brk.count = n; brkRowsTo(n); drawBrackets();
    });
    countCell.append(ql, count);
    top.append(nameCell, chCell, countCell);
    form.append(top);
    var seg = el('div', 'seg brkmode');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Players or teams');
    [['players', '🧍 Players'], ['teams', '👥 Teams']].forEach(function (o) {
      var b = el('button', null, o[1]);
      b.type = 'button';
      b.setAttribute('data-mode', o[0]);
      b.setAttribute('aria-pressed', brk.mode === o[0] ? 'true' : 'false');
      b.addEventListener('click', function () { brk.mode = o[0]; brk.rows.forEach(function (x) { x.members = []; }); drawBrackets(); });
      seg.append(b);
    });
    form.append(seg);
    // A long list is quicker to paste than to type box by box.
    var paste = el('details', 'brkpaste');
    paste.append(el('summary', null, '📋 Paste a list instead'));
    var area = el('textarea', 'field');
    area.id = 'brk-paste';
    area.rows = 5;
    area.placeholder = brk.mode === 'teams' ? 'One team per line, like:\nRed Rockets: @ace, @bolt\nBlue Thunder: @comet, @dash' : 'One player per line: their @username or just a name';
    var fill = el('button', 'mini', 'Use this list');
    fill.type = 'button';
    fill.id = 'brk-usepaste';
    fill.addEventListener('click', function () {
      var lines = area.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 1024);
      if (lines.length < 2) { brk.note = { text: 'Paste at least 2 lines.', ok: false }; drawBrackets(); return; }
      brk.rows = lines.map(function (line) {
        if (brk.mode === 'teams') {
          var at = line.indexOf(':');
          var name = at === -1 ? line : line.slice(0, at).trim();
          var people = at === -1 ? [] : line.slice(at + 1).split(',').map(function (p) { return p.trim(); }).filter(Boolean);
          return { name: name, members: people.map(function (p) { return { id: p, name: p.replace(/^@/, '') }; }) };
        }
        return { name: line, members: [] };
      });
      brk.count = brk.rows.length;
      brk.note = { text: brk.rows.length + ' ' + (brk.mode === 'teams' ? 'teams' : 'players') + ' added from your list.', ok: true };
      drawBrackets();
    });
    paste.append(area, fill);
    form.append(paste);
    brkRowsTo(brk.count);
    var list = el('ol', 'brkrows');
    brk.rows.forEach(function (row, i) {
      var li = el('li', 'brkrow');
      if (brk.mode === 'teams') {
        var tn = el('input', 'field brkteam');
        tn.placeholder = 'Team ' + (i + 1) + ' name';
        tn.maxLength = 40;
        tn.value = row.name;
        tn.setAttribute('aria-label', 'Team ' + (i + 1) + ' name');
        tn.addEventListener('input', function () { row.name = tn.value; });
        var picker = memberPicker(row.members, false, function () {});
        picker.input.setAttribute('aria-label', 'Members of team ' + (i + 1));
        li.append(tn, picker.node);
      } else {
        var picker1 = memberPicker(row.members, true, function (typed) { if (typed !== undefined) { row.name = typed; if (row.members.length && typed !== row.members[0].display) row.members.length = 0; } });
        picker1.input.value = row.name;
        picker1.input.setAttribute('aria-label', 'Player ' + (i + 1));
        li.append(picker1.node);
      }
      list.append(li);
    });
    form.append(list);
    var opts = el('div', 'brkopts');
    [['random', '🎲 Random matchups (shuffle the order)'], ['scores', '🔢 Keep scores for each match']].forEach(function (o) {
      var lab = el('label', 'chk');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = !!brk[o[0]];
      box.id = 'brk-' + o[0];
      box.addEventListener('change', function () { brk[o[0]] = box.checked; });
      lab.append(box, ' ' + o[1]);
      opts.append(lab);
    });
    form.append(opts);
    var go = el('button', 'act save', '🏆 Make the bracket');
    go.type = 'button';
    go.id = 'brk-make';
    go.disabled = brk.busy || !f.enabled;
    if (!f.enabled) form.append(el('p', 'help', 'Switch Tournament Brackets on and save first.'));
    go.addEventListener('click', function () {
      var entrants = brk.rows.map(function (row) {
        return brk.mode === 'teams' ? { name: row.name.trim(), members: row.members.map(function (m) { return m.id; }) }
          : { name: (row.name || '').trim(), members: row.members.map(function (m) { return m.id; }) };
      });
      brkAct('create', { name: (brk.title || '').trim(), channel: brk.channel || '', mode: brk.mode, entrants: JSON.stringify(entrants),
                         random: brk.random ? 'yes' : 'no', scores: brk.scores ? 'yes' : 'no' }, function (b) {
        state.config.brackets.unshift(b);
        brk.pick = b.id;
        brk.rows = []; brk.title = '';
      });
    });
    form.append(go);
    return form;
  }
  function brkSideName(b, side) {
    if (side === 'bye') return 'BYE';
    if (typeof side !== 'number') return 'TBD';
    return b.entrants[side].name;
  }
  function brkView(b) {
    var view = el('div', 'brkview');
    var head = el('div', 'brkhead');
    var title = el('div');
    title.append(el('h3', 'disp', '🏆 ' + b.name));
    var sub = el('p', 'help', b.entrants.length + ' ' + (b.mode === 'teams' ? 'teams' : 'players') + (b.channel_name ? ' • posted in #' + b.channel_name : ''));
    if (b.url) {
      var open = el('a', 'inl', 'Open in Discord');
      open.href = b.url; open.target = '_blank'; open.rel = 'noopener noreferrer';
      sub.append(' • ', open);
    }
    title.append(sub);
    head.append(title);
    var tools = el('div', 'row brktools');
    var sc = el('label', 'chk');
    var scBox = el('input');
    scBox.type = 'checkbox'; scBox.checked = !!b.scores; scBox.id = 'brk-scores-on';
    scBox.addEventListener('change', function () {
      brkAct('settings', { bracket: String(b.id), scores: scBox.checked ? 'yes' : 'no' }, function (nb) { Object.assign(b, nb); });
    });
    sc.append(scBox, ' Scores');
    var again = el('button', 'mini', '📤 Post again');
    again.type = 'button';
    again.addEventListener('click', function () { brkAct('repost', { bracket: String(b.id) }, function (nb) { Object.assign(b, nb); }); });
    var del = el('button', 'mini danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () {
      askDialog({ title: 'Delete ' + b.name + '?', text: 'It’s removed from the dashboard and can’t be updated any more. The message in Discord stays.', ok: 'Delete it', cancel: 'Keep it' })
        .then(function (yes) {
          if (!yes) return;
          brkAct('delete', { bracket: String(b.id) }, function () {
            state.config.brackets = state.config.brackets.filter(function (x) { return x.id !== b.id; });
            brk.pick = null;
          });
        });
    });
    tools.append(sc, again, del);
    head.append(tools);
    view.append(head);
    if (typeof b.champion === 'number') view.append(el('p', 'brkchamp', '🏆 Champion: ' + brkSideName(b, b.champion)));
    var board = el('div', 'brkboard');
    b.rounds.forEach(function (matches, r) {
      var col = el('div', 'brkcol');
      col.append(el('p', 'lab', b.round_names[r]));
      matches.forEach(function (m, i) {
        var real = typeof m.a === 'number' && typeof m.b === 'number';
        var card = el('div', 'brkmatch' + (m.w ? ' done' : '') + (real ? '' : ' wait'));
        card.setAttribute('data-r', r);
        card.setAttribute('data-m', i);
        ['a', 'b'].forEach(function (side) {
          var row = el('div', 'brkside' + (m.w === side ? ' won' : m.w ? ' lost' : ''));
          row.append(el('span', 'bn', brkSideName(b, m[side])));
          var who = typeof m[side] === 'number' && b.mode === 'teams' ? brkPeople(b, b.entrants[m[side]].members) : '';
          if (who) row.title = who;
          if (b.scores && real) {
            var score = el('input', 'field brkscore');
            score.type = 'number'; score.min = 0; score.max = 9999;
            score.value = m[side === 'a' ? 'sa' : 'sb'] === null || m[side === 'a' ? 'sa' : 'sb'] === undefined ? '' : m[side === 'a' ? 'sa' : 'sb'];
            score.setAttribute('aria-label', 'Score for ' + brkSideName(b, m[side]));
            score.addEventListener('change', function () {
              var inputs = card.querySelectorAll('.brkscore');
              brkAct('score', { bracket: String(b.id), round: String(r), match: String(i), sa: inputs[0].value, sb: inputs[1].value }, function (nb) { Object.assign(b, nb); });
            });
            row.append(score);
          }
          if (real && m.w !== side) {
            var win = el('button', 'mini brkwin', 'Won');
            if (m.w) win.title = 'Make ' + brkSideName(b, m[side]) + ' the winner instead';
            win.type = 'button';
            win.addEventListener('click', function () {
              var name = brkSideName(b, m[side]);
              var other = brkSideName(b, m[side === 'a' ? 'b' : 'a']);
              askDialog({ title: 'Confirm the winner', text: 'Did ' + name + ' beat ' + other + '? BEV will update the bracket in Discord.',
                          hint: m.w ? 'This changes the result. Any later matches that depended on it are reset.' : null,
                          ok: '✅ Yes, ' + name + ' won', cancel: 'Go back' }).then(function (yes) {
                if (!yes) return;
                brkAct('winner', { bracket: String(b.id), round: String(r), match: String(i), side: side, confirm: 'yes' }, function (nb) { Object.assign(b, nb); });
              });
            });
            row.append(win);
          }
          if (m.w === side) row.append(el('span', 'brktick', '✓'));
          card.append(row);
        });
        if (real && m.w) {
          var undo = el('button', 'mini ghost brkundo', 'Clear result');
          undo.type = 'button';
          undo.addEventListener('click', function () {
            askDialog({ title: 'Clear this result?', text: 'The match goes back to having no winner, and later matches that depended on it are reset.', ok: 'Clear it', cancel: 'Keep it' })
              .then(function (yes) { if (yes) brkAct('undo', { bracket: String(b.id), round: String(r), match: String(i) }, function (nb) { Object.assign(b, nb); }); });
          });
          card.append(undo);
        }
        col.append(card);
      });
      board.append(col);
    });
    view.append(board);
    return view;
  }
  var brkHost = null, brkFeature = null;
  function drawBrackets() {
    if (!brkHost) return;
    var f = brkFeature;
    // Let go of a focused box first: its own blur handling (like a dropdown closing) mustn't run while it's being removed.
    if (doc.activeElement && brkHost.contains(doc.activeElement)) doc.activeElement.blur();
    brkHost.replaceChildren();
    var tabs = el('div', 'mtabs');
    (state.config.brackets || []).forEach(function (b) {
      var t = el('button', 'mtab' + (brk.pick === b.id ? ' on' : ''), (typeof b.champion === 'number' ? '🏆 ' : '') + b.name);
      t.type = 'button';
      t.addEventListener('click', function () { brk.pick = b.id; brk.note = null; drawBrackets(); });
      tabs.append(t);
    });
    var add = el('button', 'mini add mnew' + (brk.pick === null ? ' on' : ''), 'New bracket');
    add.type = 'button';
    add.addEventListener('click', function () { brk.pick = null; brk.note = null; drawBrackets(); });
    tabs.append(add);
    brkHost.append(tabs);
    if (brk.note) {
      var n = el('p', 'fnote' + (brk.note.ok ? ' ok' : ' no'), brk.note.text);
      n.setAttribute('role', 'status');
      brkHost.append(n);
    }
    var current = (state.config.brackets || []).find(function (b) { return b.id === brk.pick; });
    brkHost.append(current ? brkView(current) : brkNewForm(f));
  }
  function bracketBox(f) {
    brkFeature = f;
    var outer = el('div', 'brkbox');
    outer.id = 'brackets';
    brkHost = el('div', 'brkinner');
    outer.append(brkHost);
    if (brk.pick === null && (state.config.brackets || []).length) brk.pick = state.config.brackets[0].id;
    drawBrackets();
    return outer;
  }

  /* ---------- Security timeline: risky staff actions, newest first, and each person's risk score ---------- */
  function timelineBox(t) {
    var box = el('div', 'tlbox');
    var events = Array.isArray(t.events) ? t.events : [];
    var scores = Array.isArray(t.scores) ? t.scores : [];
    var limit = Number(t.limit) || 15;
    box.append(el('p', 'flabel', 'Risk scores (last hour, out of your limit of ' + limit + ')'));
    if (!scores.length) box.append(el('p', 'fhelp', 'Nothing risky recorded yet. Actions show up here as staff do them.'));
    var sl = el('ul', 'tlscores');
    scores.forEach(function (r) {
      var li = el('li', r.hour >= limit ? 'hot' : r.hour >= limit / 2 ? 'warm' : '');
      li.append(el('b', null, r.actor || 'Someone'));
      var bar = el('span', 'tlbar');
      var fill = el('i');
      fill.style.width = Math.min(100, Math.round(r.hour / limit * 100)) + '%';
      bar.append(fill);
      li.append(bar, el('span', 'tlnum', r.hour + ' now • ' + r.day + ' today'));
      sl.append(li);
    });
    box.append(sl);
    box.append(el('p', 'flabel', 'Timeline'));
    if (!events.length) box.append(el('p', 'fhelp', 'Empty so far.'));
    var list = el('ol', 'tllist');
    events.forEach(function (e) {
      var li = el('li', e.weight >= 4 ? 'big' : '');
      li.append(el('span', 'tlicon', e.icon || '•'));
      var txt = el('div', 'tltx');
      var line = el('p');
      line.append(el('b', null, e.actor), document.createTextNode(' ' + String(e.action).charAt(0).toLowerCase() + String(e.action).slice(1) + (e.target ? ' ' + e.target : '')));
      txt.append(line);
      if (e.detail) txt.append(el('span', 'tldetail', e.detail));
      txt.append(el('span', 'tlwhen', new Date(e.at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + (e.weight ? ' • +' + e.weight + ' risk' : '')));
      li.append(txt);
      list.append(li);
    });
    box.append(list);
    return box;
  }

  /* ---------- Build with AI: describe the server, see the plan, build it ---------- */
  var aib = { plan: null, busy: false };
  function aiNote(text, ok) {
    var n = $('bainote');
    n.hidden = !text;
    n.textContent = text || '';
    n.className = 'fnote' + (ok === true ? ' ok' : ok === false ? ' no' : '');
  }
  function drawAiPlan(shown) {
    var grid = $('baiplan');
    grid.replaceChildren();
    grid.hidden = !shown;
    $('baibuildrow').hidden = !shown;
    if (!shown) return;
    shown.categories.forEach(function (c) {
      var tile = el('div', 'bset aiset');
      var head = el('div', 'bsh');
      var title = el('div', 'bst');
      title.append(el('h3', null, c.name), el('span', 'bacc', (ACCESS_MARK[c.access] || '') + ' ' + c.access_text));
      head.append(title);
      tile.append(head);
      if (c.about) tile.append(el('p', 'babout', c.about));
      var list = el('ul', 'bch');
      c.channels.forEach(function (ch) {
        var li = el('li', ch.exists ? 'have' : null);
        li.append(el('span', 'bk', ch.kind === 'voice' ? '🔊' : '#'), el('span', 'bn', ch.name));
        if (ch.exists) li.append(el('span', 'btag', 'already there'));
        else {
          if (ch.readonly && c.access !== 'readonly') li.append(el('span', 'btag ro', 'read-only'));
          if (ch.for_text) li.append(el('span', 'btag use', 'for ' + ch.for_text));
        }
        if (ch.topic) li.title = ch.topic;
        list.append(li);
      });
      tile.append(list);
      grid.append(tile);
    });
    var data = builderData();
    var fresh = shown.categories.reduce(function (n, c) { return n + c.channels.filter(function (x) { return !x.exists; }).length; }, 0);
    $('baibuild').disabled = aib.busy || !fresh || (data && data.can === false);
    $('baibuild').textContent = aib.busy ? 'Building…' : builder.wipe ? '🏗️ Delete everything and build it' : '🏗️ Build it (' + plural(fresh, 'new channel') + ')';
    $('baibuild').classList.toggle('danger', !!builder.wipe);
  }
  function aiAsk(values, action, then) {
    var guild = state.guild;
    return request('/api/action', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ guild_id: guild, owner: 'builder', action: action, values: values })
    }).then(function (r) { if (guild === state.guild) then(r); });
  }
  function aiPlan() {
    var prompt = $('baiprompt').value.trim();
    if (aib.busy) return;
    if (prompt.length < 3) { aiNote('Describe your server in a few words first.', false); $('baiprompt').focus(); return; }
    aib.busy = true;
    $('baigo').disabled = true;
    $('baigo').textContent = '✨ Planning…';
    aiNote('BEV is designing your server. This takes about 10 to 30 seconds…', null);
    drawAiPlan(null);
    aiAsk({ prompt: prompt }, 'ai_plan', function (r) {
      aib.busy = false;
      $('baigo').disabled = false;
      $('baigo').textContent = '✨ Plan it with AI';
      if (r.status === 200 && r.data && r.data.ok && r.data.data && r.data.data.plan) {
        aib.plan = r.data.data.plan;
        aiNote(r.data.note, true);
        drawAiPlan(r.data.data.shown);
        $('baiplan').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else aiNote((r.data && r.data.message) || errorText(r), false);
    });
  }
  function aiBuild() {
    if (!aib.plan || aib.busy) return;
    var typed = '';
    if (builder.wipe) {
      typed = root.prompt('This deletes EVERY channel and category in ' + state.config.guild.name + ', then builds the AI plan.\n\nType the server’s name to confirm:') || '';
      if (typed.trim().replace(/\s+/g, ' ').toLowerCase() !== String(state.config.guild.name).trim().replace(/\s+/g, ' ').toLowerCase()) {
        aiNote(typed ? 'That isn’t the server’s name, so nothing was deleted.' : 'Cancelled. Nothing was deleted.', false);
        return;
      }
    } else if (!root.confirm('Build this plan in ' + state.config.guild.name + '? Nothing that’s already in the server is changed.')) return;
    aib.busy = true;
    aiNote(builder.wipe ? 'BEV is deleting the old channels, then building. This can take a few minutes…' : 'BEV is building. This can take up to a minute…', null);
    $('baibuild').disabled = true;
    $('baibuild').textContent = 'Building…';
    aiAsk({ plan: JSON.stringify(aib.plan), staff_role: $('bstaff').value || '', hook: $('bhook').checked ? 'yes' : 'no',
            wipe: builder.wipe ? 'yes' : 'no', confirm_name: typed }, 'ai_build', function (r) {
      aib.busy = false;
      if (r.status === 200 && r.data && r.data.ok) {
        builder.changed = true;
        builder.wipe = false;
        if ($('bwipe')) $('bwipe').checked = false;
        aiNote(r.data.note || 'Done.', true);
        drawAiPlan(r.data.data);
        say(r.data.note || 'Done.');
      } else {
        if (r.status === 504) builder.changed = true;
        aiNote((r.data && r.data.message) || errorText(r), false);
        $('baibuild').disabled = false;
        $('baibuild').textContent = '🏗️ Build it';
      }
    });
  }

  /* ---------- cards side by side: opening one card leaves the one beside it as it was ---------- */

  // Cards in a row share their three rows (top, text, settings) so their Settings lines sit level. When a card in a
  // row opens (its settings, a button's form or a tool's results), that row stops sharing: each card keeps the
  // exact size and layout it had, and only the opened card grows. When nothing in the row is open any more, the
  // cards share again.
  var SUBGRID = !!(root.CSS && root.CSS.supports && root.CSS.supports('grid-template-rows', 'subgrid'));
  var frozen = [];

  function isOpen(card) {
    if (card.querySelector('details.fset[open], .actform:not([hidden])')) return true;
    return Array.prototype.some.call(card.querySelectorAll('.tres.grows'), function (t) { return t.childNodes.length > 0; });
  }

  function unfreeze(card) {
    card.classList.remove('loose');
    Array.prototype.forEach.call(card.children, function (c) { c.style.minHeight = ''; });
  }

  function relayout() {
    if (!SUBGRID) return;
    var sections = $('sections');
    frozen.forEach(unfreeze);
    frozen = [];
    var cards = Array.prototype.filter.call(sections.querySelectorAll('.feat'), function (c) { return !c.hidden && !c.classList.contains('wide'); });
    var opened = cards.filter(isOpen);
    if (!opened.length) return;
    // Measure each row with the opened parts taken out of the flow (not hidden, so a box being typed in keeps focus).
    sections.classList.add('measuring');
    var plans = [];
    var seen = [];
    opened.forEach(function (card) {
      var top = card.getBoundingClientRect().top;
      var row = Array.prototype.filter.call(card.parentNode.children, function (c) {
        return !c.hidden && Math.abs(c.getBoundingClientRect().top - top) < 2;
      });
      if (row.length < 2) return;
      row.forEach(function (c) {
        if (seen.indexOf(c) !== -1) return;
        seen.push(c);
        var head = c.children[0], main = c.children[1], low = c.lastElementChild;
        if (!head || !main || !low || low === main) return;
        var h = head.getBoundingClientRect(), m = main.getBoundingClientRect(), l = low.getBoundingClientRect();
        var mGap = parseFloat(root.getComputedStyle(main).marginTop) || 0, lGap = parseFloat(root.getComputedStyle(low).marginTop) || 0;
        plans.push({ card: c, head: head, main: main, headH: m.top - mGap - h.top, mainH: l.top - lGap - m.top });
      });
    });
    sections.classList.remove('measuring');
    plans.forEach(function (p) {
      p.card.classList.add('loose');
      p.head.style.minHeight = Math.max(0, p.headH) + 'px';
      p.main.style.minHeight = Math.max(0, p.mainH) + 'px';
      frozen.push(p.card);
    });
  }

  // Runs before the page is painted, so the card beside one being opened never jumps.
  function watchLayout() {
    if (!SUBGRID || !root.MutationObserver) return;
    var sections = $('sections');
    new root.MutationObserver(function (list) {
      var relevant = list.some(function (m) {
        var t = m.target;
        if (m.type === 'attributes') return m.attributeName === 'open' ? t.tagName === 'DETAILS' : !!(t.classList && (t.classList.contains('actform') || t.classList.contains('feat') || t.classList.contains('dsec')));
        return t === sections || !!(t.classList && t.classList.contains('tres'));
      });
      if (relevant) relayout();
    }).observe(sections, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    var timer = null;
    root.addEventListener('resize', function () {
      if (!frozen.length) return;
      root.clearTimeout(timer);
      timer = root.setTimeout(relayout, 120);
    });
  }

  /* ---------- start ---------- */

  function boot() {
    show('busy');
    $('busyh').textContent = 'Loading your servers';
    request('/api/servers').then(function (r) {
      if (r.status === 401) { root.location.assign('/auth/login'); return; }
      if (r.status !== 200) return fail(r, 'Couldn’t load your servers');
      state.user = r.data.user || {};
      state.servers = Array.isArray(r.data.servers) ? r.data.servers : [];
      $('who').textContent = state.user.name || 'your account';
      $('meav').replaceChildren(avatarNode(avatarUrl(state.user), state.user.name, 'av sm'));
      doc.dispatchEvent(new root.CustomEvent('bev:signedin', { detail: { user: state.user } }));
      if (!state.servers.length) {
        $('errh').textContent = 'No servers to manage';
        $('errmsg').textContent = 'None of your servers give you the Administrator permission. Ask a server administrator, or sign in with a different Discord account.';
        $('retry').textContent = 'My servers';
        $('retry').onclick = function () { root.location.assign('/servers.html'); };
        return show('err');
      }
      fillServers();
      var wanted = new URLSearchParams(root.location.search).get('guild');
      var last = null;
      try { last = root.localStorage.getItem('bev_last_guild'); } catch (e) { last = null; }
      var start = [wanted, last].find(function (id) { return id && serverById(id); }) ||
        (state.servers.find(function (s) { return s.dashboard; }) || state.servers[0]).id;
      pickServer(start);
    });
  }

  function wire() {
    $('guild').addEventListener('change', onServerChange);
    $('reload').addEventListener('click', function () {
      if (state.guild && dirtyCount() && !root.confirm('Reloading loses your unsaved changes. Reload anyway?')) return;
      if (state.guild) loadGuild(state.guild); else boot();
    });
    $('added').addEventListener('click', function () {
      var id = $('guild').value;
      request('/api/servers?fresh=1').then(function (r) {
        if (r.status === 200 && Array.isArray(r.data.servers)) {
          state.servers = r.data.servers;
          fillServers();
        }
        var server = serverById(id);
        if (server && !server.dashboard) root.alert('BEV isn’t in that server yet. Add it with the button, wait a few seconds, then try again.');
        pickServer(id);
      });
    });
    $('find').addEventListener('input', applyFind);
    // Enter jumps to the first matching setting (or the first matching card).
    $('find').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = doc.querySelector('.fld.findhit') || doc.querySelector('.dsec:not([hidden]) .feat:not([hidden])');
      if (!first) return;
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      var input = first.querySelector('input, select, textarea, button');
      if (input) input.focus({ preventScroll: true });
    });
    // Ctrl+S (or Cmd+S on a Mac) saves.
    doc.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        if (!state.draft) return;
        e.preventDefault();
        if (dirtyCount() && !state.saving && !$('save').disabled) save();
      }
    });
    $('save').addEventListener('click', save);
    $('discard').addEventListener('click', discard);
    $('dismiss').addEventListener('click', dismiss);
    $('notes').addEventListener('wheel', keepScrollInNotes, { passive: false });
    $('notes').addEventListener('scroll', notesFade, { passive: true });
    root.addEventListener('beforeunload', function (e) {
      if (dirtyCount()) { e.preventDefault(); e.returnValue = ''; }
    });
    doc.addEventListener('bev:signedout', function () { root.location.assign('/servers.html'); });
    $('bopen').addEventListener('click', function () { openBuilder(false); });
    $('bback').addEventListener('click', function () { closeBuilder(false); });
    $('bgo').addEventListener('click', buildNow);
    $('baigo').addEventListener('click', aiPlan);
    $('baibuild').addEventListener('click', aiBuild);
    $('baiagain').addEventListener('click', function () { aib.plan = null; drawAiPlan(null); aiNote('', null); $('baiprompt').focus(); });
    $('baiprompt').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiPlan(); } });
    Array.prototype.forEach.call(doc.querySelectorAll('#baibox [data-ex]'), function (b) {
      b.addEventListener('click', function () { $('baiprompt').value = b.getAttribute('data-ex'); $('baiprompt').focus(); });
    });
    $('bwipe').addEventListener('change', function () {
      var box = this;
      if (!box.checked) { builder.wipe = false; drawBuilder(); return; }
      box.checked = false;
      askDialog({
        title: '⚠️ Delete every channel and category?',
        text: 'When you build, BEV will first delete ALL of ' + state.config.guild.name + '’s channels and categories, including every message in them. '
          + 'Messages can’t be brought back. BEV saves a backup of the channel and role layout first, so the layout itself can be restored from Server Backups.',
        hint: 'You’ll be asked to type the server’s name before anything is deleted.',
        ok: 'Yes, delete everything',
        cancel: 'Keep my channels'
      }).then(function (yes) {
        box.checked = !!yes;
        builder.wipe = !!yes;
        drawBuilder();
      });
    });
    $('bstarter').addEventListener('click', function () { pickSets(STARTER); });
    $('ball').addEventListener('click', function () { pickSets((builderData() || { sets: [] }).sets.map(function (s) { return s.key; })); });
    $('bnone').addEventListener('click', function () { pickSets([]); });
    root.addEventListener('popstate', function () {
      var want = root.location.hash === '#builder';
      if (!want && builder.open) closeBuilder(true);
      else if (want && !builder.open && state.config && panel === 'board') openBuilder(true);
    });
    watchLayout();
    watchSelects();
    boot();
  }

  /* ---------- searchable dropdowns: type to find a channel, role or option (computers only) ---------- */
  // Phones and tablets keep their own built-in pickers, which work better with touch.
  function touchDevice() {
    var nav = root.navigator || {};
    var ua = nav.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1) return true;
    return !!(root.matchMedia && root.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }
  var SEARCHABLE = !touchDevice();
  var searchCount = 0;
  var VALUE_PROP = root.HTMLSelectElement ? Object.getOwnPropertyDescriptor(root.HTMLSelectElement.prototype, 'value') : null;
  var INDEX_PROP = root.HTMLSelectElement ? Object.getOwnPropertyDescriptor(root.HTMLSelectElement.prototype, 'selectedIndex') : null;

  function searchable(sel) {
    if (sel.multiple || sel.getAttribute('data-ss') || !sel.parentNode) return;
    sel.setAttribute('data-ss', '1');
    var n = ++searchCount;
    var wrap = el('span', 'ssel');
    if (sel.classList.contains('big')) wrap.classList.add('big');
    sel.parentNode.insertBefore(wrap, sel);
    var input = el('input', sel.className + ' ssin');
    input.type = 'text';
    input.id = (sel.id || 'ss' + n) + '-find';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    var list = el('ul', 'sslist');
    list.id = 'sslist-' + n;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    input.setAttribute('aria-controls', list.id);
    var caret = el('button', 'sscaret');
    caret.type = 'button';
    caret.tabIndex = -1;
    caret.setAttribute('aria-label', 'Show or hide the options');
    wrap.append(input, caret, list);
    wrap.append(sel);
    sel.classList.add('ssnative');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    if (sel.id) {
      var label = doc.querySelector('label[for="' + sel.id + '"]');
      if (label) label.htmlFor = input.id;
      else if (sel.getAttribute('aria-label')) input.setAttribute('aria-label', sel.getAttribute('aria-label'));
    } else if (sel.getAttribute('aria-label')) input.setAttribute('aria-label', sel.getAttribute('aria-label'));
    var shown = [];
    var active = -1;
    var open = false;

    // "Add a role…" / "Pick a channel…" are prompts, not choices: shown greyed in the box, never in the list.
    function isPrompt(o) { return !!o && o.value === '' && /…$/.test(o.textContent.trim()); }
    function sync() {
      var o = sel.options[sel.selectedIndex];
      var label = o ? o.textContent : '';
      if (!open) {
        input.value = o && !isPrompt(o) ? label : '';
        input.placeholder = isPrompt(o) ? label : (o ? '' : 'Type to search…');
      }
      input.disabled = sel.disabled;
      input.title = sel.title || '';
    }
    if (VALUE_PROP && INDEX_PROP) {      // code that sets the value directly still updates the box
      Object.defineProperty(sel, 'value', { configurable: true, get: function () { return VALUE_PROP.get.call(this); },
                                            set: function (v) { VALUE_PROP.set.call(this, v); sync(); } });
      Object.defineProperty(sel, 'selectedIndex', { configurable: true, get: function () { return INDEX_PROP.get.call(this); },
                                                    set: function (v) { INDEX_PROP.set.call(this, v); sync(); } });
    }
    function words(t) { return String(t || '').toLowerCase().replace(/^[#@\s]+/, ''); }
    function draw(query) {
      var q = words(query);
      list.replaceChildren();
      shown = [];
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.hidden || isPrompt(o)) return;
        var text = o.textContent;
        var group = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : '';
        if (q && words(text).indexOf(q) === -1 && text.toLowerCase().indexOf(q) === -1 && words(group).indexOf(q) === -1) return;
        var li = el('li', 'ssopt' + (o.disabled ? ' off' : '') + (o.selected ? ' on' : ''));
        li.id = list.id + '-' + shown.length;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', o.selected ? 'true' : 'false');
        li.append(el('span', null, text));
        if (group) li.append(el('span', 'ssgroup', group));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); if (!o.disabled) choose(o); });
        list.append(li);
        shown.push({ o: o, li: li });
      });
      if (!shown.length) list.append(el('li', 'ssnone', 'Nothing matches “' + query + '”'));
      var current = shown.findIndex(function (x) { return x.o.selected; });
      move(q ? shown.findIndex(function (x) { return !x.o.disabled; }) : current);
    }
    function move(i) {
      if (active >= 0 && shown[active]) shown[active].li.classList.remove('act');
      active = i;
      if (active >= 0 && shown[active]) {
        shown[active].li.classList.add('act');
        input.setAttribute('aria-activedescendant', shown[active].li.id);
        var li = shown[active].li;
        if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
        else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
      } else input.removeAttribute('aria-activedescendant');
    }
    function place() {
      var r = input.getBoundingClientRect();
      var below = root.innerHeight - r.bottom;
      var room = Math.max(below, r.top) - 12;
      list.style.left = Math.max(8, r.left) + 'px';
      list.style.width = Math.min(r.width, root.innerWidth - 16) + 'px';
      list.style.maxHeight = Math.max(120, Math.min(300, room)) + 'px';
      if (below < 200 && r.top > below) { list.style.top = ''; list.style.bottom = (root.innerHeight - r.top + 4) + 'px'; list.classList.add('up'); }
      else { list.style.bottom = ''; list.style.top = (r.bottom + 4) + 'px'; list.classList.remove('up'); }
    }
    function openList() {
      if (open || sel.disabled) return;
      open = true;
      // The list lives on the page itself while it's open, so cards around it (and their animations) can never cover or move it.
      doc.body.append(list);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      wrap.classList.add('open');
      // Start empty so typing searches straight away; what's picked now shows greyed until you type.
      var o = sel.options[sel.selectedIndex];
      input.placeholder = o ? o.textContent : 'Type to search…';
      input.value = '';
      draw('');
      place();
      // It builds itself: the panel unfolds from the box, then the options drop in one after another.
      shown.forEach(function (x, i) { x.li.style.setProperty('--i', Math.min(i, 14)); });
      list.classList.remove('ssbuild');
      void list.offsetWidth;
      list.classList.add('ssbuild');
      root.clearTimeout(list._built);
      list._built = root.setTimeout(function () { list.classList.remove('ssbuild'); }, 700);
    }
    function closeList() {
      if (!open) return;
      open = false;
      list.hidden = true;
      list.classList.remove('ssbuild');
      wrap.insertBefore(list, sel);
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      wrap.classList.remove('open');
      sync();
    }
    function choose(o) {
      var changed = !o.selected;
      o.selected = true;
      closeList();
      if (changed) {
        sel.dispatchEvent(new root.Event('input', { bubbles: true }));
        sel.dispatchEvent(new root.Event('change', { bubbles: true }));
      }
      sync();
    }
    input.addEventListener('focus', openList);
    // The arrow opens the list, or closes it again when it's open.
    caret.addEventListener('mousedown', function (e) { e.preventDefault(); });
    caret.addEventListener('click', function () {
      if (sel.disabled) return;
      if (open) closeList();
      else if (doc.activeElement === input) openList();
      else input.focus();
    });
    input.addEventListener('mousedown', function () { if (doc.activeElement === input && !open) openList(); });
    input.addEventListener('blur', closeList);
    input.addEventListener('input', function () { if (!open) openList(); draw(input.value); place(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) return openList();
        var step = e.key === 'ArrowDown' ? 1 : -1;
        var i = active;
        for (var k = 0; k < shown.length; k++) {
          i = (i + step + shown.length) % shown.length;
          if (!shown[i].o.disabled) break;
        }
        move(i);
      } else if (e.key === 'Enter') {
        if (open) { e.preventDefault(); e.stopPropagation(); if (active >= 0 && shown[active] && !shown[active].o.disabled) choose(shown[active].o); else closeList(); }
      } else if (e.key === 'Escape') {
        if (open) { e.preventDefault(); e.stopPropagation(); closeList(); }
      } else if (e.key === 'Tab') closeList();
    });
    sel.addEventListener('change', sync);
    new root.MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    root.addEventListener('scroll', function (e) { if (open && !list.contains(e.target)) place(); }, true);
    root.addEventListener('resize', function () { if (open) place(); });
    sync();
  }

  function makeSearchable(node) {
    if (!SEARCHABLE || !node || !node.querySelectorAll) return;
    if (node.tagName === 'SELECT') return searchable(node);
    Array.prototype.forEach.call(node.querySelectorAll('select'), searchable);
  }

  function watchSelects() {
    if (!SEARCHABLE || !root.MutationObserver) return;
    makeSearchable(doc.body);
    new root.MutationObserver(function (records) {
      records.forEach(function (r) { Array.prototype.forEach.call(r.addedNodes, function (nd) { if (nd.nodeType === 1) makeSearchable(nd); }); });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  var exported = { clone: clone, same: same, changes: changes, valuesOf: valuesOf, wordsFrom: wordsFrom, newItem: newItem, inviteFor: inviteFor,
                   iconUrl: iconUrl, avatarUrl: avatarUrl, initials: initials, channelLabel: channelLabel, searchText: searchText, ERRORS: ERRORS,
                   mdToHtml: mdToHtml, validUrl: validUrl, validColour: validColour, boxLength: boxLength, inOrder: inOrder, madeLabel: madeLabel,
                   plural: plural, isExtreme: isExtreme, extremeParts: extremeParts, menuGroupsOf: menuGroupsOf };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (doc && doc.getElementById('guild')) wire();
})(typeof window !== 'undefined' ? window : globalThis);
