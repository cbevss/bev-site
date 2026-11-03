/*
 * Top bar behaviour shared by every page.
 *
 * Once someone has signed in with Discord, this adds a Dashboard tab between Features and Support
 * and turns the "Sign in with Discord" button into the account pill: their Discord picture, "Signed in as <name>"
 * and Sign out. Site admins also get an Admin tab.
 * It only ever asks this site's own backend whether a session exists (/api/me). No token or secret is involved.
 *
 * The backend sets a plain "bev_in" flag when you sign in, so the tab can appear immediately.
 * The flag is only a hint for the top bar. Every page and every API call still checks the real,
 * encrypted session, so clearing or forging the flag (or the admin hint) changes nothing but what the top bar shows.
 *
 * It also lets visitors close the announcement banner: a "bev_banner" cookie remembers which one they closed.
 */
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  // Inside the BEV Windows app: hide the "Install the app" buttons.
  if (/\bBEVDesktop\//.test((root.navigator && root.navigator.userAgent) || '')) doc.documentElement.classList.add('inapp');
  // On phones and tablets: hide the Windows app download too, since it can't be installed there.
  (function () {
    var nav = root.navigator || {};
    var ua = nav.userAgent || '';
    var ipadAsMac = /Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1;
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua) || ipadAsMac) doc.documentElement.classList.add('mobile');
  })();

  var FLAG = /(?:^|;\s*)bev_in=1(?:;|$)/;
  var secure = root.location.protocol === 'https:' ? '; Secure' : '';

  function flagged() { return FLAG.test(doc.cookie); }

  // Normally set by the backend at sign-in. This covers a session that began before the flag existed.
  function setFlag() {
    if (!flagged()) doc.cookie = 'bev_in=1; Path=/; SameSite=Lax; Max-Age=7200' + secure;
  }

  function clearFlag() {
    doc.cookie = 'bev_in=; Path=/; SameSite=Lax; Max-Age=0' + secure;
  }

  function supportTab(tabs) {
    return Array.prototype.find.call(tabs.children, function (n) { return n.textContent.trim() === 'Support'; }) || null;
  }

  function show(signedIn) {
    var tabs = doc.querySelector('.tabs');
    if (tabs) {
      var tab = tabs.querySelector('[data-dash]');
      if (signedIn && !tab) {
        tab = doc.createElement('a');
        tab.className = 'tab';
        tab.href = '/dashboard';
        tab.textContent = 'Dashboard';
        tab.setAttribute('data-dash', '');
        // Order: Home, Features, Dashboard, Status, (Admin), Support.
        tabs.insertBefore(tab, tabs.querySelector('[data-status]') || supportTab(tabs));
      } else if (!signedIn && tab && !tab.hasAttribute('data-static')) {
        tab.remove();
      }
    }
    var inBtn = doc.getElementById('navin');
    var acct = doc.getElementById('acct') || doc.getElementById('navout');
    if (inBtn) inBtn.hidden = signedIn;
    if (acct) acct.hidden = !signedIn;
    if (!signedIn) {
      adminTab(false);
      rememberMe(null);
      showMe(null);
    }
  }

  /* ---------- "Signed in as" with the person's Discord picture ---------- */

  // Remembered for this browser tab only, so the name appears straight away on the next page.
  function cachedMe() {
    try { return JSON.parse(root.sessionStorage.getItem('bev_me') || 'null'); } catch (e) { return null; }
  }
  function rememberMe(user) {
    try {
      if (user) root.sessionStorage.setItem('bev_me', JSON.stringify({ id: String(user.id), name: String(user.name), avatar: user.avatar || null }));
      else root.sessionStorage.removeItem('bev_me');
    } catch (e) { /* storage blocked: the name still appears once /api/me answers */ }
  }

  function pictureUrl(user) {
    var ok = /^\d{5,25}$/.test(String(user.id)) && typeof user.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(user.avatar);
    return ok ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64' : null;
  }

  function letter(name) {
    var span = doc.createElement('span');
    span.className = 'av xs';
    span.id = 'navav';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
    return span;
  }

  function showMe(user) {
    var me = doc.getElementById('navme');
    if (!me) return;
    if (!user || typeof user.name !== 'string' || !user.name) { me.hidden = true; return; }
    var name = doc.getElementById('navname');
    name.textContent = user.name;
    name.title = user.name;   // the whole name on hover, when a long one is cut short
    var old = doc.getElementById('navav');
    var url = pictureUrl(user);
    if (!(url && old.tagName === 'IMG' && old.getAttribute('src') === url)) {
      var pic = letter(user.name);
      if (url) {
        pic = doc.createElement('img');
        pic.className = 'av xs';
        pic.id = 'navav';
        pic.alt = '';
        pic.width = 28;
        pic.height = 28;
        pic.addEventListener('error', function () { pic.replaceWith(letter(user.name)); });
        pic.src = url;
      }
      old.replaceWith(pic);
    }
    me.hidden = false;
  }

  // The Admin tab, for site admins only. Remembered for this browser tab so it appears straight away.
  function adminTab(isAdmin) {
    try {
      if (isAdmin) root.sessionStorage.setItem('bev_admin', '1');
      else root.sessionStorage.removeItem('bev_admin');
    } catch (e) { /* storage blocked: the tab still appears after /api/me answers */ }
    var tabs = doc.querySelector('.tabs');
    if (!tabs) return;
    var tab = tabs.querySelector('[data-admin]');
    if (isAdmin && !tab) {
      tab = doc.createElement('a');
      tab.className = 'tab';
      tab.href = '/admin';
      tab.setAttribute('data-admin', '');
      tab.textContent = 'Admin';
      tabs.insertBefore(tab, supportTab(tabs));
    } else if (!isAdmin && tab && !tab.hasAttribute('data-static')) {
      tab.remove();
    }
  }

  function adminHint() {
    try { return root.sessionStorage.getItem('bev_admin') === '1'; } catch (e) { return false; }
  }

  function signOut() {
    var btn = doc.getElementById('navout');
    btn.disabled = true;
    root.fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('sign-out failed');
        clearFlag();
        btn.disabled = false;
        doc.dispatchEvent(new root.Event('bev:signedout'));
        if (/^\/dashboard/.test(root.location.pathname)) root.location.assign('/servers.html');
        else if (/^\/admin/.test(root.location.pathname)) root.location.assign('/');
      })
      .catch(function () {
        // Still signed in, so say so instead of pretending otherwise.
        btn.disabled = false;
        btn.textContent = 'Try again';
        root.setTimeout(function () { btn.textContent = 'Sign out'; }, 4000);
      });
  }

  // The announcement banner (added by the site's backend) can be closed. The cookie tells the backend
  // not to add this banner again; a new or changed banner has a new id, so it shows again.
  function banner() {
    var box = doc.getElementById('sitebanner');
    var close = doc.getElementById('sbclose');
    if (!box || !close) return;
    var id = box.getAttribute('data-id') || '';
    close.hidden = !/^[0-9a-f]{12}$/.test(id);
    close.addEventListener('click', function () {
      doc.cookie = 'bev_banner=' + id + '; Path=/; SameSite=Lax; Max-Age=31536000' + secure;
      box.remove();
    });
  }

  // What's new: after an update, people who are signed in get a popup listing every change since the last one they
  // saw (the list is in updates.js). "Got it" is saved to their account, so it doesn't show again on any device
  // until the next update. The browser keeps a copy too, so pages don't have to ask each time.
  var newsShown = false;
  function seenKey(user) { return 'bev_seen_update_' + user.id; }
  function seenHere(user) { try { return root.localStorage.getItem(seenKey(user)); } catch (e) { return null; } }
  function rememberSeen(user, id) { try { root.localStorage.setItem(seenKey(user), id); } catch (e) { /* storage blocked */ } }

  function unseenUpdates(list, seen) {
    if (!seen) return list.slice(0, 1);                  // never pressed Got it: just the latest update
    // Compared by place in the full list, so an update this reader doesn't get (admin-only) still counts as a marker.
    var all = (root.BEV_UPDATES || []).map(function (u) { return u.id; });
    var stop = all.indexOf(seen);
    var out = [];
    for (var i = 0; i < list.length && out.length < 10; i++) {
      if (list[i].id === seen || (stop >= 0 && all.indexOf(list[i].id) >= stop)) break;
      out.push(list[i]);
    }
    return out;
  }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function newsDialog(updates, onGotIt) {
    var box = el('dialog', 'askbox newsbox');
    box.setAttribute('aria-labelledby', 'newstitle');
    var head = el('h2', 'disp', "What's new on BEV");
    head.id = 'newstitle';
    box.appendChild(head);
    var count = updates.reduce(function (n, u) { return n + u.changes.length; }, 0);
    box.appendChild(el('p', 'newssub', count === 1 ? 'There is 1 change since you last visited.' : 'There are ' + count + ' changes since you last visited.'));
    var list = el('div', 'newslist');
    list.id = 'newslist';
    list.tabIndex = 0;
    updates.forEach(function (u) {
      list.appendChild(el('h3', 'newsver', 'Update ' + u.id + (u.date ? ' · ' + u.date : '')));
      u.changes.forEach(function (c) {
        var item = el('div', 'newsitem');
        item.appendChild(el('b', 'newsname', c.title));
        item.appendChild(el('p', null, c.text));
        list.appendChild(item);
      });
    });
    box.appendChild(list);
    var row = el('div', 'newsrow');
    var ok = el('button', 'newsok', '✅ Got it');
    ok.type = 'button';
    ok.id = 'newsok';
    row.appendChild(ok);
    box.appendChild(row);
    // Nothing else on the page works until Got it is pressed: no Escape, no clicking or scrolling behind it.
    var page = doc.documentElement;
    ok.addEventListener('click', function () { onGotIt(); box.close(); box.remove(); page.classList.remove('newsopen'); });
    box.addEventListener('cancel', function (e) { e.preventDefault(); });
    page.classList.add('newsopen');
    doc.body.appendChild(box);
    if (typeof box.showModal === 'function') box.showModal(); else box.setAttribute('open', '');
    ok.focus();
    return box;
  }

  // Changes marked admin: true are only for site admins: everyone else never sees them, and an update with
  // nothing else in it doesn't make the popup appear for them at all.
  function forReader(list, isAdmin) {
    if (!Array.isArray(list)) return [];
    return list.map(function (u) {
      var changes = (u.changes || []).filter(function (c) { return isAdmin || !c.admin; });
      return (u.admin && !isAdmin) || !changes.length ? null : { id: u.id, date: u.date, changes: changes };
    }).filter(Boolean);
  }

  function whatsNew(user, isAdmin) {
    var guess = forReader(root.BEV_UPDATES, !!isAdmin);
    if (newsShown || !user || !user.id || !guess.length) return;
    if (seenHere(user) === guess[0].id) return;
    newsShown = true;
    root.fetch('/api/updates', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { newsShown = false; return; }
        // The site says whether they're a site admin, so admin-only changes go only to admins.
        var list = forReader(root.BEV_UPDATES, d.admin === true);
        if (!list.length) return;
        var latest = list[0].id;
        var seen = d.seen || seenHere(user);
        if (seen === latest) { rememberSeen(user, latest); return; }
        var updates = unseenUpdates(list, seen);
        if (!updates.length) return;
        newsDialog(updates, function () {
          rememberSeen(user, latest);
          root.fetch('/api/updates', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify({ version: latest }) }).catch(function () { /* the browser still remembers */ });
        });
      })
      .catch(function () { newsShown = false; });
  }

  function boot() {
    banner();
    var out = doc.getElementById('navout');
    if (out) out.addEventListener('click', signOut);

    // Pages that learn the sign-in state themselves (My servers, the dashboard) tell the top bar, with who it is.
    doc.addEventListener('bev:signedin', function (e) {
      setFlag();
      show(true);
      var user = e && e.detail && e.detail.user;
      if (user && user.name) { rememberMe(user); showMe(user); whatsNew(user, adminHint()); }
    });
    doc.addEventListener('bev:signedout', function () { clearFlag(); show(false); });

    // Visitors who never signed in cost nothing: no flag, no request. (The dashboard and admin pages are
    // only ever sent to people who are signed in, so they always ask.)
    var acct = doc.getElementById('acct');
    if (!flagged() && !(acct && !acct.hidden)) { adminTab(false); return; }
    show(true);
    showMe(cachedMe());
    if (adminHint()) adminTab(true);
    root.fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { clearFlag(); show(false); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d) return;
        if (typeof d.admin === 'boolean') adminTab(d.admin);
        if (d.user && d.user.name) { setFlag(); rememberMe(d.user); showMe(d.user); whatsNew(d.user, d.admin === true); }
      })
      .catch(function () { /* offline or backend not reachable: leave the top bar as it is */ });
  }

  /* ---------- the top bar follows you down the page, a ☰ menu on phones, and Back to top ---------- */

  // Scroll animations: things below the fold fade in, grow slightly and rise as they come into view.
  function scrollReveal() {
    var path = location.pathname;
    if (!('IntersectionObserver' in window)) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var SEL = '.sec .card, .cards > *, .showgrid > *, .shead, .sec h2, .faq, .fig, .grid > *, .tabs, .note, .st, .sd, article, .srv, .dcard, .upd, .pvsection, .sec table, .sec .pill, footer .wrap > *';
    var seen = new WeakSet();
    var jumping = 0;
    // In view: fade, grow and sharpen in. Scrolled away: fade back out, ready to come in again next time.
    var io = new IntersectionObserver(function (entries) {
      var shown = 0;
      // Things coming in together cascade in reading order: top to bottom, then left to right.
      entries = entries.slice().sort(function (a, b) {
        return (a.boundingClientRect.top - b.boundingClientRect.top) || (a.boundingClientRect.left - b.boundingClientRect.left);
      });
      entries.forEach(function (e) {
        var el = e.target;
        // Hysteresis: a block comes in once 8% of it is on screen, but only goes back out when none of it is. Otherwise a
        // block sitting right at the edge flips between the two states for ever (each state moves it a little, which
        // flips the check again), flickering and never holding still.
        var inView = e.isIntersecting && (e.intersectionRatio >= 0.08 || el.classList.contains('rv-in'));
        if (e.isIntersecting && !inView) return;
        if (inView) {
          if (!el.classList.contains('rv-in')) el.style.transitionDelay = jumping ? '' : Math.min(shown++ * 60, 360) + 'ms';
          el.classList.add('rv-in');
        } else {
          el.style.transitionDelay = '';
          // Left through the top: it slides up and out (away from the screen), so it can't bounce back into view.
          el.classList.toggle('rv-up', e.boundingClientRect.top < (e.rootBounds ? e.rootBounds.top : 0));
          el.classList.remove('rv-in');
        }
      });
    }, { rootMargin: '-4% 0px -8% 0px', threshold: [0, 0.08] });
    var SKIP = 'header.nav, header, .hero, .skip, .modal, noscript, #news, dialog, .totop, .navholder, script, style, template, br';
    // Every page: walk down the page and animate blocks that fit on screen (big wrappers are split into their parts).
    function blocks(root, out) {
      var fold = innerHeight;
      for (var i = 0; i < root.children.length; i++) {
        var el = root.children[i];
        if (el.matches(SKIP) || el.classList.contains('rv')) continue;
        if (el.matches('button, input, select, textarea, label, .act, .mini, .seg, .row')) continue;   // controls stay put so clicks always land
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'sticky' || cs.position === 'absolute') continue;
        var r = el.getBoundingClientRect();
        if (!r.height || !r.width) continue;
        var many = el.tagName === 'MAIN' || el.tagName === 'FORM' || el.children.length >= 3 && (cs.display.indexOf('grid') > -1 || (cs.display.indexOf('flex') > -1 && cs.flexWrap === 'wrap') || el.tagName === 'UL' || el.tagName === 'OL');
        if ((r.height > fold * 0.6 || many) && el.children.length) { blocks(el, out); continue; }
        if (el.matches(SEL) || r.height > 24 || el.children.length) out.push(el);
      }
      return out;
    }
    function scan() {
      var fold = innerHeight;
      // Something that was small when first seen (like the dashboard before it loads) can grow far taller than the screen.
      // It can't fade in as one block then, so it stops being one, and its parts are picked up below instead.
      doc.querySelectorAll('.rv').forEach(function (el) {
        if (el.getBoundingClientRect().height > fold * 1.5) {
          io.unobserve(el);
          el.classList.remove('rv', 'rv-in', 'rv-up', 'rv-snap');
          el.style.transitionDelay = '';
        }
      });
      blocks(doc.body, []).forEach(function (el) {
        if (seen.has(el) || el.closest(SKIP)) return;
        seen.add(el);
        if (el.parentElement && el.parentElement.closest('.rv')) return;
        var r = el.getBoundingClientRect();
        if (r.height > fold * 1.5) return;      // too tall to fade in as one block (see above)
        if (r.top < fold * 0.92 && r.bottom > 0) el.classList.add('rv-snap', 'rv-in');   // already on screen: no flash
        el.classList.add('rv');
        io.observe(el);
      });
      requestAnimationFrame(function () { doc.querySelectorAll('.rv-snap').forEach(function (el) { if (!jumping) el.classList.remove('rv-snap'); }); });
    }
    scan();
    // Jumping to a section (an 'On this page' link, or a link with #) shows what's there at once so the target is in place.
    function showAll() {
      jumping++;
      doc.querySelectorAll('.rv').forEach(function (el) { el.style.transitionDelay = ''; el.classList.add('rv-snap', 'rv-in'); });
      setTimeout(function () {
        jumping--;
        doc.querySelectorAll('.rv-snap').forEach(function (el) { el.classList.remove('rv-snap'); });
      }, 900);
    }
    doc.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href*="#"]');
      if (a && a.hash && a.pathname === location.pathname) showAll();
    }, true);
    addEventListener('hashchange', showAll);
    if (location.hash) showAll();
    // The faster you scroll, the quicker things fade in and out (and the slower, the gentler).
    var lastY = scrollY, lastT = performance.now(), speed = 0, shownD = -1, settle = 0;
    function setDuration(d) {
      d = Math.round(d * 20) / 20;                      // steps of 0.05s, so the page isn't restyled on every frame
      if (d !== shownD) { shownD = d; doc.documentElement.style.setProperty('--rvd', d + 's'); }
    }
    addEventListener('scroll', function () {
      var now = performance.now(), dt = Math.max(now - lastT, 1);
      var v = Math.abs(scrollY - lastY) / dt;          // pixels per millisecond
      speed = speed * 0.6 + v * 0.4;
      lastY = scrollY; lastT = now;
      setDuration(Math.max(0.15, Math.min(0.9, 0.9 - speed * 0.25)));
      clearTimeout(settle);
      settle = setTimeout(function () { speed = 0; setDuration(0.6); }, 250);
    }, { passive: true });
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { requestAnimationFrame(function () { queued = false; scan(); }); }, 120);
    }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    addEventListener('resize', function () { requestAnimationFrame(scan); });
  }


  // Popups ease out before they close (and before they're removed), instead of vanishing.
  function smoothDialogs() {
    var D = root.HTMLDialogElement;
    if (!D || D.prototype._bevSmooth) return;
    if (root.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    D.prototype._bevSmooth = true;
    var close = D.prototype.close;
    // The popup really closes straight away (so the page works again at once); a copy of how it looked fades out on top, without catching clicks.
    D.prototype.close = function (value) {
      var d = this;
      if (!d.open || !d.classList.contains('askbox')) return close.call(d, value);
      var r = d.getBoundingClientRect();
      var cs = getComputedStyle(d);
      var ghost = doc.createElement('div');          // a plain copy, so nothing on the page mistakes it for the real popup
      ghost.innerHTML = d.innerHTML;
      ghost.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.className = 'dlgghost';
      ghost.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;margin:0;z-index:1000;pointer-events:none;overflow:hidden;box-sizing:border-box;display:' + cs.display +
        ';flex-direction:' + cs.flexDirection + ';padding:' + cs.padding + ';border:' + cs.border + ';border-radius:' + cs.borderRadius + ';background:' + cs.backgroundColor + ';box-shadow:' + cs.boxShadow + ';color:' + cs.color;
      var shade = doc.createElement('div');
      shade.className = 'dlgshade';
      doc.body.append(shade, ghost);
      ghost.scrollTop = d.scrollTop;
      ['.pvlist', '.newslist'].forEach(function (sel) {        // keep the list scrolled where it was
        var from = d.querySelector(sel), to = ghost.querySelector(sel);
        if (from && to) to.scrollTop = from.scrollTop;
      });
      close.call(d, value);
      setTimeout(function () { ghost.remove(); shade.remove(); }, 190);
    };
  }

  // The home page's moving background pauses when it's scrolled out of view.
  function pauseOffscreen() {
    if (!('IntersectionObserver' in root)) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { e.target.classList.toggle('offscreen', !e.isIntersecting); });
    });
    doc.querySelectorAll('.hero, .ticker').forEach(function (el) { io.observe(el); });
  }

  // The hover glow on cards follows the mouse.
  function hoverGlow() {
    var SEL = '.card, .cmd, .srv, .mod, a.cardlink, .lbsrv, .feat, .showitem, .dcard';
    var x = -1, y = -1, queued = false;
    function place() {
      queued = false;
      if (x < 0) return;
      var hit = doc.elementFromPoint(x, y);
      var el = hit && hit.closest && hit.closest(SEL);
      if (!el) return;
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (x - r.left) + 'px');
      el.style.setProperty('--my', (y - r.top) + 'px');
    }
    function later() { if (!queued) { queued = true; requestAnimationFrame(place); } }
    doc.addEventListener('pointermove', function (e) { x = e.clientX; y = e.clientY; later(); }, { passive: true });
    // Scrolling moves the page under a still mouse, so the glow is moved to stay under the cursor.
    addEventListener('scroll', later, { passive: true, capture: true });
    doc.documentElement.addEventListener('pointerleave', function () { x = y = -1; });
  }

  function navExtras() {
    var nav = doc.querySelector('header.nav');
    if (!nav || nav.getAttribute('data-extras')) return;
    nav.setAttribute('data-extras', '1');
    var page = doc.documentElement;

    // Phones: the tabs and buttons fold into a menu, so the bar is one short row.
    var menu = doc.createElement('button');
    menu.type = 'button';
    menu.className = 'navmenu';
    menu.id = 'navmenu';
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Menu');
    menu.innerHTML = '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>';
    var logo = nav.querySelector('.logo');
    if (logo && logo.nextSibling) nav.insertBefore(menu, logo.nextSibling); else nav.appendChild(menu);
    function setOpen(open) {
      nav.classList.toggle('open', open);
      menu.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.setAttribute('aria-label', open ? 'Close the menu' : 'Menu');
    }
    menu.addEventListener('click', function () { setOpen(!nav.classList.contains('open')); });
    nav.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a[href]')) setOpen(false); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && nav.classList.contains('open')) { setOpen(false); menu.focus(); } });
    doc.addEventListener('click', function (e) { if (nav.classList.contains('open') && !nav.contains(e.target)) setOpen(false); });

    // Once the bar has scrolled out of view it comes back, pinned to the top, so the tabs are always one click away.
    // A placeholder keeps its space on the page, so nothing jumps.
    var holder = doc.createElement('div');
    holder.className = 'navholder';
    holder.hidden = true;
    nav.parentNode.insertBefore(holder, nav);
    var bottom = 0;
    function measure() {
      if (nav.classList.contains('fixed')) return;
      var r = nav.getBoundingClientRect();
      bottom = r.bottom + root.pageYOffset;
      holder.style.height = r.height + 'px';
    }

    // Back to top, on long pages once you've scrolled a while.
    var up = doc.createElement('button');
    up.type = 'button';
    up.className = 'totop';
    up.id = 'totop';
    up.setAttribute('aria-label', 'Back to top');
    up.title = 'Back to top';
    up.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    up.hidden = true;
    doc.body.appendChild(up);
    up.addEventListener('click', function () {
      root.scrollTo({ top: 0, behavior: 'smooth' });
      var skip = doc.querySelector('.logo');
      if (skip) skip.focus({ preventScroll: true });
    });

    var ticking = false;
    var closedHeight = 0;
    function update() {
      ticking = false;
      if (page.classList.contains('newsopen')) return;
      var y = root.pageYOffset;
      var fix = y > bottom + 40;
      if (fix !== nav.classList.contains('fixed')) {
        holder.hidden = !fix;
        nav.classList.toggle('fixed', fix);
        if (!fix) setOpen(false);
      }
      page.style.setProperty('--navh', fix ? nav.offsetHeight + 'px' : '0px');
      // How tall the pinned bar is (or will be), so a link to a section never hides its heading under the bar.
      // The ☰ menu closes when a link is followed, so the closed bar's height is the one that counts.
      if (!nav.classList.contains('open')) closedHeight = nav.offsetHeight;
      var barHeight = closedHeight || nav.offsetHeight;
      page.style.setProperty('--navfix', (fix ? barHeight : Math.max(0, barHeight - 20)) + 'px');
      var long = doc.documentElement.scrollHeight > root.innerHeight * 2.5;
      up.hidden = !(long && y > root.innerHeight * 0.8);
    }
    function onScroll() { if (!ticking) { ticking = true; root.requestAnimationFrame(update); } }
    measure();
    update();
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('resize', function () { if (!nav.classList.contains('fixed')) measure(); onScroll(); });
    root.addEventListener('load', function () { measure(); update(); });
    // The top bar can change height when the account pill or Admin tab appears.
    // (and when the ☰ menu opens or closes), so the space kept for it under section links is always up to date.
    if (root.ResizeObserver) new root.ResizeObserver(function () { measure(); onScroll(); }).observe(nav);
  }

  /* ---------- 4.64: the Premium tab, only once BEV's owner has switched Premium on ---------- */
  function premiumTab() {
    var tabs = doc.querySelector('.tabs');
    if (!tabs) return;
    function put(on) {
      var tab = tabs.querySelector('[data-premium]');
      if (on && !tab) {
        tab = doc.createElement('a');
        tab.className = 'tab ptab';
        tab.href = '/premium';
        tab.textContent = '💎 Premium';
        tab.setAttribute('data-premium', '');
        if (/^\/premium\/?$/.test(root.location.pathname)) tab.setAttribute('aria-current', 'page');
        tabs.insertBefore(tab, tabs.firstChild ? tabs.firstChild.nextSibling : null);
      } else if (!on && tab) tab.remove();
    }
    var cached = null;
    try { cached = JSON.parse(root.sessionStorage.getItem('bev_premium') || 'null'); } catch (e) { cached = null; }
    if (cached && Date.now() - cached.at < 300000) { put(cached.on); return; }
    root.fetch('/api/premium', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (d) {
        var on = !!(d && d.enabled);
        try { root.sessionStorage.setItem('bev_premium', JSON.stringify({ on: on, at: Date.now() })); } catch (e) { /* private mode */ }
        put(on);
      }, function () { /* offline: no tab */ });
  }

  navExtras();
  premiumTab();
  scrollReveal();
  hoverGlow();
  smoothDialogs();
  pauseOffscreen();
  boot();
})(window);
