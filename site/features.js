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
    var q = new URLSearchParams(root.location.search).get('q');
    if (q) { box.value = q.slice(0, 60); apply(); }
  }

  boot();
})(window);
