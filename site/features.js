/*
 * Features page: the search box above the lists. Everything is already on the page;
 * this only hides the commands and features that don't match what you typed.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc) return;

  function matches(card, words) {
    var text = card.getAttribute('data-search') || '';
    return words.every(function (w) { return text.indexOf(w) !== -1; });
  }

  function boot() {
    var box = doc.getElementById('find');
    var found = doc.getElementById('found');
    var nothing = doc.getElementById('nothing');
    if (!box) return;
    var sections = Array.prototype.slice.call(doc.querySelectorAll('.csec, .fsec'));
    var total = doc.querySelectorAll('.csec .cmd').length;
    var features = doc.querySelectorAll('.fsec .cmd').length;

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function apply() {
      var words = box.value.toLowerCase().replace(/^\//, '').split(/\s+/).filter(Boolean);
      var shown = 0;
      var shownFeatures = 0;
      sections.forEach(function (sec) {
        var visible = 0;
        sec.querySelectorAll('.cmd').forEach(function (card) {
          var ok = !words.length || matches(card, words);
          card.hidden = !ok;
          if (ok) visible++;
        });
        sec.querySelectorAll('.fgroup').forEach(function (group) {
          group.hidden = !group.querySelector('.cmd:not([hidden])');
        });
        sec.hidden = visible === 0;
        var count = sec.querySelector('.cnt');
        if (count) count.textContent = String(visible);
        if (sec.classList.contains('fsec')) shownFeatures += visible; else shown += visible;
      });
      found.textContent = words.length ? plural(shown, 'command') + ' and ' + plural(shownFeatures, 'feature') + ' match'
        : total + ' commands, ' + features + ' features';
      nothing.hidden = shown + shownFeatures !== 0;
    }

    box.addEventListener('input', apply);

    // Click a command to copy it, ready to paste into Discord.
    doc.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button.copy');
      if (!b) return;
      var text = b.getAttribute('data-copy') || b.textContent;
      function done(ok) {
        if (!b.getAttribute('data-label')) b.setAttribute('data-label', b.textContent);
        b.textContent = ok ? '✓ Copied' : text;
        b.classList.toggle('copied', ok);
        clearTimeout(b._t);
        b._t = setTimeout(function () { b.textContent = b.getAttribute('data-label'); b.classList.remove('copied'); }, 1400);
      }
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });

    // Once the search box scrolls away, a slim bar with the same search and the sections stays at the top.
    var bar = doc.createElement('div');
    bar.className = 'ftool';
    bar.setAttribute('aria-hidden', 'true');
    var inner = doc.createElement('div');
    inner.className = 'wrap';
    var mirror = doc.createElement('input');
    mirror.className = 'field';
    mirror.type = 'search';
    mirror.placeholder = box.placeholder;
    mirror.setAttribute('aria-label', 'Search commands and features');
    mirror.autocomplete = 'off';
    mirror.tabIndex = -1;
    var jump = doc.createElement('nav');
    jump.className = 'jump';
    jump.setAttribute('aria-label', 'Sections');
    var pills = Array.prototype.slice.call(doc.querySelectorAll('.head .jump .pill'));
    var copies = pills.map(function (p) {
      var c = p.cloneNode(true);
      c.tabIndex = -1;
      jump.appendChild(c);
      return c;
    });
    inner.append(mirror, jump);
    bar.appendChild(inner);
    doc.body.appendChild(bar);
    mirror.addEventListener('input', function () {
      box.value = mirror.value;
      apply();
      var first = doc.querySelector('.csec:not([hidden]), .fsec:not([hidden])');
      if (first && mirror.value) first.scrollIntoView({ block: 'start' });
    });
    box.addEventListener('input', function () { mirror.value = box.value; });
    function showBar(on) {
      bar.classList.toggle('show', on);
      bar.setAttribute('aria-hidden', on ? 'false' : 'true');
      mirror.tabIndex = on ? 0 : -1;
      copies.forEach(function (c) { c.tabIndex = on ? 0 : -1; });
      doc.documentElement.style.setProperty('--ftool', on ? bar.offsetHeight + 'px' : '0px');
    }
    // Which section you're in is highlighted.
    var targets = copies.map(function (c) { return doc.getElementById((c.getAttribute('href') || '').slice(1)); });
    function current() {
      var y = (root.innerHeight || 800) * 0.3, on = -1;
      targets.forEach(function (t, i) { if (t && !t.hidden && t.getBoundingClientRect().top < y) on = i; });
      copies.forEach(function (c, i) { c.classList.toggle('on', i === on); });
      if (on >= 0 && bar.classList.contains('show')) {
        var c = copies[on];
        var left = c.getBoundingClientRect().left - jump.getBoundingClientRect().left + jump.scrollLeft;
        if (left < jump.scrollLeft || left + c.offsetWidth > jump.scrollLeft + jump.clientWidth) jump.scrollLeft = Math.max(0, left - 12);
      }
    }
    var finder = doc.querySelector('.findbar');
    var ticking = false;
    root.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      root.requestAnimationFrame(function () {
        ticking = false;
        var r = finder.getBoundingClientRect();
        showBar(r.bottom < 0);
        current();
      });
    }, { passive: true });
    var q = new URLSearchParams(root.location.search).get('q');
    if (q) { box.value = q.slice(0, 60); apply(); }
  }

  /* Preview buttons on dashboard features: an example of what the feature posts, made by the bot itself. */
  var loading = null;
  function loadPreviews() {
    if (loading) return loading;
    var script = new Promise(function (ok, bad) {
      if (root.BEVRender) return ok();
      var s = doc.createElement('script');
      s.src = '/pvrender.js';
      s.onload = ok; s.onerror = bad;
      doc.head.append(s);
    });
    var data = root.fetch('/previews.json').then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); });
    loading = Promise.all([data, script]).then(function (all) { return all[0]; });
    loading.catch(function () { loading = null; });
    return loading;
  }
  function node(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function openPreview(btn) {
    var key = btn.getAttribute('data-preview');
    var d = node('dialog', 'askbox pvbox');
    d.setAttribute('aria-labelledby', 'fpvh');
    var top = node('div', 'pvtop');
    var h = node('h2', 'disp', '👀 Preview: ' + btn.getAttribute('data-name'));
    h.id = 'fpvh';
    var close = node('button', 'mini pvclose', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the preview');
    top.append(h, close);
    var sub = node('p', 'pvsub', 'An example of what BEV posts. On the dashboard, Preview shows yours, with your own settings and wording.');
    var body = node('div', 'pvlist');
    body.append(node('p', 'pvwait', 'Loading the example…'));
    d.append(top, sub, body);
    function done() { if (d.open) d.close(); d.remove(); btn.focus(); }
    close.addEventListener('click', done);
    d.addEventListener('cancel', function (e) { e.preventDefault(); done(); });
    d.addEventListener('click', function (e) { if (e.target === d) done(); });
    doc.body.append(d);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    close.focus();
    loadPreviews().then(function (all) {
      var ex = all[key];
      body.replaceChildren();
      if (!ex) { body.append(node('p', 'pvnote', 'There’s no example for this one yet.')); return; }
      root.BEVRender.names(ex.names);
      ex.items.forEach(function (item) {
        var sec = node('section', 'pvitem');
        sec.setAttribute('data-item', item.key);
        sec.append(node('h3', 'pvh', item.label));
        item.messages.forEach(function (m) { sec.append(root.BEVRender.message(m, item.label)); });
        body.append(sec);
      });
    }, function () {
      body.replaceChildren(node('p', 'fnote no', 'The example couldn’t be loaded. Check your connection and try again.'));
    });
  }
  doc.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button.fpv');
    if (btn) openPreview(btn);
  });

  boot();
})(window);
