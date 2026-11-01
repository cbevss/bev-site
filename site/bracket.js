/*
 * A tournament bracket's page: /bracket/<server id>/<bracket id>. Only members of that server can see it (the bot checks).
 * Draws the bracket as columns of matches joined by lines, and checks for new results every 20 seconds.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var parts = root.location.pathname.match(/^\/bracket\/(\d{15,25})\/(\d{1,10})\/?$/);
  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var last = '';

  function fail(title, text, signIn) {
    $('busy').hidden = true;
    $('bview').hidden = true;
    $('err').hidden = false;
    $('errh').textContent = title;
    $('errmsg').textContent = text;
    var a = $('errin');
    a.hidden = !signIn;
    if (signIn) a.href = '/auth/login?next=' + encodeURIComponent(root.location.pathname);
    $('sub').textContent = text;
  }

  function sideName(b, side) {
    if (side === 'bye') return 'BYE';
    if (typeof side !== 'number') return 'TBD';
    return b.entrants[side].name;
  }

  function draw(b) {
    doc.title = b.name + ' | BEV bracket';
    $('title').textContent = b.name;
    $('gname').textContent = b.guild.name;
    $('sub').textContent = b.entrants.length + ' ' + (b.mode === 'teams' ? 'teams' : 'players') + ' • single elimination';
    var status = $('bstatus');
    status.replaceChildren();
    if (typeof b.champion === 'number') {
      var c = el('div', 'bchamp');
      c.append(el('span', 'bcup', '🏆'), el('span', null, 'Champion: '), el('b', null, sideName(b, b.champion)));
      status.append(c);
    }
    // Two sides meeting in the middle: the top half of the bracket plays in from the left, the bottom half from the right,
    // and the final (with the champion) sits in the centre. Scroll sideways to see each side.
    var tree = $('btree');
    tree.replaceChildren();
    var last = b.rounds.length - 1;
    var half = Math.max(1, b.rounds[0].length / 2);
    tree.style.setProperty('--rows', last === 0 ? 1 : half);
    function matchBox(m) {
      var box = el('div', 'bm' + (m.w ? ' done' : '') + (typeof m.a === 'number' && typeof m.b === 'number' ? '' : ' wait'));
      ['a', 'b'].forEach(function (side) {
        var row = el('div', 'bs' + (m.w === side ? ' won' : m.w ? ' lost' : ''));
        var who = m[side];
        row.append(el('span', 'bn', sideName(b, who)));
        if (typeof who === 'number' && b.mode === 'teams') {
          row.title = (b.entrants[who].members || []).map(function (id) { return '@' + ((b.names || {})[id] || 'member'); }).join(', ');
        }
        var score = m[side === 'a' ? 'sa' : 'sb'];
        if (b.scores && score !== null && score !== undefined) row.append(el('span', 'bsc', String(score)));
        if (m.w === side) row.append(el('span', 'btk', '✓'));
        box.append(row);
      });
      return box;
    }
    function column(cls, label, matches, span) {
      var col = el('div', 'bround ' + cls);
      col.append(el('p', 'lab', label));
      var list = el('div', 'bmatches');
      list.style.setProperty('--span', span);
      matches.forEach(function (m) {
        var slot = el('div', 'bslot');
        slot.append(matchBox(m));
        list.append(slot);
      });
      col.append(list);
      return col;
    }
    for (var r = 0; r < last; r++) {
      var ms = b.rounds[r];
      tree.append(column('bl' + (r === 0 ? ' bfirst' : ''), b.round_names[r], ms.slice(0, ms.length / 2), Math.pow(2, r)));
    }
    var centre = el('div', 'bround bcentre' + (last === 0 ? ' alone' : ''));
    centre.append(el('p', 'lab', b.round_names[last]));
    var mid = el('div', 'bmid');
    var fslot = el('div', 'bslot bfinalslot');
    var card = el('div', 'bcard' + (typeof b.champion === 'number' ? ' won' : ''));
    card.append(el('span', 'bcup', '🏆'), el('span', 'lab', 'Champion'), el('b', null, typeof b.champion === 'number' ? sideName(b, b.champion) : 'To be decided'));
    fslot.append(card, matchBox(b.rounds[last][0]));
    mid.append(fslot);
    centre.append(mid);
    tree.append(centre);
    for (var q = last - 1; q >= 0; q--) {
      var mq = b.rounds[q];
      tree.append(column('br' + (q === 0 ? ' bfirst' : ''), b.round_names[q], mq.slice(mq.length / 2), Math.pow(2, q)));
    }
    // Start scrolled so the final is in the middle of the screen.
    var wrap = $('btreewrap');
    if (!wrap.getAttribute('data-placed')) {
      wrap.setAttribute('data-placed', '1');
      root.requestAnimationFrame(function () { wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2); });
    }
    $('busy').hidden = true;
    $('err').hidden = true;
    $('bview').hidden = false;
  }

  function load() {
    if (!parts) { fail('Bracket not found', 'That link isn’t a bracket link.', false); return; }
    root.fetch('/api/bracket?guild_id=' + parts[1] + '&id=' + parts[2], { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }, function () { return { status: r.status, data: {} }; }); })
      .then(function (r) {
        if (r.status === 200) {
          var key = JSON.stringify(r.data);
          if (key !== last) { last = key; draw(r.data); }
          return;
        }
        if (r.status === 401) return fail('Sign in to see this bracket', 'Only members of the server that made this bracket can see it. Sign in with Discord so BEV can check.', true);
        if (r.status === 403) return fail('Members only', 'Only members of ' + (r.data.guild || 'the server') + ' can see this bracket.', false);
        if (r.status === 404) return fail('Bracket not found', 'This bracket was deleted, or the link is wrong.', false);
        fail('Bracket not available', 'BEV couldn’t load it right now. Try again in a minute.', false);
      }, function () { fail('Bracket not available', 'Check your connection and try again.', false); });
  }
  load();
  root.setInterval(function () { if (!doc.hidden && !$('bview').hidden) load(); }, 20000);
})(window);
