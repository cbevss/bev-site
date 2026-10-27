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

  boot();
})(window);
