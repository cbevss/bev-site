/* Find a server: the servers that switched on Server Listing, from /api/directory, newest bump first. */
(function (root) {
  'use strict';
  var doc = root.document;
  var state = { servers: [], tag: '', q: '', sort: 'bumped' };
  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function initials(name) { return Array.from(String(name || '').trim()).slice(0, 2).join('').toUpperCase() || '?'; }
  function ago(t) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - t));
    if (!t) return 'not bumped yet';
    if (s < 3600) return 'bumped ' + Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) { var h = Math.round(s / 3600); return 'bumped ' + h + ' hour' + (h === 1 ? '' : 's') + ' ago'; }
    var d = Math.round(s / 86400); return 'bumped ' + d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  function icon(s) {
    if (s.icon && /^https:\/\/cdn\.discordapp\.com\//.test(s.icon)) {
      var img = el('img', 'dicon'); img.src = s.icon; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { img.replaceWith(el('span', 'dicon letter', initials(s.name))); });
      return img;
    }
    return el('span', 'dicon letter', initials(s.name));
  }
  function matches(s) {
    var q = state.q.toLowerCase();
    if (state.tag && s.tags.indexOf(state.tag) === -1) return false;
    return !q || (s.name + ' ' + s.description + ' ' + s.tags.join(' ')).toLowerCase().indexOf(q) !== -1;
  }
  function draw() {
    var grid = $('dgrid');
    grid.replaceChildren();
    var key = { bumped: 'bumped', members: 'members', online: 'online' }[state.sort] || 'bumped';
    var shown = state.servers.filter(matches).sort(function (a, b) { return (Number(b[key]) || 0) - (Number(a[key]) || 0); });
    shown.forEach(function (s) {
      var li = el('li', 'dcard');
      var top = el('div', 'dtop');
      var who = el('div', 'dwho');
      who.append(el('h2', 'disp', s.name), el('p', 'dstats', s.members.toLocaleString() + ' members' + (s.online ? ' • ' + s.online.toLocaleString() + ' online' : '')));
      top.append(icon(s), who);
      li.append(top);
      if (s.description) li.append(el('p', 'ddesc', s.description));
      if (s.tags.length) {
        var tags = el('div', 'dtaglist');
        s.tags.forEach(function (t) {
          var b = el('button', 'pill dtag' + (state.tag === t ? ' on' : ''), '#' + t);
          b.type = 'button';
          b.addEventListener('click', function () { state.tag = state.tag === t ? '' : t; drawTags(); draw(); });
          tags.append(b);
        });
        li.append(tags);
      }
      var foot = el('div', 'dfoot');
      foot.append(el('span', 'dwhen', ago(s.bumped)));
      if (s.invite) {
        var join = el('a', 'act save djoin', 'Join');
        join.href = s.invite; join.target = '_blank'; join.rel = 'noopener noreferrer nofollow';
        join.setAttribute('aria-label', 'Join ' + s.name + ' on Discord');
        foot.append(join);
      }
      li.append(foot);
      grid.append(li);
    });
    $('dnone').hidden = shown.length > 0 || !state.servers.length;
    $('dcount').hidden = false;
    $('dcount').textContent = shown.length === state.servers.length ? state.servers.length + ' servers' : shown.length + ' of ' + state.servers.length + ' servers';
    if (!state.servers.length) {
      $('dnone').hidden = false;
      $('dnone').textContent = 'No servers are listed yet. Be the first: switch on Server Listing on the dashboard.';
    }
  }
  function drawTags() {
    var count = {};
    state.servers.forEach(function (s) { s.tags.forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    var top = Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); }).slice(0, 12);
    var box = $('dtags');
    box.replaceChildren();
    top.forEach(function (t) {
      var b = el('button', 'pill' + (state.tag === t ? ' on' : ''), '#' + t);
      b.type = 'button';
      b.setAttribute('aria-pressed', state.tag === t ? 'true' : 'false');
      b.addEventListener('click', function () { state.tag = state.tag === t ? '' : t; drawTags(); draw(); });
      box.append(b);
    });
    box.hidden = !top.length;
  }
  function boot() {
    $('dfind').addEventListener('input', function () { state.q = this.value.trim(); draw(); });
    $('dsort').addEventListener('change', function () { state.sort = this.value; draw(); });
    $('dretry').addEventListener('click', function () { $('derr').hidden = true; $('dbusy').hidden = false; load(); });
    load();
  }
  function load() {
    root.fetch('/api/directory', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }, function () { return Promise.reject(0); })
      .then(function (d) {
        state.servers = Array.isArray(d.servers) ? d.servers : [];
        $('dbusy').hidden = true;
        $('dgrid').hidden = false;
        drawTags();
        draw();
      })
      .catch(function () { $('dbusy').hidden = true; $('derr').hidden = false; $('dretry').focus(); });
  }
  boot();
})(window);
