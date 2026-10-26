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

  function boot() {
    banner();
    var out = doc.getElementById('navout');
    if (out) out.addEventListener('click', signOut);

    // Pages that learn the sign-in state themselves (My servers, the dashboard) tell the top bar, with who it is.
    doc.addEventListener('bev:signedin', function (e) {
      setFlag();
      show(true);
      var user = e && e.detail && e.detail.user;
      if (user && user.name) { rememberMe(user); showMe(user); }
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
        if (d.user && d.user.name) { setFlag(); rememberMe(d.user); showMe(d.user); }
        if (typeof d.admin === 'boolean') adminTab(d.admin);
      })
      .catch(function () { /* offline or backend not reachable: leave the top bar as it is */ });
  }

  boot();
})(window);
