/* Made by build_site.py from dashboard.js: draws a preview message like Discord. Used by the Features page. */
(function (root) {
  'use strict';
  var doc = root.document;
  var state = {};
  var pvNames = {};
  var BOX_PARTS = [];
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function validUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s<>"]{3,495}$/.test(u.trim()); }
  function validColour(c) { var m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? '#' + m[1].toUpperCase() : null; }
  function hasBox(t) { return BOX_PARTS.some(function (k) { return String(t[k] || '').trim(); }); }
  function boxLength(t) { return ['author', 'title', 'description', 'footer'].reduce(function (n, k) { return n + String(t[k] || '').length; }, 0); }
  var pvNames = {};          // names for the members, roles and channels a preview mentions (from the bot)
  function nameFor(kind, id) {
    var list = state.config ? (kind === 'role' ? state.config.roles : state.config.channels) : null;
    var found = (list || []).find(function (x) { return x.id === id; });
    if (found) return found.name;
    var extra = kind === 'role' ? (pvNames.roles || {})[id] : (pvNames.channels || {})[id];
    if (extra) return typeof extra === 'string' ? extra : extra.name;
    return kind === 'role' ? 'deleted-role' : 'deleted-channel';
  }

  // Discord-style formatting for the preview. Everything is escaped first, so only these tags can appear.
  function inlineMd(s) {
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]\n]{1,256})\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>').replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/\|\|([^|\n]+)\|\|/g, '<span class="mspoil">$1</span>');
    s = s.replace(/&lt;@&amp;(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">@' + esc(nameFor('role', id)) + '</span>'; })
      .replace(/&lt;#(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">#' + esc(nameFor('channel', id)) + '</span>'; })
      .replace(/&lt;@!?(\d{5,25})&gt;/g, function (_, id) { return '<span class="dmention">@' + esc((pvNames.users || {})[id] || 'member') + '</span>'; })
      .replace(/(^|[^\w])@(everyone|here)\b/g, '$1<span class="dmention">@$2</span>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }

  function mdToHtml(text) {
    var out = [];
    var list = null;
    var code = null;
    function closeList() { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } }
    esc(text || '').split('\n').forEach(function (line) {
      if (/^```/.test(line)) {
        if (code) { out.push('<pre><code>' + code.join('\n') + '</code></pre>'); code = null; } else { closeList(); code = []; }
        return;
      }
      if (code) { code.push(line); return; }
      var m = /^[-*] (.+)$/.exec(line);
      if (m) { (list = list || []).push('<li>' + inlineMd(m[1]) + '</li>'); return; }
      closeList();
      if ((m = /^(#{1,3}) (.+)$/.exec(line))) { out.push('<p class="mh' + m[1].length + '">' + inlineMd(m[2]) + '</p>'); return; }
      if ((m = /^-# (.+)$/.exec(line))) { out.push('<p class="msub">' + inlineMd(m[1]) + '</p>'); return; }
      if ((m = /^&gt; ?(.*)$/.exec(line))) { out.push('<p class="mquote">' + (inlineMd(m[1]) || '&#8203;') + '</p>'); return; }
      out.push('<p>' + (inlineMd(line) || '&#8203;') + '</p>');
    });
    if (code) out.push('<pre><code>' + code.join('\n') + '</code></pre>');
    closeList();
    return out.join('');
  }

  // A picture in a preview: one that can't load (an expired avatar link, say) is just left out.
  function pvPicture(url, cls) {
    var img = el('img', cls);
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', function () { img.remove(); });
    return img;
  }

  function colourHex(n) {
    return typeof n === 'number' && n > 0 ? '#' + ('000000' + n.toString(16)).slice(-6) : '';
  }

  function emojiText(e) {
    if (!e) return '';
    return e.id ? ':' + (e.name || 'emoji') + ':' : (e.name || '');
  }

  function fileUrl(url, files) {
    if (typeof url !== 'string') return '';
    if (url.indexOf('attachment://') === 0) {
      var name = url.slice(13);
      var f = (files || []).find(function (x) { return x.name === name && x.data; });
      return f ? f.data : '';
    }
    return /^https:\/\//.test(url) ? url : '';
  }

  function textBlock(text, cls) {
    var d = el('div', 'mtext' + (cls ? ' ' + cls : ''));
    d.innerHTML = mdToHtml(text || '');
    return d;
  }

  function embedNode(e, files, used) {
    var box = el('div', 'dembed membed pvembed');
    box.style.borderLeftColor = colourHex(e.color) || '#1E1F22';
    var main = el('div', 'mmain');
    if (e.author && e.author.name) {
      var au = el('p', 'mauthor pvauthor');
      var aicon = fileUrl(e.author.icon_url, files);
      if (aicon) { var ai = pvPicture(aicon, 'pvaicon'); au.append(ai); }
      au.append(doc.createTextNode(e.author.name));
      main.append(au);
    }
    if (e.title) {
      var t = el('div', 'dtitle');
      if (e.url && /^https:\/\//.test(e.url)) {
        var a = el('a', null, e.title);
        a.href = e.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        t.append(a);
      } else t.innerHTML = mdToHtml(e.title).replace(/^<p>|<\/p>$/g, '');
      main.append(t);
    }
    if (e.description) main.append(textBlock(e.description, 'mdesc'));
    if (Array.isArray(e.fields) && e.fields.length) {
      var grid = el('div', 'pvfields');
      e.fields.forEach(function (fd) {
        var cell = el('div', 'pvfield' + (fd.inline ? ' inline' : ''));
        var name = el('div', 'pvfname');
        name.innerHTML = mdToHtml(fd.name || '').replace(/^<p>|<\/p>$/g, '');
        cell.append(name, textBlock(fd.value || ''));
        grid.append(cell);
      });
      main.append(grid);
    }
    var img = e.image && fileUrl(e.image.url, files);
    if (img) { main.append(pvPicture(img, 'mimage')); used[e.image.url] = true; }
    if ((e.footer && e.footer.text) || e.timestamp) {
      var parts = [];
      if (e.footer && e.footer.text) parts.push(e.footer.text);
      if (e.timestamp) parts.push('Today at ' + new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      main.append(el('p', 'dfoot', parts.join(' • ')));
    }
    box.append(main);
    var th = e.thumbnail && fileUrl(e.thumbnail.url, files);
    if (th) { box.append(pvPicture(th, 'mthumb')); used[e.thumbnail.url] = true; }
    return box;
  }

  var BUTTON_STYLES = { 1: 'blurple', 2: 'grey', 3: 'green', 4: 'red', 5: 'grey', 6: 'blurple' };
  function componentNode(c, files) {
    if (!c || typeof c !== 'object') return null;
    var node;
    switch (c.type) {
      case 1:
        node = el('div', 'mbtns pvrow');
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) node.append(n); });
        return node;
      case 2:
        node = el('span', 'mbtn pvb ' + (BUTTON_STYLES[c.style] || 'grey') + (c.disabled ? ' off' : ''));
        if (c.emoji) node.append(el('span', 'pvemoji', emojiText(c.emoji)));
        if (c.label) node.append(el('span', null, c.label));
        if (c.style === 5) node.append(el('span', 'mext', '↗'));
        return node;
      case 3: case 5: case 6: case 7: case 8:
        node = el('div', 'pvselect' + (c.disabled ? ' off' : ''));
        node.append(el('span', null, c.placeholder || 'Make a selection'), el('span', 'pvcaret', '⌄'));
        return node;
      case 9:
        node = el('div', 'pvsection');
        var texts = el('div', 'pvstext');
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) texts.append(n); });
        node.append(texts);
        var acc = componentNode(c.accessory, files);
        if (acc) { acc.classList.add('pvacc'); node.append(acc); }
        return node;
      case 10:
        return textBlock(c.content || '', 'pvtext');
      case 11:
        var u = fileUrl(c.media && c.media.url, files);
        return u ? pvPicture(u, 'mthumb') : null;
      case 12:
        node = el('div', 'pvgallery');
        (c.items || []).forEach(function (it) { var g = fileUrl(it.media && it.media.url, files); if (g) node.append(pvPicture(g, 'mimage')); });
        return node;
      case 14:
        return el('div', c.divider === false ? 'pvgap' : 'pvsep');
      case 17:
        node = el('div', 'pvcont');
        var ac = colourHex(c.accent_color);
        if (ac) node.style.borderLeftColor = ac;
        (c.components || []).forEach(function (x) { var n = componentNode(x, files); if (n) node.append(n); });
        return node;
      default:
        return null;
    }
  }

  function previewMessage(m, itemLabel) {
    var outer = el('div', 'pvmsg');
    var where = el('p', 'pvwhere');
    var w = String(m.where || '');
    var isChannel = w.charAt(0) === '#';
    where.append(el('span', 'pvpin', isChannel ? '#' : w.indexOf('DM to') === 0 ? '✉️' : '⚠️'), ' ', doc.createTextNode(isChannel ? w.slice(1) : w));
    if (m.label && m.label !== itemLabel) where.append(el('span', 'pvlabel', m.label));
    outer.append(where);
    var wrap = el('div', 'dprev mprev pvprev');
    var av = el('img', 'dav');
    av.src = '/bev-avatar.png'; av.alt = ''; av.width = 40; av.height = 40;
    var body = el('div', 'dbody');
    if (m.reply) body.append(el('p', 'pvreply', '↪ Replying to a member’s message'));
    var head = el('p', 'dhead');
    var now = new Date();
    head.append(el('b', null, 'BEV'), ' ', el('span', 'dapp', 'APP'), ' ',
      el('span', 'dtime', 'Today at ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')));
    body.append(head);
    if (m.content) body.append(textBlock(m.content, 'mcontent'));
    var used = {};
    (m.embeds || []).forEach(function (e) { body.append(embedNode(e, m.files, used)); });
    (m.components || []).forEach(function (c) { var n = componentNode(c, m.files); if (n) body.append(n); });
    (m.files || []).forEach(function (f) {
      if (used['attachment://' + f.name]) return;
      if (f.data) body.append(pvPicture(f.data, 'mimage'));
      else body.append(el('p', 'pvfile', '📎 ' + f.name));
    });
    if ((m.reactions || []).length) {
      var rr = el('div', 'pvreacts');
      m.reactions.forEach(function (r) { rr.append(el('span', 'pvreact', r + ' 1')); });
      body.append(rr);
    }
    wrap.append(av, body);
    outer.append(wrap);
    var notes = [];
    if ((m.pings || []).length) {
      notes.push('🔔 Pings ' + m.pings.map(function (p) {
        var x = /^<@&(\d+)>$/.exec(p); if (x) return '@' + nameFor('role', x[1]);
        x = /^<@!?(\d+)>$/.exec(p); if (x) return '@' + ((pvNames.users || {})[x[1]] || 'member');
        return p;
      }).join(', '));
    }
    if (m.deletes) notes.push('🧹 Deletes itself after a few seconds');
    if (notes.length) outer.append(el('p', 'pvmeta', notes.join('   ·   ')));
    return outer;
  }
  root.BEVRender = { message: previewMessage, names: function (n) { pvNames = n || {}; } };
})(window);
