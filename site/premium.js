/* The Premium page: the free plan and Premium side by side, monthly or yearly, and paying with Stripe or PayPal.
 * Everything comes from /api/premium (the bot decides which features are free). Paying happens on Stripe's or
 * PayPal's own page; when it's done, the provider tells BEV and this page notices within a minute. */
(function (root) {
  'use strict';
  var doc = root.document;
  var $ = function (id) { return doc.getElementById(id); };
  var data = null, plan = 'month', busy = false, polls = 0;
  var query = new URLSearchParams(root.location.search);

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function money(pence) { return '£' + (pence % 100 ? (pence / 100).toFixed(2) : String(pence / 100)); }
  function api(path, body) {
    var opts = { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
    if (body) { opts.method = 'POST'; opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return root.fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; });
    });
  }
  var ERR = {
    stripe_not_set_up: 'Card payments aren’t set up yet. Try PayPal, or come back soon.',
    paypal_not_set_up: 'PayPal isn’t set up yet. Try paying by card, or come back soon.',
    paypal_plans_missing: 'PayPal isn’t fully set up yet. Try paying by card, or come back soon.',
    premium_off: 'Premium isn’t available right now.',
    signed_out: 'Sign in first.',
    no_subscription: 'There’s no subscription to manage on this account.'
  };
  function errText(res) { return ERR[res.data && res.data.error] || 'That didn’t work. Try again in a minute.'; }

  function list(ul, items, first) {
    ul.replaceChildren();
    if (first) { var li0 = el('li', 'pall'); li0.append(el('b', null, first)); ul.append(li0); }
    items.forEach(function (x) {
      var li = el('li');
      li.append(el('span', 'pico', x.icon || '•'), el('span', null, x.name));
      ul.append(li);
    });
    if (!items.length && !first) ul.append(el('li', 'empty', 'Nothing here yet.'));
  }

  function drawPrice() {
    var yearly = plan === 'year';
    $('pmonth').setAttribute('aria-pressed', String(!yearly));
    $('pyear').setAttribute('aria-pressed', String(yearly));
    $('pamount').textContent = money(yearly ? data.year : data.month);
    $('pper').textContent = yearly ? 'a year' : 'a month';
    var full = data.month * 12;
    $('pyearnote').hidden = !yearly;
    $('pyearnote').textContent = 'That’s ' + money(Math.round(data.year / 12)) + ' a month. You save ' + money(full - data.year) + ' a year.';
  }

  function drawBuy() {
    var box = $('pbuy');
    box.replaceChildren();
    var me = data.me;
    if (me && me.has) {
      var until = me.until && me.until < 253402300000 ? new Date(me.until * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      box.append(el('p', 'fnote ok', '💎 You have Premium' + (until ? (me.status === 'canceled' || me.status === 'cancelled' ? ' until ' : ', renewing on ') + until : '') + '.'));
      if (me.servers && me.servers.length) box.append(el('p', 'fnote', 'It covers: ' + me.servers.map(function (g) { return g.name; }).join(', ') + '.'));
      else box.append(el('p', 'fnote', 'It covers every server you own that has BEV. You don’t own one with BEV yet.'));
      if (me.source === 'stripe' || me.source === 'paypal') {
        var m = el('button', 'act', 'Manage or cancel');
        m.type = 'button';
        m.addEventListener('click', function () { go('/api/premium/manage', null, m); });
        box.append(m);
      }
      return;
    }
    if (!data.signedIn) {
      var a = el('a', 'act save', 'Sign in with Discord to get Premium');
      a.href = '/auth/login?next=' + encodeURIComponent('/premium');
      box.append(a);
      return;
    }
    if (!data.providers.stripe && !data.providers.paypal) { box.append(el('p', 'fnote', 'Payments open soon.')); return; }
    if (data.providers.stripe) {
      var card = el('button', 'act save', '💳 Pay by card');
      card.type = 'button';
      card.addEventListener('click', function () { go('/api/premium/checkout', { plan: plan, provider: 'stripe' }, card); });
      box.append(card);
    }
    if (data.providers.paypal) {
      var pp = el('button', 'act', 'Pay with PayPal');
      pp.type = 'button';
      pp.addEventListener('click', function () { go('/api/premium/checkout', { plan: plan, provider: 'paypal' }, pp); });
      box.append(pp);
    }
    box.append(el('p', 'fnote', 'Covers every server you own. Being an admin of a server isn’t enough: its owner needs Premium.'));
  }

  function go(path, body, btn) {
    if (busy) return;
    busy = true; btn.disabled = true; $('pnote').textContent = 'Opening the payment page…';
    api(path, body || {}).then(function (res) {
      if (res.ok && res.data.url) { root.location.assign(res.data.url); return; }
      $('pnote').textContent = '❌ ' + errText(res);
      busy = false; btn.disabled = false;
    }, function () { $('pnote').textContent = '❌ That didn’t work. Check your connection.'; busy = false; btn.disabled = false; });
  }

  function draw() {
    $('pload').hidden = true;
    if (!data.enabled) { $('poff').hidden = false; $('pplans').hidden = true; return; }
    $('pplans').hidden = false;
    var has = !!(data.me && data.me.has);
    $('pfreecur').hidden = has;
    $('ppremcur').hidden = !has;
    list($('pfreelist'), data.free || []);
    list($('ppremlist'), data.premium || [], 'Every free feature');
    drawPrice();
    drawBuy();
  }

  function load() {
    return api('/api/premium').then(function (res) {
      if (!res.ok) { $('pload').textContent = 'Couldn’t load the plans. Try again in a minute.'; return; }
      data = res.data;
      draw();
      // Back from paying: the provider tells BEV, then this page sees it. Check a few times.
      if (query.get('paid') === '1' && !(data.me && data.me.has) && polls < 12) { polls++; root.setTimeout(load, 5000); }
    }, function () { $('pload').textContent = 'Couldn’t load the plans. Check your connection.'; });
  }

  $('pmonth').addEventListener('click', function () { plan = 'month'; if (data) { drawPrice(); } });
  $('pyear').addEventListener('click', function () { plan = 'year'; if (data) { drawPrice(); } });
  $('ppaid').hidden = query.get('paid') !== '1';
  $('pcancel').hidden = query.get('cancelled') !== '1';
  load();
}(window));
