/*
 * The Admin page: maintenance mode, the Discord alert, the announcement banner, visits, the connection check and
 * the admin list. Everything here goes through /api/admin/*, which the site's backend only answers for site admins.
 * Text from the server (names, messages, page names) is always put on the page with textContent, never as HTML.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || !doc.getElementById('board')) return;

  var $ = function (id) { return doc.getElementById(id); };
  var SVG = 'http://www.w3.org/2000/svg';
  var state = null;
  var metric = 'visits';
  var bannerStyle = 'info';
  var armTimer = null;
  var chart = { index: -1, slot: 0, padL: 0, bars: [], data: [] };

  var DURATIONS = { 0: 'Until I turn it off', 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 120: '2 hours', 240: '4 hours',
    480: '8 hours', 720: '12 hours', 1440: '24 hours' };
  var ERRORS = {
    bad_request: "That wasn't accepted. Check the boxes and try again.",
    no_database: "The site database isn't connected yet, so this can't be saved. The steps are at the top of the page.",
    database_error: "The site database didn't answer. Try again in a minute.",
    bad_origin: 'Refused for safety. Reload the page and try again.',
    forbidden: 'Your Discord account is not one of the site admins.',
    not_configured: "Sign-in isn't set up in Cloudflare yet.",
  };
  var ALERT_ERRORS = {
    bot_not_configured: "The site can't reach BEV: BOT_API_BASE or BOT_API_KEY is missing in Cloudflare. The connection check below shows what to fix.",
    bot_unreachable: "BEV didn't answer. It may be offline or restarting. Try again in a minute.",
    bot_rejected_key: 'BEV refused the site’s key. BOT_API_KEY must be exactly the same in Cloudflare and in the bot’s settings.',
    bot_outdated: "BEV doesn't have the alert code yet. Upload the newest bev_bot.py, wait for the bot to restart, then press Check again.",
    bot_starting: 'BEV is still starting up. Try again in a moment.',
    bot_error: 'BEV answered with an error. Try again in a minute.',
    busy: 'An alert is already being sent. Wait for it to finish.',
    no_servers: 'No servers have BEV Status Alerts switched on, so there’s nobody to send to.',
    bad_request: 'Write a message of up to 1000 characters first.',
  };
  var alertInfo = null;     // { servers, missingChannel, job } from BEV, or null when BEV couldn't be asked
  var alertTimer = null;
  var alertPolls = 0;
  var alertReady = false;

  /* ---------- small helpers ---------- */

  function make(tag, cls, value) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (value !== undefined && value !== null) el.textContent = value;
    return el;
  }
  function svg(tag, attrs) {
    var el = doc.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function plural(n, one, many) { return num(n) + ' ' + (Number(n) === 1 ? one : many); }
  function when(ms) {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function clock(ms) {
    var d = new Date(ms);
    var today = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function dayName(day, long) {
    var p = day.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return d.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  // "Name (123456789012345678)" from the server becomes just the name.
  function person(by) { return String(by || '').replace(/\s*\(\d{5,25}\)$/, '') || 'a site admin'; }
  function toast(message) { var t = $('toast'); t.textContent = message || ''; t.hidden = !message; }
  function say(message) { $('live').textContent = message; }

  function avatar(el, url, name) {
    el.textContent = '';
    if (url) {
      var img = make('img');
      img.src = url; img.alt = ''; img.width = 36; img.height = 36; img.className = 'av sm';
      el.replaceWith(img);
      img.id = el.id;
      return img;
    }
    el.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
    return el;
  }
  function meAvatar(me) {
    var ok = me && typeof me.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(me.avatar);
    return ok ? 'https://cdn.discordapp.com/avatars/' + me.id + '/' + me.avatar + '.png?size=64' : null;
  }

  function call(path, body) {
    var opts = { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return root.fetch(path, opts).then(function (r) {
      if (r.status === 401) { root.location.assign('/auth/login'); throw new Error('signed out'); }
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; });
    });
  }

  // "Click again to confirm" for actions every visitor would notice.
  function arm(button, label) {
    if (button.classList.contains('armed')) { disarm(); return true; }
    disarm();
    button.setAttribute('data-label', button.textContent);
    button.textContent = label;
    button.classList.add('armed');
    armTimer = root.setTimeout(disarm, 6000);
    return false;
  }
  function disarm() {
    root.clearTimeout(armTimer);
    Array.prototype.forEach.call(doc.querySelectorAll('.act.armed'), function (b) {
      b.classList.remove('armed');
      b.textContent = b.getAttribute('data-label');
    });
    updateSend();
  }
  function busy(on) {
    Array.prototype.forEach.call(doc.querySelectorAll('#board .act'), function (b) { b.disabled = on; });
    if (!on) updateSend();
  }

  /* ---------- loading ---------- */

  function fail(title, message) {
    $('errh').textContent = title;
    $('errmsg').textContent = message;
    $('err').hidden = false;
  }

  function load() {
    $('busy').hidden = false;
    $('err').hidden = true;
    call('/api/admin/state').then(function (res) {
      $('busy').hidden = true;
      if (!res.ok) {
        fail(res.status === 403 ? 'This page is for site admins' : 'Something went wrong', ERRORS[res.data.error] || 'The admin tools could not be loaded. Try again.');
        return;
      }
      render(res.data, true);
      $('board').hidden = false;
      if (!inbox) loadInbox();
      drawChart();
      if (!alertReady) {
        alertReady = true;
        $('amsg').value = res.data.defaults.alert || '';
        alertPreview();
        loadAlert(false);
      }
    }, function () {
      $('busy').hidden = true;
      fail('Something went wrong', 'The admin tools could not be loaded. Check your connection and try again.');
    });
  }

  function render(d, fillForms) {
    state = d;
    $('who').textContent = (d.me && d.me.name) || 'a site admin';
    avatar($('meav'), meAvatar(d.me), d.me && d.me.name);
    $('nodb').hidden = !!(d.database && d.database.connected);
    renderMaintenance(fillForms);
    renderBanner(fillForms);
    renderVisits();
    renderAdmins();
  }

  /* ---------- maintenance mode ---------- */

  function renderMaintenance(fillForms) {
    var m = state.maintenance;
    var pill = $('mstate');
    pill.className = 'stat' + (m.active ? ' warnon' : '');
    pill.textContent = m.active ? (m.until ? 'On until ' + clock(m.until) : 'On') : 'Off';
    if (fillForms) {
      $('mmsg').value = m.message || state.defaults.message;
      var select = $('mdur');
      select.textContent = '';
      var chosen = m.minutes || (m.active ? 0 : 60);
      state.defaults.durations.forEach(function (minutes) {
        var o = make('option', null, DURATIONS[minutes] || minutes + ' minutes');
        o.value = String(minutes);
        o.selected = minutes === chosen;
        select.appendChild(o);
      });
      $('mshow').checked = m.showUntil !== false;
    }
    $('mon').hidden = m.active;
    $('msave').hidden = !m.active;
    $('moff').hidden = !m.active;
    var last = '';
    if (m.active) last = 'Turned on by ' + person(m.by) + ', ' + when(m.at) + '.' + (m.until ? ' It switches itself off at ' + clock(m.until) + '.' : '');
    else if (m.on && m.until) last = 'It switched itself off at ' + when(m.until) + '. It was turned on by ' + person(m.by) + '.';
    else if (m.at) last = 'Turned off by ' + person(m.by) + ', ' + when(m.at) + '.';
    $('mlast').textContent = last;
    disarm();
    maintenancePreview();
  }

  function maintenancePreview() {
    var minutes = Number($('mdur').value || 0);
    var m = state.maintenance;
    $('mcount').textContent = $('mmsg').value.length + ' / 600';
    $('mprevtext').textContent = $('mmsg').value.trim() || state.defaults.message;
    $('mshow').disabled = minutes === 0;
    var until = m.active && m.until && Number(m.minutes) === minutes ? m.until : Date.now() + minutes * 60000;
    $('mprevback').hidden = !(minutes > 0 && $('mshow').checked);
    $('mprevbacktext').textContent = 'Expected back by ' + clock(until) + ' (your time)';
  }

  function saveMaintenance(on) {
    var body = { on: on, message: $('mmsg').value.trim(), minutes: Number($('mdur').value || 0), showUntil: $('mshow').checked };
    busy(true);
    call('/api/admin/maintenance', body).then(function (res) {
      busy(false);
      if (!res.ok) { toast(ERRORS[res.data.error] || 'Saving failed. Try again.'); return; }
      toast('');
      render(res.data, true);
      drawChart();
      say(on ? 'Maintenance mode is on. Visitors now see the maintenance page.' : 'Maintenance mode is off. Everyone can see the website again.');
    }, function () { busy(false); toast("Saving failed. Check your connection and try again."); });
  }

  /* ---------- the Discord alert ---------- */

  function alertMax() { return (state && state.defaults && state.defaults.alertMax) || 1000; }

  function alertPreview() {
    var text = $('amsg').value;
    $('acount').textContent = text.length + ' / ' + alertMax();
    $('aprevtext').textContent = text.trim() || 'Type the message to see it here.';
    $('atime').textContent = 'Today at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    updateSend();
  }

  function alertError(code, retryAfter) {
    var text = !code ? ''
      : code === 'cooldown' ? 'An alert was sent less than a minute ago. Wait ' + plural(retryAfter || 60, 'second', 'seconds') + ' before sending another.'
        : ALERT_ERRORS[code] || ERRORS[code] || 'Something went wrong. Try again.';
    $('aerr').textContent = text;
    $('aerr').hidden = !text;
  }

  function sending() { return !!(alertInfo && alertInfo.job && alertInfo.job.state === 'sending'); }

  function updateSend() {
    var b = $('asend');
    if (!b) return;
    var n = alertInfo ? alertInfo.servers : 0;
    if (!b.classList.contains('armed')) b.textContent = sending() ? 'Sending…' : n ? 'Send to ' + plural(n, 'server', 'servers') : 'Send the alert';
    b.disabled = !alertInfo || sending() || !n || !$('amsg').value.trim();
  }

  function renderAlert() {
    var info = alertInfo;
    var job = info && info.job;
    var pill = $('astate');
    pill.className = 'stat' + (sending() ? ' warnon' : info && info.servers ? ' here' : '');
    pill.textContent = !info ? 'Unavailable' : sending() ? 'Sending' : plural(info.servers, 'server', 'servers');
    var reach = '';
    if (info) {
      reach = info.servers ? 'This goes to ' + plural(info.servers, 'server', 'servers') + '.'
        : 'No servers have switched on BEV Status Alerts yet. Switch it on for your own server in the dashboard, under Utility.';
      if (info.missingChannel) {
        reach += ' ' + plural(info.missingChannel, 'more server has', 'more servers have') + ' alerts on, but '
          + (info.missingChannel === 1 ? 'its' : 'their') + ' alert channel was deleted.';
      }
    }
    $('areach').textContent = reach;
    $('areach').hidden = !info;
    $('aprog').hidden = !sending();
    if (sending()) {
      $('abarfill').style.width = (job.total ? Math.round((job.done / job.total) * 100) : 0) + '%';
      $('aprogtext').textContent = 'Sending… ' + num(job.done) + ' of ' + plural(job.total, 'server', 'servers') + ' done.';
    }
    var done = job && job.state === 'done' ? job : null;
    $('alast').textContent = done ? 'Last alert: sent by ' + person(done.by) + ', ' + when(done.started) + '. It reached ' + num(done.sent)
      + ' of ' + plural(done.total, 'server', 'servers') + '.' : '';
    var list = $('afail');
    list.textContent = '';
    (done ? done.failed || [] : []).forEach(function (f) {
      var li = make('li', 'bad');
      var icon = make('span', 'ic', '❌');
      icon.setAttribute('aria-hidden', 'true');
      var body = make('div');
      body.appendChild(make('b', null, f.server || 'A server'));
      body.appendChild(make('p', null, f.reason || 'It couldn’t be posted there.'));
      li.appendChild(icon);
      li.appendChild(body);
      list.appendChild(li);
    });
    list.hidden = !list.children.length;
    updateSend();
  }

  function loadAlert(quietly) {
    root.clearTimeout(alertTimer);
    if (!quietly) { $('areach').hidden = false; $('areach').textContent = 'Checking which servers have alerts switched on…'; }
    $('arefresh').disabled = true;
    call('/api/admin/alert').then(function (res) {
      $('arefresh').disabled = false;
      alertInfo = res.ok ? res.data : null;
      alertError(res.ok ? null : res.data.error);
      renderAlert();
      if (sending()) pollAlert();
    }, function () {
      $('arefresh').disabled = false;
      alertInfo = null;
      alertError('bot_unreachable');
      renderAlert();
    });
  }

  // While BEV posts the notice, ask how far it got every second or so.
  function pollAlert() {
    root.clearTimeout(alertTimer);
    alertPolls = 0;
    function again() {
      alertTimer = root.setTimeout(function () {
        alertPolls++;
        call('/api/admin/alert').then(function (res) {
          if (res.ok) {
            alertInfo = res.data;
            renderAlert();
            var job = alertInfo.job;
            if (sending() && alertPolls < 300) return again();
            if (job && job.state === 'done') say('The alert reached ' + num(job.sent) + ' of ' + plural(job.total, 'server', 'servers') + '.');
            return;
          }
          if (alertPolls < 300) again();
        }, function () { if (alertPolls < 300) again(); });
      }, 1200);
    }
    again();
  }

  function sendAlert() {
    var text = $('amsg').value.trim();
    if (!text || !alertInfo || !alertInfo.servers) return;
    if (!arm($('asend'), 'Click again to send to ' + plural(alertInfo.servers, 'server', 'servers'))) return;
    $('asend').disabled = true;
    alertError(null);
    call('/api/admin/alert/send', { text: text }).then(function (res) {
      if (!res.ok) {
        alertError(res.data.error, res.data.retryAfter);
        if (res.data.error === 'busy' || res.data.error === 'no_servers') loadAlert(true); else updateSend();
        return;
      }
      alertInfo = Object.assign({}, alertInfo, { job: res.data.job });
      renderAlert();
      say('Sending the alert to ' + plural(alertInfo.servers, 'server', 'servers') + '.');
      if (sending()) pollAlert(); else loadAlert(true);
    }, function () { alertError('bot_unreachable'); updateSend(); });
  }

  /* ---------- the banner ---------- */

  function linkOk(link) {
    if (!link) return true;
    if (/^\/(?!\/)[\w\-./?=&#%]*$/.test(link)) return true;
    try {
      var u = new URL(link);
      return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
    } catch (e) {
      return false;
    }
  }

  function bannerValues() {
    return {
      text: $('btext').value.replace(/\s+/g, ' ').trim(),
      link: $('blink').value.trim(),
      linkText: $('blinktext').value.replace(/\s+/g, ' ').trim(),
      style: bannerStyle,
    };
  }

  function pickStyle(style) {
    bannerStyle = style;
    Array.prototype.forEach.call(doc.querySelectorAll('[data-style]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-style') === style));
    });
    bannerPreview();
  }

  function renderBanner(fillForms) {
    var b = state.banner;
    var on = !!b.on;
    var pill = $('bstate');
    pill.className = 'stat' + (on ? ' goodon' : '');
    pill.textContent = on ? 'Showing' : 'Hidden';
    if (fillForms) {
      $('btext').value = b.text || '';
      $('blink').value = b.link || '';
      $('blinktext').value = b.linkText || '';
      bannerStyle = b.style || 'info';
    }
    $('bon').hidden = on;
    $('bsave').hidden = !on;
    $('boff').hidden = !on;
    $('blast').textContent = b.at ? (on ? 'Shown by ' : 'Hidden by ') + person(b.by) + ', ' + when(b.at) + '.' : '';
    pickStyle(bannerStyle);
  }

  function bannerPreview() {
    var v = bannerValues();
    $('bcount').textContent = $('btext').value.length + ' / 200';
    var bad = !!v.link && !linkOk(v.link);
    $('berr').hidden = !bad;
    $('berr').textContent = bad ? 'The link must start with https:// or be a page on this site, like /status.' : '';
    var box = $('bprev');
    box.textContent = '';
    if (!v.text) { box.appendChild(make('p', 'empty', 'Type the banner text to see it here.')); return; }
    var outer = make('div', 'sitebanner sb-' + v.style);
    var inner = make('div', 'sbw');
    var p = make('p', null, v.text);
    if (v.link && !bad) {
      p.appendChild(doc.createTextNode(' '));
      var a = make('a', null, v.linkText || 'Find out more');
      a.href = v.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      p.appendChild(a);
    }
    var x = make('span', 'sbx', '×');
    x.setAttribute('aria-hidden', 'true');
    inner.appendChild(p);
    inner.appendChild(x);
    outer.appendChild(inner);
    box.appendChild(outer);
  }

  function saveBanner(on) {
    var b = state.banner;
    var v = on ? bannerValues() : { text: b.text || '', link: b.link || '', linkText: b.linkText || '', style: b.style || 'info' };
    if (on && !v.text) { toast('Type the banner text first.'); $('btext').focus(); return; }
    if (on && !linkOk(v.link)) { toast('Fix the link first: it must start with https:// or be a page on this site, like /status.'); $('blink').focus(); return; }
    v.on = on;
    busy(true);
    call('/api/admin/banner', v).then(function (res) {
      busy(false);
      if (!res.ok) { toast(ERRORS[res.data.error] || 'Saving failed. Try again.'); return; }
      toast('');
      render(res.data, true);
      drawChart();
      say(on ? 'The banner is showing on every page.' : 'The banner is hidden.');
    }, function () { busy(false); toast('Saving failed. Check your connection and try again.'); });
  }

  /* ---------- visits ---------- */

  function renderVisits() {
    var v = state.visits;
    var broken = !v || v.error;
    $('verr').hidden = !(v && v.error);
    $('vbody').hidden = !!broken;
    if (broken) return;
    var tiles = $('tiles');
    tiles.textContent = '';
    [['Today', v.today], ['Yesterday', v.yesterday], ['Last 7 days', v.week], ['Last 30 days', v.month], ['All time', v.all]].forEach(function (t) {
      var tile = make('div', 'tile');
      tile.appendChild(make('p', 'lab mono', t[0]));
      tile.appendChild(make('p', 'val', num(t[1].visits)));
      tile.appendChild(make('p', 'sub', (Number(t[1].visits) === 1 ? 'visit' : 'visits') + ' · ' + plural(t[1].views, 'page view', 'page views')));
      tiles.appendChild(tile);
    });
    var since = v.since ? ' Counting started on ' + dayName(v.since, false) + '.' : ' Numbers appear here as people visit the site.';
    $('vnote').textContent = 'A visit is someone arriving from another website, an app or a typed address. Page views count every page they open. '
      + 'Counted without cookies; bots and site admins aren\'t counted. Days follow UK time.' + since;

    var body = $('dtable').tBodies[0];
    body.textContent = '';
    v.daily.slice().reverse().forEach(function (d) {
      var tr = make('tr');
      tr.appendChild(make('td', null, dayName(d.day, true)));
      tr.appendChild(make('td', 'n', num(d.visits)));
      tr.appendChild(make('td', 'n', num(d.views)));
      body.appendChild(tr);
    });
    var pages = $('ptable').tBodies[0];
    pages.textContent = '';
    if (!v.pages.length) {
      var empty = make('tr');
      var cell = make('td', null, 'No page views yet.');
      cell.colSpan = 3;
      empty.appendChild(cell);
      pages.appendChild(empty);
    }
    v.pages.forEach(function (p) {
      var tr = make('tr');
      tr.appendChild(make('td', null, p.name));
      tr.appendChild(make('td', 'n', num(p.visits)));
      tr.appendChild(make('td', 'n', num(p.views)));
      pages.appendChild(tr);
    });
  }

  function niceTop(max) {
    if (max <= 4) return 4;
    var pow = Math.pow(10, Math.floor(Math.log10(max)));
    var steps = [1, 2, 4, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * pow >= max) return steps[i] * pow;
    return 10 * pow;
  }
  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K';
    return String(n);
  }
  // A column with a 4px rounded top and a square foot on the baseline.
  function column(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r)
      + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }

  function drawChart() {
    var v = state && state.visits;
    var box = $('chart');
    var old = box.querySelector('svg');
    if (old) old.remove();
    if (!v || v.error) return;
    var label = metric === 'visits' ? 'Visits' : 'Page views';
    $('ctitle').textContent = label + ' per day, last 30 days';
    box.setAttribute('aria-label', label + ' per day for the last 30 days. Use the left and right arrow keys to read each day.');
    box.setAttribute('role', 'group');
    var data = v.daily.map(function (d) { return { day: d.day, value: d[metric], visits: d.visits, views: d.views }; });
    var W = Math.max(300, Math.round(box.clientWidth || 600));
    var H = 230;
    var padL = 44, padR = 6, padT = 24, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }));
    var top = niceTop(max);
    var slot = plotW / data.length;
    var bw = Math.max(3, Math.min(24, slot - 2));
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
    var grid = svg('g', { class: 'grid' });
    var axis = svg('g', { class: 'axis' });
    [0, top / 2, top].forEach(function (t) {
      var y = padT + plotH - (t / top) * plotH;
      grid.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y }));
      var tick = svg('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end' });
      tick.textContent = compact(t);
      axis.appendChild(tick);
    });
    s.appendChild(grid);
    var bars = [];
    data.forEach(function (d, i) {
      var h = (d.value / top) * plotH;
      var x = padL + i * slot + (slot - bw) / 2;
      var path = svg('path', { class: 'bar', d: h > 0 ? column(x, padT + plotH - h, bw, h, 4) : '' });
      bars.push(path);
      s.appendChild(path);
    });
    [0, 14, 29].forEach(function (i) {
      var t = svg('text', { x: padL + i * slot + slot / 2, y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 29 ? 'end' : 'middle' });
      t.textContent = i === 29 ? 'Today' : dayName(data[i].day, false);
      axis.appendChild(t);
    });
    if (max > 0) {
      // Label only the busiest day; the tooltip and the table carry the rest.
      var peak = data.map(function (d) { return d.value; }).lastIndexOf(max);
      var px = padL + peak * slot + slot / 2;
      var label2 = svg('text', { class: 'peak', x: Math.min(Math.max(px, padL + 10), W - padR - 10), y: padT + plotH - (max / top) * plotH - 7, 'text-anchor': 'middle' });
      label2.textContent = num(max);
      s.appendChild(label2);
    }
    s.appendChild(axis);
    box.insertBefore(s, $('tip'));
    chart = { index: -1, slot: slot, padL: padL, bars: bars, data: data, W: W, padT: padT, plotH: plotH, top: top };
  }

  function showDay(i, announce) {
    if (!chart.data.length) return;
    i = Math.max(0, Math.min(chart.data.length - 1, i));
    chart.bars.forEach(function (b, n) { b.classList.toggle('on', n === i); });
    chart.index = i;
    var d = chart.data[i];
    var tip = $('tip');
    tip.textContent = '';
    tip.appendChild(make('span', 'd', dayName(d.day, true)));
    var lines = metric === 'visits' ? [['visits', d.visits, 'visit', 'visits'], ['views', d.views, 'page view', 'page views']]
      : [['views', d.views, 'page view', 'page views'], ['visits', d.visits, 'visit', 'visits']];
    lines.forEach(function (l, n) {
      var row = make('div');
      if (n === 0) row.appendChild(make('span', 'k'));
      row.appendChild(make('b', null, num(l[1])));
      row.appendChild(doc.createTextNode(' ' + (Number(l[1]) === 1 ? l[2] : l[3])));
      tip.appendChild(row);
    });
    tip.hidden = false;
    var box = $('chart');
    var scale = box.clientWidth / chart.W;
    var x = (chart.padL + i * chart.slot + chart.slot / 2) * scale;
    var left = Math.min(Math.max(0, x - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth);
    var barTop = (chart.padT + chart.plotH - (d[metric] / chart.top) * chart.plotH) * scale;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(0, barTop - tip.offsetHeight - 10) + 'px';
    if (announce) say(dayName(d.day, true) + ': ' + plural(d.visits, 'visit', 'visits') + ', ' + plural(d.views, 'page view', 'page views') + '.');
  }

  function hideDay() {
    if (doc.activeElement === $('chart')) return;
    $('tip').hidden = true;
    chart.bars.forEach(function (b) { b.classList.remove('on'); });
    chart.index = -1;
  }

  /* ---------- inbox: what still needs setting up ---------- */

  var BOT_NOTES = {
    unreachable: "BEV didn't answer, so its side of the inbox couldn't be checked. Press Check again in a minute.",
    rejected: "BEV refused the site's key, so its side of the inbox couldn't be checked. Run the connection check below.",
    not_configured: "The site isn't connected to BEV yet, so only the website's side is checked.",
    error: 'BEV answered with an error, so its side of the inbox couldn’t be checked. Try again in a minute.',
  };
  var WHERE = { site: 'Website (Cloudflare)', bot: 'Bot' };
  var inbox = null;
  var inboxBusy = false;

  function loadInbox() {
    if (inboxBusy) return;
    inboxBusy = true;
    $('irefresh').disabled = true;
    $('inote').textContent = 'Checking what needs setting up…';
    call('/api/admin/inbox').then(function (res) {
      inboxBusy = false;
      $('irefresh').disabled = false;
      if (!res.ok) { $('inote').textContent = ERRORS[res.data.error] || 'The inbox could not be loaded. Press Check again.'; return; }
      inbox = res.data;
      renderInbox();
    }, function () {
      inboxBusy = false;
      $('irefresh').disabled = false;
      $('inote').textContent = 'The inbox could not be loaded. Check your connection and press Check again.';
    });
  }

  function inboxItem(item) {
    var li = make('li', 'iitem ' + (item.done ? 'done' : item.level));
    li.setAttribute('data-key', item.key);
    var top = make('div', 'itop');
    var badge = make('span', 'ibadge ' + (item.done ? 'ok' : item.level), item.done ? 'Done' : item.level === 'needed' ? 'Needs doing' : 'Optional');
    top.appendChild(badge);
    top.appendChild(make('span', 'iwhere', WHERE[item.where] || 'Bot'));
    li.appendChild(top);
    li.appendChild(make('h3', null, item.title));
    if (item.detail && !item.done) li.appendChild(make('p', 'idetail', item.detail));
    if (item.how && !item.done) {
      var how = make('p', 'ihow');
      how.appendChild(make('b', null, 'How: '));
      how.appendChild(doc.createTextNode(item.how));
      li.appendChild(how);
    }
    if (item.done) {
      li.appendChild(make('p', 'imeta', 'Marked done by ' + person(item.done.by) + (item.done.at ? ', ' + when(item.done.at) : '') + '.'
        + (item.fixed ? ' BEV doesn’t report it any more.' : '')));
      if (!item.fixed) li.appendChild(make('p', 'istill', '⚠️ BEV still reports this. If you’ve fixed it, the bot or site may need a restart or a new upload.'));
    }
    var b = make('button', 'mini ' + (item.done ? 'iundo' : 'imark'), item.done ? 'Move back to the inbox' : 'Mark as done');
    b.type = 'button';
    b.addEventListener('click', function () { markItem(item, !item.done, b); });
    var row = make('div', 'irow');
    row.appendChild(b);
    li.appendChild(row);
    return li;
  }

  function renderInbox() {
    var open = inbox.items.filter(function (i) { return !i.done; });
    var done = inbox.items.filter(function (i) { return i.done; });
    var needed = open.filter(function (i) { return i.level === 'needed'; }).length;
    var pill = $('istate');
    pill.className = 'stat' + (needed ? ' warnon' : open.length ? '' : ' goodon');
    pill.textContent = open.length ? open.length + ' to do' : 'All done';
    var list = $('ilist');
    list.textContent = '';
    open.forEach(function (i) { list.appendChild(inboxItem(i)); });
    var note = open.length ? '' : '✅ Nothing needs setting up right now.';
    if (BOT_NOTES[inbox.bot]) note = (note ? note + ' ' : '') + BOT_NOTES[inbox.bot];
    if (!inbox.database) note = (note ? note + ' ' : '') + 'Ticks can’t be saved until the site database is connected.';
    $('inote').textContent = note;
    $('inote').hidden = !note;
    $('idone').hidden = !done.length;
    $('idonesum').textContent = 'Done (' + done.length + ')';
    var dlist = $('idonelist');
    dlist.textContent = '';
    done.forEach(function (i) { dlist.appendChild(inboxItem(i)); });
  }

  function markItem(item, done, button) {
    button.disabled = true;
    call('/api/admin/inbox/mark', { key: item.key, done: done, title: item.title, where: item.where }).then(function (res) {
      button.disabled = false;
      if (!res.ok) { toast(ERRORS[res.data.error] || 'That couldn’t be saved. Try again.'); return; }
      toast('');
      if (done) item.done = { at: Date.now(), by: (state && state.me && state.me.name) || '' };
      else {
        item.done = null;
        if (item.fixed) inbox.items = inbox.items.filter(function (i) { return i !== item; });
      }
      renderInbox();
      say(done ? item.title + ' marked as done.' : item.title + ' moved back to the inbox.');
    }, function () {
      button.disabled = false;
      toast('That couldn’t be saved. Check your connection and try again.');
    });
  }

  /* ---------- connection check ---------- */

  function runCheck() {
    var button = $('crun');
    button.disabled = true;
    $('cnote').textContent = 'Checking… this can take up to a minute if BEV is restarting.';
    call('/api/admin/check', {}).then(function (res) {
      button.disabled = false;
      $('cnote').textContent = '';
      if (!res.ok) { toast(ERRORS[res.data.error] || 'The check could not run. Try again.'); return; }
      var list = $('clist');
      list.textContent = '';
      list.hidden = false;
      var bad = 0;
      (res.data.checks || []).forEach(function (c) {
        var li = make('li', c.ok === true ? 'good' : c.ok === false ? 'bad' : '');
        var icon = make('span', 'ic', c.ok === true ? '✅' : c.ok === false ? '❌' : '➖');
        icon.setAttribute('aria-hidden', 'true');
        var body = make('div');
        body.appendChild(make('b', null, c.label + (c.ok === true ? ': working' : c.ok === false ? ': needs fixing' : ': not checked')));
        body.appendChild(make('p', null, c.detail));
        li.appendChild(icon);
        li.appendChild(body);
        list.appendChild(li);
        if (c.ok === false) bad++;
      });
      $('cnote').textContent = bad ? plural(bad, 'thing needs fixing.', 'things need fixing.') : 'Everything is working.';
      say($('cnote').textContent);
    }, function () {
      button.disabled = false;
      $('cnote').textContent = '';
      toast('The check could not run. Check your connection and try again.');
    });
  }

  /* ---------- admins ---------- */

  function renderAdmins() {
    $('anote').textContent = state.adminsFromSetting
      ? 'These accounts come from the SITE_ADMIN_IDS setting in Cloudflare. To change who can open this page, edit that setting, then upload the site again.'
      : 'These accounts are built into the site. To change who can open this page, add a SITE_ADMIN_IDS setting in Cloudflare with their Discord user IDs '
        + 'separated by commas, then upload the site again.';
    var list = $('alist');
    list.textContent = '';
    (state.admins || []).forEach(function (a) {
      var li = make('li');
      var pic = make('span', 'av sm');
      li.appendChild(pic);
      avatar(pic, a.avatar, a.name);
      var nm = make('div', 'nm');
      nm.appendChild(make('b', null, a.name || 'Name not found'));
      nm.appendChild(make('span', null, a.id));
      li.appendChild(nm);
      if (state.me && state.me.id === a.id) li.appendChild(make('span', 'badge you', 'You'));
      list.appendChild(li);
    });
  }

  /* ---------- wiring ---------- */

  $('retry').addEventListener('click', load);
  ['mmsg', 'mdur', 'mshow'].forEach(function (id) {
    $(id).addEventListener(id === 'mmsg' ? 'input' : 'change', function () { disarm(); maintenancePreview(); });
  });
  $('mreset').addEventListener('click', function () { $('mmsg').value = state.defaults.message; maintenancePreview(); });
  $('mon').addEventListener('click', function () { if (arm($('mon'), 'Click again to turn it on')) saveMaintenance(true); });
  $('msave').addEventListener('click', function () { saveMaintenance(true); });
  $('moff').addEventListener('click', function () { saveMaintenance(false); });

  $('amsg').addEventListener('input', function () { disarm(); alertPreview(); });
  $('areset').addEventListener('click', function () { $('amsg').value = state.defaults.alert; disarm(); alertPreview(); });
  $('asend').addEventListener('click', sendAlert);
  $('arefresh').addEventListener('click', function () { disarm(); alertError(null); loadAlert(false); });

  ['btext', 'blink', 'blinktext'].forEach(function (id) { $(id).addEventListener('input', bannerPreview); });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-style]'), function (b) {
    b.addEventListener('click', function () { pickStyle(b.getAttribute('data-style')); });
  });
  $('bon').addEventListener('click', function () { saveBanner(true); });
  $('bsave').addEventListener('click', function () { saveBanner(true); });
  $('boff').addEventListener('click', function () { saveBanner(false); });

  Array.prototype.forEach.call(doc.querySelectorAll('[data-metric]'), function (b) {
    b.addEventListener('click', function () {
      metric = b.getAttribute('data-metric');
      Array.prototype.forEach.call(doc.querySelectorAll('[data-metric]'), function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      var at = chart.index;
      drawChart();
      if (at >= 0) showDay(at, false);
    });
  });

  var box = $('chart');
  box.addEventListener('pointermove', function (e) {
    if (!chart.data.length) return;
    var rect = box.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (chart.W / rect.width);
    var i = Math.floor((x - chart.padL) / chart.slot);
    if (i < 0 || i >= chart.data.length) { hideDay(); return; }
    if (i !== chart.index) showDay(i, false);
  });
  box.addEventListener('pointerleave', hideDay);
  box.addEventListener('focus', function () { showDay(chart.index >= 0 ? chart.index : chart.data.length - 1, true); });
  box.addEventListener('blur', function () { $('tip').hidden = true; chart.bars.forEach(function (b) { b.classList.remove('on'); }); chart.index = -1; });
  box.addEventListener('keydown', function (e) {
    var moves = { ArrowLeft: -1, ArrowRight: 1, Home: -1000, End: 1000 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    showDay((chart.index >= 0 ? chart.index : chart.data.length - 1) + moves[e.key], true);
  });
  $('crun').addEventListener('click', runCheck);
  $('irefresh').addEventListener('click', loadInbox);

  /* ---------- Dashboard settings: a switch per feature, for every server ---------- */
  var owner = { features: [], categories: [], busy: {} };
  function drawOwner() {
    var box = $('flist');
    box.replaceChildren();
    var q = ($('ffind').value || '').trim().toLowerCase();
    var off = owner.features.filter(function (f) { return f.off; }).length;
    $('fstate').textContent = off ? off + ' switched off' : 'Everything on';
    $('fstate').className = 'stat' + (off ? ' warnstat' : ' here');
    var shown = 0;
    owner.categories.forEach(function (cat) {
      var feats = owner.features.filter(function (f) { return f.category === cat.key && (!q || (f.name + ' ' + f.about).toLowerCase().indexOf(q) !== -1); });
      if (!feats.length) return;
      var group = make('div', 'ofgroup');
      group.append(make('h3', 'ofcat', cat.icon + ' ' + cat.name));
      var ul = make('ul', 'oflist2');
      feats.forEach(function (f) {
        shown++;
        var li = make('li', 'ofrow' + (f.off ? ' isoff' : ''));
        li.setAttribute('data-key', f.key);
        var text = make('div', 'oftext');
        text.append(make('b', null, f.icon + ' ' + f.name), make('span', 'ofabout', f.about));
        var sw = make('button', 'ofswitch' + (f.off ? '' : ' on'), f.off ? 'Off for everyone' : 'On');
        sw.type = 'button';
        sw.setAttribute('aria-pressed', f.off ? 'false' : 'true');
        sw.setAttribute('aria-label', f.name + ': ' + (f.off ? 'switched off for every server' : 'on'));
        sw.disabled = !!owner.busy[f.key];
        sw.addEventListener('click', function () { setOwner(f, !f.off, sw); });
        li.append(text, sw);
        ul.append(li);
      });
      group.append(ul);
      box.append(group);
    });
    $('fcount').textContent = shown + ' of ' + owner.features.length + ' features';
  }
  function setOwner(f, off, button) {
    if (off && !root.confirm('Switch ' + f.name + ' off for every server? It disappears from every dashboard and its commands leave Discord.')) return;
    owner.busy[f.key] = true;
    button.disabled = true;
    $('fnote').textContent = (off ? 'Switching off ' : 'Switching on ') + f.name + '…';
    call('/api/admin/features/set', { key: f.key, off: off }).then(function (res) {
      delete owner.busy[f.key];
      if (!res.ok) { $('fnote').textContent = 'That didn\u2019t save (' + (res.data.error || res.status) + '). Try again.'; drawOwner(); return; }
      owner.features = res.data.features || owner.features;
      owner.categories = res.data.categories || owner.categories;
      $('fnote').textContent = f.name + (off ? ' is now off for every server.' : ' is back on. Servers have what they had before.');
      say($('fnote').textContent);
      drawOwner();
    }, function () { delete owner.busy[f.key]; $('fnote').textContent = 'Saving failed. Check your connection.'; drawOwner(); });
  }
  function loadOwner() {
    call('/api/admin/features').then(function (res) {
      if (!res.ok) {
        $('fstate').textContent = 'Not available';
        $('fnote').textContent = res.data.error === 'bot_outdated' ? 'The bot needs updating before this works.' : 'BEV didn\u2019t answer, so the switches can\u2019t be shown. Try again in a minute.';
        return;
      }
      owner.features = res.data.features || [];
      owner.categories = res.data.categories || [];
      $('fnote').textContent = '';
      drawOwner();
    }, function () { $('fstate').textContent = 'Not available'; });
  }
  $('ffind').addEventListener('input', drawOwner);
  loadOwner();

  var resizeTimer = null;
  root.addEventListener('resize', function () {
    root.clearTimeout(resizeTimer);
    resizeTimer = root.setTimeout(function () { if (state) { drawChart(); } }, 150);
  });

  load();
})(window);
