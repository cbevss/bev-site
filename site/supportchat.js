/* The support chat: a bubble in the corner of every page. Signed-in people open a ticket, pick what it's about
 * (a question, a suggestion, or Nevermind, which deletes it) and chat with BEV's AI. If they ask for a real person the
 * ticket goes to the admin panel's Support page; they keep seeing "BEV" until a site admin accepts it, then "Support Agent".
 * Everything goes through this site's backend (/api/support/...), which knows who they are from their sign-in.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || doc.getElementById('bevchat')) return;
  var POLL_MS = 5000;
  var state = { open: false, view: 'home', tickets: [], ticket: null, busy: false, signedOut: false, timer: null, error: '' };

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function request(path, options) {
    var opts = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } }, options || {});
    return root.fetch(path, opts).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return {}; })
        .then(function (data) { return { status: res.status, data: data || {} }; });
    }, function () { return { status: 0, data: { error: 'network', message: 'The BEV site could not be reached. Check your connection.' } }; });
  }
  function post(path, body) {
    return request(path, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  function problem(r) {
    if (r.status === 401) { state.signedOut = true; return ''; }
    return (r.data && r.data.message) || 'Something went wrong. Try again in a minute.';
  }
  function when(s) {
    var d = new Date(s * 1000);
    var today = new Date();
    return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  var STATUS = { bot: 'Chatting with BEV', waiting: 'Waiting for the team', agent: 'With a support agent', closed: 'Closed' };

  // ---------- the bubble and the panel ----------
  var box = el('div', 'bevchat');
  box.id = 'bevchat';
  var fab = el('button', 'bcfab');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Open support chat');
  fab.setAttribute('aria-expanded', 'false');
  var fabImg = el('img');
  fabImg.src = '/bev-icon.png'; fabImg.alt = ''; fabImg.width = 34; fabImg.height = 34;
  fab.append(fabImg, el('span', 'bcfabx', '✕'));
  var panel = el('section', 'bcpanel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'BEV support chat');
  panel.hidden = true;
  box.append(panel, fab);

  function header(title, sub, back) {
    var h = el('div', 'bchead');
    if (back) {
      var b = el('button', 'bcback', '←');
      b.type = 'button'; b.setAttribute('aria-label', 'Back to your tickets');
      b.addEventListener('click', function () { stopPoll(); state.view = 'home'; state.ticket = null; loadList(); });
      h.append(b);
    }
    var av = el('img', 'bcav');
    av.src = '/bev-icon.png'; av.alt = '';
    var t = el('div', 'bctitle');
    t.append(el('b', 'disp', title), el('span', 'bcsub', sub));
    var x = el('button', 'bcx', '✕');
    x.type = 'button'; x.setAttribute('aria-label', 'Close the chat');
    x.addEventListener('click', toggle);
    h.append(av, t, x);
    return h;
  }

  function draw() {
    panel.textContent = '';
    if (state.signedOut) {
      panel.append(header('BEV Support', 'Here to help'));
      var body = el('div', 'bcbody bccenter');
      body.append(el('p', null, 'Sign in with Discord to open a support ticket and see your old ones.'));
      var a = el('a', 'mini bcsign', 'Sign in with Discord');
      a.href = '/auth/login';
      body.append(a);
      panel.append(body);
      return;
    }
    if (state.view === 'chat' && state.ticket) return drawChat();
    panel.append(header('BEV Support', 'Usually answers straight away'));
    var home = el('div', 'bcbody');
    var start = el('button', 'bcnew', '💬 New support ticket');
    start.type = 'button';
    start.disabled = state.busy;
    start.addEventListener('click', newTicket);
    home.append(start);
    if (state.error) home.append(el('p', 'bcerr', state.error));
    home.append(el('p', 'bclabel mono', 'Your tickets'));
    if (!state.tickets.length) home.append(el('p', 'bcempty', state.busy ? 'Loading…' : 'No tickets yet.'));
    var list = el('ul', 'bclist');
    state.tickets.forEach(function (t) {
      var li = el('li');
      var btn = el('button', 'bcitem');
      btn.type = 'button';
      var top = el('span', 'bcitop');
      top.append(el('b', null, t.topic_label), el('span', 'bcwhen', when(t.updated)));
      btn.append(top, el('span', 'bclast', t.last || ''), el('span', 'bcstate s-' + t.status, STATUS[t.status] || ''));
      btn.addEventListener('click', function () { openTicket(t.id); });
      li.append(btn);
      list.append(li);
    });
    home.append(list);
    panel.append(home);
  }

  function drawChat() {
    var t = state.ticket;
    var who = t.with === 'Support Agent' ? 'Support Agent' : 'BEV';
    panel.append(header(who, STATUS[t.status] || '', true));
    var log = el('div', 'bclog');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    t.messages.forEach(function (m) {
      if (m.who === 'system') { log.append(el('p', 'bcsys', m.text)); return; }
      var row = el('div', 'bcmsg ' + (m.who === 'user' ? 'me' : 'them'));
      if (m.who !== 'user') row.append(el('span', 'bcname', m.who === 'agent' ? 'Support Agent' : 'BEV'));
      var bubble = el('div', 'bcbub', m.text);
      row.append(bubble, el('span', 'bctime', when(m.at)));
      log.append(row);
    });
    if (!t.topic) {
      var opts = el('div', 'bcopts');
      [['question', '❓ I have a question'], ['suggestion', '💡 I have a suggestion'], ['nevermind', '✖️ Nevermind']].forEach(function (o) {
        var b = el('button', 'bcopt' + (o[0] === 'nevermind' ? ' never' : ''), o[1]);
        b.type = 'button';
        b.disabled = state.busy;
        b.addEventListener('click', function () { pickTopic(o[0]); });
        opts.append(b);
      });
      log.append(opts);
    }
    if (state.busy && t.status === 'bot' && t.topic) {
      var typing = el('div', 'bcmsg them bctyping');
      typing.append(el('span', 'bcname', 'BEV'));
      var dots = el('div', 'bcbub');
      dots.append(el('i'), el('i'), el('i'));
      dots.setAttribute('aria-label', 'BEV is typing');
      typing.append(dots);
      log.append(typing);
    }
    panel.append(log);
    if (state.error) panel.append(el('p', 'bcerr', state.error));
    var foot = el('form', 'bcfoot');
    var input = el('textarea', 'bcin');
    input.rows = 1; input.maxLength = 2000;
    input.placeholder = t.status === 'closed' ? 'This ticket is closed' : (!t.topic ? 'Pick an option above first' : 'Write a message…');
    input.disabled = t.status === 'closed' || !t.topic;
    input.setAttribute('aria-label', 'Your message');
    var send = el('button', 'bcsend', '➤');
    send.type = 'submit'; send.setAttribute('aria-label', 'Send'); send.disabled = input.disabled || state.busy;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); foot.requestSubmit ? foot.requestSubmit() : sendMessage(input.value); }
    });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
    foot.addEventListener('submit', function (e) { e.preventDefault(); sendMessage(input.value); });
    foot.append(input, send);
    panel.append(foot);
    if (t.status !== 'closed' && t.topic) {
      var end = el('button', 'bcend', 'Close this ticket');
      end.type = 'button';
      end.addEventListener('click', closeTicket);
      panel.append(end);
    }
    log.scrollTop = log.scrollHeight;
    if (!input.disabled && state.focus) { input.focus(); state.focus = false; }
  }

  // ---------- talking to the backend ----------
  function loadList() {
    state.busy = true; state.error = ''; draw();
    request('/api/support/mine').then(function (r) {
      state.busy = false;
      if (r.status === 200) { state.signedOut = false; state.tickets = r.data.tickets || []; }
      else state.error = problem(r);
      draw();
    });
  }
  function newTicket() {
    state.busy = true; state.error = ''; draw();
    post('/api/support/new', {}).then(function (r) {
      state.busy = false;
      if (r.status === 200) { state.ticket = r.data.ticket; state.view = 'chat'; }
      else state.error = problem(r);
      draw();
    });
  }
  function openTicket(id) {
    state.busy = true; state.error = ''; draw();
    request('/api/support/ticket?id=' + id).then(function (r) {
      state.busy = false;
      if (r.status === 200) { state.ticket = r.data.ticket; state.view = 'chat'; state.focus = true; startPoll(); }
      else state.error = problem(r);
      draw();
    });
  }
  function pickTopic(topic) {
    state.busy = true; state.error = ''; draw();
    post('/api/support/topic', { id: state.ticket.id, topic: topic }).then(function (r) {
      state.busy = false;
      if (r.status === 200 && r.data.deleted) { state.ticket = null; state.view = 'home'; loadList(); return; }
      if (r.status === 200) { state.ticket = r.data.ticket; state.focus = true; startPoll(); }
      else state.error = problem(r);
      draw();
    });
  }
  function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || state.busy || !state.ticket) return;
    var t = state.ticket;
    t.messages.push({ id: 0, who: 'user', text: text, at: Date.now() / 1000 });
    state.busy = true; state.error = ''; state.focus = true; draw();
    post('/api/support/send', { id: t.id, text: text }).then(function (r) {
      state.busy = false;
      if (r.status === 200) state.ticket = r.data.ticket;
      else { t.messages.pop(); state.error = problem(r); }
      state.focus = true;
      draw();
      startPoll();
    });
  }
  function closeTicket() {
    state.busy = true; draw();
    post('/api/support/close', { id: state.ticket.id }).then(function (r) {
      state.busy = false;
      if (r.status === 200) state.ticket = r.data.ticket; else state.error = problem(r);
      stopPoll(); draw();
    });
  }
  // While a person from the team may reply, check for new messages every few seconds.
  function startPoll() {
    stopPoll();
    if (!state.ticket || state.ticket.status === 'closed') return;
    state.timer = root.setInterval(function () {
      if (!state.open || state.busy || !state.ticket || doc.hidden) return;
      var id = state.ticket.id, before = state.ticket.messages.length + state.ticket.status;
      request('/api/support/ticket?id=' + id).then(function (r) {
        if (r.status !== 200 || !state.ticket || state.ticket.id !== id || state.busy) return;
        var t = r.data.ticket;
        if (t.messages.length + t.status !== before) {
          var input = panel.querySelector('.bcin');
          var draft = input ? input.value : '';
          var focused = input && doc.activeElement === input;
          state.ticket = t; draw();
          var again = panel.querySelector('.bcin');
          if (again) { again.value = draft; if (focused) again.focus(); }
        }
        if (t.status === 'closed') stopPoll();
      });
    }, POLL_MS);
  }
  function stopPoll() { if (state.timer) { root.clearInterval(state.timer); state.timer = null; } }

  function toggle() {
    state.open = !state.open;
    panel.hidden = !state.open;
    box.classList.toggle('open', state.open);
    fab.setAttribute('aria-expanded', String(state.open));
    fab.setAttribute('aria-label', state.open ? 'Close support chat' : 'Open support chat');
    if (state.open) {
      if (state.view === 'chat' && state.ticket) { openTicket(state.ticket.id); } else loadList();
    } else stopPoll();
  }
  fab.addEventListener('click', toggle);
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) { toggle(); fab.focus(); } });

  function mount() { doc.body.append(box); }
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount);
  root.BEVChat = { open: function () { if (!state.open) toggle(); } };
})(window);
