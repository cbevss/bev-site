/*
 * A server's public leaderboard (/leaderboard?guild=ID, and ?view=week for this week's board). Servers choose to
 * show it with the "Show leaderboard on the website" setting on the dashboard. Nothing private is shown.
 */
(function (root) {
  'use strict';
  var ID_RE = /^\d{5,25}$/;
  var CDN = /^https:\/\/cdn\.discordapp\.com\//;
  var doc = root.document;

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function picture(url, label, cls) {
    if (!url || !CDN.test(url)) return el('span', cls, Array.from(String(label || '?')).slice(0, 2).join('').toUpperCase());
    var img = el('img', cls);
    img.src = url; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy';
    img.addEventListener('error', function () { img.replaceWith(el('span', cls, Array.from(String(label || '?')).slice(0, 2).join('').toUpperCase())); });
    return img;
  }

  function fail(heading, text) {
    doc.getElementById('busy').hidden = true;
    doc.getElementById('errh').textContent = heading;
    doc.getElementById('errmsg').textContent = text;
    doc.getElementById('err').hidden = false;
  }

  function row(m) {
    var li = el('li', 'lrow' + (m.place <= 3 ? ' top' + m.place : ''));
    li.append(el('span', 'place mono', m.place <= 3 ? ['🥇', '🥈', '🥉'][m.place - 1] : '#' + m.place));
    li.append(picture(m.avatar, m.name, 'av'));
    var who = el('div', 'lwho');
    who.append(el('b', null, m.name));
    var bar = el('div', 'lbar');
    var fill = el('span');
    fill.style.width = Math.max(2, Math.min(100, Math.round((m.xp / Math.max(1, m.needed)) * 100))) + '%';
    bar.append(fill);
    who.append(bar);
    var top = m.level >= 100;   // level 100 is Max Level
    who.append(el('span', 'lxp', top ? 'Max Level reached' : m.xp.toLocaleString() + ' / ' + m.needed.toLocaleString() + ' XP to the next level'));
    li.append(who);
    var lvl = el('div', 'llvl');
    lvl.append(el('span', 'mono', top ? 'MAX' : 'LEVEL'), el('b', null, top ? 'LVL' : String(m.level)));
    if (top) lvl.setAttribute('aria-label', 'Max Level');
    li.append(lvl);
    return li;
  }

  // This week: who earned the most XP in the last 7 days. The bar compares each person with the top one.
  function weekRow(m, best) {
    var li = el('li', 'lrow wk' + (m.place <= 3 ? ' top' + m.place : ''));
    li.append(el('span', 'place mono', m.place <= 3 ? ['🥇', '🥈', '🥉'][m.place - 1] : '#' + m.place));
    li.append(picture(m.avatar, m.name, 'av'));
    var who = el('div', 'lwho');
    who.append(el('b', null, m.name));
    var bar = el('div', 'lbar');
    var fill = el('span');
    fill.style.width = Math.max(2, Math.min(100, Math.round((m.gained / Math.max(1, best)) * 100))) + '%';
    bar.append(fill);
    who.append(bar);
    who.append(el('span', 'lxp', m.level >= 100 ? 'Max Level' : 'Level ' + m.level));
    li.append(who);
    var gain = el('div', 'llvl gain');
    gain.append(el('span', 'mono', 'THIS WEEK'), el('b', null, '+' + m.gained.toLocaleString()));
    gain.setAttribute('aria-label', m.gained.toLocaleString() + ' XP this week');
    li.append(gain);
    return li;
  }

  var SUB = {
    all: 'The most active members, by level and XP. Members earn XP by chatting and talking in voice.',
    week: 'Who earned the most XP in the last 7 days. It changes as people chat and talk in voice.'
  };

  function draw(data, view) {
    var board = doc.getElementById('board');
    board.replaceChildren();
    doc.querySelectorAll('#lbtabs [data-view]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false'); });
    var since = data.week_from ? new Date(data.week_from * 1000) : null;
    doc.getElementById('sub').textContent = SUB[view] + (view === 'week' && since ? ' Counting since ' + since.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + '.' : '');
    if (view === 'week') {
      var best = data.week.length ? data.week[0].gained : 1;
      if (!data.week.length) board.append(el('li', 'panel', 'Nobody has earned XP in the last 7 days yet. Start chatting!'));
      data.week.forEach(function (m) { board.append(weekRow(m, best)); });
    } else {
      if (!data.members.length) board.append(el('li', 'panel', 'Nobody has earned XP yet. Start chatting!'));
      data.members.forEach(function (m) { board.append(row(m)); });
    }
    board.setAttribute('aria-label', view === 'week' ? 'This week' : 'All time');
  }

  function boot() {
    var params = new URLSearchParams(root.location.search);
    var guild = params.get('guild') || '';
    var view = params.get('view') === 'week' ? 'week' : 'all';
    if (!ID_RE.test(guild)) return fail('No server picked', 'This page needs a server. Use the website button on /leaderboard in Discord to open your server’s board.');
    root.fetch('/api/leaderboard?guild_id=' + guild, { headers: { accept: 'application/json' }, cache: 'no-store' }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d }; }, function () { return { status: r.status, data: {} }; });
    }, function () { return { status: 0, data: {} }; }).then(function (r) {
      if (r.status === 403) return fail('This leaderboard is private', 'The server’s admins haven’t made it public. They can switch on "Show leaderboard on the website" in Leveling’s settings on the dashboard.');
      if (r.status === 404) return fail('Server not found', 'BEV isn’t in that server, or the link is wrong.');
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.members)) return fail('Leaderboard not available', 'The bot didn’t answer. It may be starting up. Try again in a minute.');
      var g = r.data.guild || {};
      doc.title = 'BEV | ' + (g.name || 'Leaderboard');
      doc.getElementById('title').textContent = (g.name || 'Server') + ' leaderboard';
      doc.getElementById('gicon').replaceChildren(picture(g.icon, g.name, 'av big'));
      var data = { members: r.data.members, week: Array.isArray(r.data.week) ? r.data.week : [], week_from: r.data.week_from || null };
      var tabs = doc.getElementById('lbtabs');
      // An older bot doesn't count the week yet: then there's only the all-time board.
      if (!data.week_from) view = 'all';
      tabs.hidden = !data.week_from;
      tabs.querySelectorAll('[data-view]').forEach(function (b) {
        b.addEventListener('click', function () {
          view = b.getAttribute('data-view') === 'week' ? 'week' : 'all';
          var url = new URL(root.location.href);
          if (view === 'week') url.searchParams.set('view', 'week'); else url.searchParams.delete('view');
          root.history.replaceState(null, '', url.pathname + url.search);
          draw(data, view);
        });
      });
      draw(data, view);
      doc.getElementById('busy').hidden = true;
      doc.getElementById('board').hidden = false;
    });
  }

  if (doc && doc.getElementById('board')) boot();
})(window);
