/*
 * Maintenance page: shows "Expected back by" in the visitor's own time instead of UK time.
 * (The page also reloads itself every two minutes, so visitors see the site as soon as it's back.)
 */
(function () {
  'use strict';
  var el = document.querySelector('time[data-local]');
  if (!el) return;
  var when = new Date(el.getAttribute('datetime'));
  if (isNaN(when.getTime())) return;
  var today = when.toDateString() === new Date().toDateString();
  var text = when.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  el.textContent = text + ' (your time)';
})();
