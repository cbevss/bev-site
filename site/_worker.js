/*
 * BEV backend for Cloudflare Pages (advanced mode).
 *
 * All secrets live in the Pages project's Settings > Variables and Secrets, never in the site files:
 *   DISCORD_CLIENT_SECRET  secret    Discord application client secret (sign-in)
 *   DISCORD_BOT_TOKEN      secret    bot token, only used to list the servers BEV is in
 *   SESSION_SECRET         secret    32+ random characters, encrypts the sign-in cookie
 *   BOT_API_KEY            secret    must be exactly the same as BOT_API_KEY in the bot's settings
 *   BOT_API_BASE           variable  https://your-service.onrender.com
 *   DISCORD_CLIENT_ID      variable  optional, defaults to BEV's client ID
 *   SITE_ADMIN_IDS         variable  optional: Discord user IDs (separated by commas) that get the Admin tab.
 *                                    When set, it replaces the built-in list (DEFAULT_ADMIN_IDS below).
 * And one binding (Settings > Bindings > D1 database):
 *   SITE_DB                D1 database for maintenance mode, the announcement banner and visit counts.
 *                          Without it the site still works, just without those three.
 * For the Discord and session settings, template text that starts with YOUR_ counts as "not set".
 *
 * Every administrator (or owner) of a server BEV is in can open that server's dashboard, and only that
 * server's: every request names one server, and this file checks the signed-in person administers it.
 * Site admins (the Discord accounts listed below) also get /admin: maintenance mode, the Discord alert, the
 * banner, visits and a connection check. That is checked here on every request, so hiding the tab is not the protection.
 *
 * Routes: /auth/login /auth/callback /auth/logout
 *         /api/me /api/servers /api/config /api/level-roles (GET and POST) /api/messages (POST)   (signed in)
 *         /api/leaderboard /api/status                        (public: the bot decides what is public)
 *         /api/admin/state /api/admin/maintenance /api/admin/banner /api/admin/check
 *         /api/admin/alert /api/admin/alert/send                                       (site admins)
 *         /dashboard (signed in) and /admin (site admins)
 * Every other page is served as a normal file, with maintenance mode, the banner and visit counting on top.
 */

const DISCORD = 'https://discord.com/api/v10';
const CLIENT_ID_DEFAULT = '1562204643755429980';
const ADMINISTRATOR = 0x8n;
const SESSION_TTL = 2 * 60 * 60; // seconds
const STATE_TTL = 10 * 60;
const ID_RE = /^\d{5,25}$/;
const KEY_RE = /^[a-z0-9_]{1,64}$/;
const MAX_BODY = 200 * 1024; // the whole dashboard of one server fits easily
const te = new TextEncoder();
const td = new TextDecoder();

// The Discord accounts that get the Admin tab. A SITE_ADMIN_IDS setting in Cloudflare replaces this list.
const DEFAULT_ADMIN_IDS = ['1218359974757924934', '382429959886602265', '1492355672988450857'];
// Built-in regular admins: they can use /admin but can't add or remove admins. (Main admins can still remove them there.)
const DEFAULT_REGULAR_ADMIN_IDS = ['1443919792435363900'];
// The only accounts that can add, remove or change site admins on /admin. Fixed here on purpose: nobody can add
// themselves to it from the page. They can remove or change each other (never themselves).
const ADMIN_MANAGER_IDS = ['1218359974757924934', '382429959886602265', '1492355672988450857'];
const STATS_ZONE = 'Europe/London';  // visit counts are grouped by UK days
const SETTINGS_TTL = 10 * 1000;     // each Cloudflare copy of this file re-reads maintenance and banner settings this often
const DURATIONS = [0, 15, 30, 60, 120, 240, 480, 720, 1440]; // maintenance lengths in minutes; 0 = until an admin turns it off
const DEFAULT_MESSAGE = "We're carrying out scheduled maintenance to improve bevbotdiscord.com, so the website is temporarily unavailable. "
  + "The BEV bot isn't affected and keeps running in Discord as normal. Thank you for your patience. We'll be back shortly.";
// The pages visits are counted for, with the names the admin page shows.
const PAGES = { '/appeal': 'Ban appeal', '/suggest': 'Suggest an idea', '/discover': 'Find a server', '/': 'Home', '/features': 'Features', '/support': 'Support', '/status': 'Bot status', '/leaderboard': 'Leaderboard',
  '/servers': 'My servers', '/dashboard': 'Dashboard', '/terms': 'Terms of Service', '/privacy': 'Privacy Policy' };
// Link previews, crawlers, uptime monitors and scripts don't count as visits.
const NOT_A_PERSON = /bot|crawl|spider|slurp|preview|monitor|uptime|curl|wget|python|httpclient|headless|lighthouse|facebookexternalhit|embedly|whatsapp/i;
const STATIC_FILE = /^\/[\w.-]+\.(?:css|js|png|jpe?g|gif|svg|ico|webp|txt|xml|webmanifest|woff2?)$/;
const DASHBOARD_PATHS = new Set(['/dashboard', '/dashboard/', '/dashboard.html', '/jail-requests', '/jail-requests/', '/jail-requests.html']);
const ADMIN_PATHS = new Set(['/admin', '/admin/', '/admin.html', '/admin-suggestions', '/admin-suggestions/', '/admin-suggestions.html', '/admin-support', '/admin-support/', '/admin-support.html']);
const BANNER_STYLES = ['info', 'warning', 'success'];

class Upstream extends Error {
  constructor(status) { super('upstream ' + status); this.status = status; }
}

// The bot API address must be a full https address with a real host, e.g. https://bev-api.onrender.com
function botBase(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.hostname === 'onrender.com') return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function config(env) {
  const raw = (k) => String(env[k] ?? '').trim();
  // Template text such as YOUR_..._HERE counts as "not set" for everything that protects sign-in.
  const get = (k) => {
    const v = raw(k);
    return v && !/^YOUR_/i.test(v) ? v : '';
  };
  const sessionSecret = get('SESSION_SECRET');
  return {
    clientId: get('DISCORD_CLIENT_ID') || CLIENT_ID_DEFAULT,
    clientSecret: get('DISCORD_CLIENT_SECRET'),
    botToken: get('DISCORD_BOT_TOKEN'),
    sessionSecret: sessionSecret.length >= 32 ? sessionSecret : '',
    sessionSecretShort: sessionSecret.length > 0 && sessionSecret.length < 32,
    botApiBase: botBase(raw('BOT_API_BASE')),
    // Sent as-is: it has to match the text the bot checks, including a value you chose yourself.
    botApiKey: raw('BOT_API_KEY'),
    ...adminList(raw('SITE_ADMIN_IDS')),
  };
}

// SITE_ADMIN_IDS (any IDs in it, separated by commas or spaces) replaces the built-in list.
function adminList(value) {
  const ids = [...new Set(value.split(/[\s,;]+/).filter((id) => ID_RE.test(id)))];
  return ids.length ? { adminIds: ids, adminFromSetting: true } : { adminIds: DEFAULT_ADMIN_IDS, adminFromSetting: false };
}

/* ---------- encrypted session cookie (AES-GCM) ---------- */

const toB64u = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function aesKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', te.encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(obj, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64u(out);
}

async function unseal(token, secret) {
  try {
    const raw = fromB64u(token);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(secret), raw.slice(12));
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

const cookieNames = (secure) => ({
  session: (secure ? '__Host-' : '') + 'bev_session',
  state: (secure ? '__Host-' : '') + 'bev_state',
});

function readCookies(request) {
  const out = {};
  (request.headers.get('cookie') || '').split(/;\s*/).forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  });
  return out;
}

const setCookie = (name, value, maxAge, secure) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

// A plain flag the pages read so the Dashboard tab can show straight away. It holds no secret and
// grants nothing: every page and API call still checks the real, encrypted session.
const hintCookie = (on, secure) =>
  `bev_in=${on ? '1' : ''}; Path=/; SameSite=Lax; Max-Age=${on ? SESSION_TTL : 0}${secure ? '; Secure' : ''}`;

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readSession(request, c, secure) {
  if (!c.sessionSecret) return null;
  const raw = readCookies(request)[cookieNames(secure).session];
  if (!raw) return null;
  const s = await unseal(raw, c.sessionSecret);
  return s && typeof s.exp === 'number' && s.exp > Date.now() && typeof s.tok === 'string' && s.user ? s : null;
}

/* ---------- responses ---------- */

function json(data, status = 200, cookies = []) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  cookies.forEach((c) => h.append('set-cookie', c));
  return new Response(JSON.stringify(data), { status, headers: h });
}

function redirect(location, cookies = []) {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  cookies.forEach((c) => h.append('set-cookie', c));
  return new Response(null, { status: 302, headers: h });
}

/* ---------- Discord ---------- */

async function discord(path, authorization) {
  const r = await fetch(DISCORD + path, { headers: { authorization } });
  if (!r.ok) throw new Upstream(r.status);
  return r.json();
}

function isAdmin(g) {
  if (g.owner === true) return true;
  try {
    return (BigInt(g.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

// The servers BEV is in, from Discord with the bot token. Cached for a minute.
let botCache = { at: 0, ids: null };
async function botGuildIds(c) {
  if (!c.botToken) return null;
  if (botCache.ids && Date.now() - botCache.at < 60000) return botCache.ids;
  const ids = new Set();
  let after = '';
  for (let page = 0; page < 50; page++) {
    const list = await discord('/users/@me/guilds?limit=200' + (after ? '&after=' + after : ''), 'Bot ' + c.botToken);
    list.forEach((g) => ids.add(g.id));
    if (list.length < 200) break;
    after = list[list.length - 1].id;
  }
  botCache = { at: Date.now(), ids };
  return ids;
}

// Servers the user administers, whether BEV is in each, and which dashboards they may open:
// every one they administer that BEV is in. Unknown bot presence opens nothing.
async function buildView(guilds, c, userId) {
  let botIds = null;
  try { botIds = await botGuildIds(c); } catch { botIds = null; }
  const valid = guilds.filter((g) => g && ID_RE.test(String(g.id)));
  const servers = valid
    .filter((g) => isAdmin(g))
    .map((g) => ({
      id: g.id,
      name: String(g.name ?? ''),
      icon: g.icon || null,
      owner: g.owner === true,
      botPresent: botIds ? botIds.has(g.id) : null,
      dashboard: !!botIds && botIds.has(g.id),
      access: 'full',
    }));
  // Servers where they aren't an admin but were given Dashboard Access (the bot decides, from their roles).
  const others = botIds && userId ? valid.filter((g) => !isAdmin(g) && botIds.has(g.id)).slice(0, 200) : [];
  if (others.length) {
    const res = await bot(c, '/api/access', { method: 'POST', body: JSON.stringify({ user_id: String(userId), guild_ids: others.map((g) => String(g.id)) }) });
    const access = res.status === 200 && res.data && typeof res.data.access === 'object' && res.data.access ? res.data.access : {};
    for (const g of others) {
      if (!Array.isArray(access[g.id]) || !access[g.id].length) continue;
      servers.push({ id: g.id, name: String(g.name ?? ''), icon: g.icon || null, owner: false, botPresent: true, dashboard: true, access: 'limited' });
    }
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    servers,
    botKnown: !!botIds,
    canDashboard: servers.some((s) => s.dashboard),
  };
}

const viewCache = new Map();
async function loadView(session, c, fresh) {
  const hit = viewCache.get(session.user.id);
  if (!fresh && hit && hit.tok === session.tok && Date.now() - hit.at < 60000) return hit.view;
  const guilds = await discord('/users/@me/guilds', 'Bearer ' + session.tok);
  const view = await buildView(guilds, c, session.user.id);
  if (viewCache.size > 500) viewCache.clear();
  viewCache.set(session.user.id, { at: Date.now(), tok: session.tok, view });
  return view;
}

/* ---------- auth routes ---------- */

// Pages sign-in may come back to: a tournament bracket, or a ban appeal page.
const BACK_RE = /^(?:\/bracket\/\d{15,25}\/\d{1,10}|\/appeal\?guild=\d{5,25})$/;

function login(c, url, secure) {
  if (!c.clientSecret || !c.sessionSecret) return redirect('/servers.html?error=' + (c.sessionSecretShort ? 'secret_short' : 'setup'));
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const target = 'https://discord.com/oauth2/authorize?client_id=' + c.clientId +
    '&response_type=code&scope=identify%20guilds&state=' + state +
    '&redirect_uri=' + encodeURIComponent(url.origin + '/auth/callback');
  const next = url.searchParams.get('next') || '';
  const back = BACK_RE.test(next) ? next : '';
  return redirect(target, [setCookie(cookieNames(secure).state, state + (back ? '|' + back : ''), STATE_TTL, secure)]);
}

async function callback(request, c, url, secure) {
  const N = cookieNames(secure);
  const clearState = setCookie(N.state, '', 0, secure);
  const fail = (code) => redirect('/servers.html?error=' + code, [clearState]);
  if (!c.clientSecret || !c.sessionSecret) return fail(c.sessionSecretShort ? 'secret_short' : 'setup');

  if (url.searchParams.get('error')) return fail('cancelled');
  const state = url.searchParams.get('state') || '';
  const stored = readCookies(request)[N.state] || '';
  const expected = stored.split('|')[0];
  const back = BACK_RE.test(stored.split('|')[1] || '') ? stored.split('|')[1] : '';
  if (!state || !expected || !safeEqual(state, expected)) return fail('state');
  const code = url.searchParams.get('code');
  if (!code) return fail('state');

  try {
    const tokenRes = await fetch(DISCORD + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: url.origin + '/auth/callback',
      }),
    });
    if (!tokenRes.ok) {
      // Say which setting is wrong, so it can be fixed (never the secret itself).
      let reason = '';
      try { reason = String((await tokenRes.json()).error || ''); } catch { reason = ''; }
      return fail(reason === 'invalid_client' ? 'client' : reason === 'invalid_grant' ? 'grant' : 'token');
    }
    const token = await tokenRes.json();
    if (!token.access_token) return fail('token');

    const user = await discord('/users/@me', 'Bearer ' + token.access_token);
    if (!user || !ID_RE.test(String(user.id))) return fail('discord');
    const session = await seal({
      user: { id: user.id, name: String(user.global_name || user.username || 'Discord user').slice(0, 64), username: String(user.username || '').slice(0, 64) || null, avatar: user.avatar || null },
      tok: token.access_token,
      exp: Date.now() + SESSION_TTL * 1000,
    }, c.sessionSecret);
    return redirect(back || '/servers.html', [clearState, setCookie(N.session, session, SESSION_TTL, secure), hintCookie(true, secure)]);
  } catch {
    return fail('discord');
  }
}

async function logout(request, c, url, secure) {
  if (request.headers.get('origin') !== url.origin) return json({ error: 'bad_origin' }, 403);
  const session = await readSession(request, c, secure);
  if (session) {
    viewCache.delete(session.user.id);
    // Ask Discord to cancel the access token too, so signing out really ends the access. Best effort.
    try {
      await fetch(DISCORD + '/oauth2/token/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, token: session.tok, token_type_hint: 'access_token' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* the cookie is cleared either way */ }
  }
  return json({ ok: true }, 200, [setCookie(cookieNames(secure).session, '', 0, secure), hintCookie(false, secure)]);
}

/* ---------- talking to the bot ---------- */

// Calls the bot's own API. The X-API-Key never leaves this file. Returns { status, data }.
async function bot(c, path, init = {}) {
  if (!c.botApiBase || !c.botApiKey) return { status: 0, error: 'bot_not_configured' };
  try {
    const r = await fetch(c.botApiBase + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-api-key': c.botApiKey },
      // A bot that has just restarted can take close to a minute to answer. The bot answers its own slow jobs by 45s.
      signal: AbortSignal.timeout(60000),
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    return { status: r.status, data };
  } catch {
    return { status: 0, error: 'bot_unreachable' };
  }
}

// Turns a bot answer into a response for the browser, without passing on anything unexpected.
function botAnswer(res) {
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 401) return json({ error: 'bot_rejected_key' }, 502);
  if (res.status === 403) return json({ error: 'no_access', message: str(res.data && res.data.error), problems: problems(res.data && res.data.problems) }, 403);
  if (res.status === 503) return json({ error: 'bot_starting' }, 503);
  if (res.status === 404) return json({ error: 'bot_not_in_server' }, 404);
  if (res.status === 400) return json({ error: 'invalid', message: str(res.data && res.data.error), problems: problems(res.data && res.data.problems) }, 400);
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return json({ error: 'bot_error', status: res.status }, 502);
  return null;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
function problems(list) {
  return Array.isArray(list) ? list.slice(0, 50).map((p) => ({ key: str(p && p.key, 64), message: str(p && p.message) })) : [];
}

// Only the parts of a save the bot understands, checked for shape. The bot checks every value again.
function cleanSave(body, guildId, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const features = {};
  const settings = {};
  const f = body.features ?? {};
  const s = body.settings ?? {};
  if (typeof f !== 'object' || Array.isArray(f) || typeof s !== 'object' || Array.isArray(s)) return null;
  for (const [k, v] of Object.entries(f)) {
    if (!KEY_RE.test(k) || typeof v !== 'boolean') return null;
    features[k] = v;
  }
  for (const [k, v] of Object.entries(s)) {
    if (!KEY_RE.test(k)) return null;
    settings[k] = v;
  }
  if (!Object.keys(features).length && !Object.keys(settings).length) return null;
  // Features being switched off whose channels, categories and roles should stay (the "Keep them instead" box).
  const k = body.keep ?? [];
  if (!Array.isArray(k) || k.length > 100) return null;
  const keep = [];
  for (const key of k) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    if (features[key] === false && !keep.includes(key)) keep.push(key);
  }
  return { guild_id: guildId, features, settings, actor, keep };
}

let statusCache = { at: 0, body: null };

let directoryCache = { at: 0, body: null };
const INVITE_RE = /^https:\/\/discord\.gg\/[A-Za-z0-9-]{2,32}$/;

// Find a server: only servers that switched on Server Listing. Cached for a minute, and every field is checked.
async function directoryApi(c) {
  if (directoryCache.body && Date.now() - directoryCache.at < 60000) return json(directoryCache.body);
  const res = await bot(c, '/api/directory');
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.servers)) {
    if (directoryCache.body) return json(directoryCache.body);
    return json({ error: 'bot_unreachable' }, 503);
  }
  const servers = res.data.servers.slice(0, 300).map((s) => ({
    id: ID_RE.test(String(s && s.id)) ? String(s.id) : '', name: str(s && s.name, 100), icon: /^https:\/\/cdn\.discordapp\.com\//.test(str(s && s.icon, 300)) ? str(s.icon, 300) : null,
    members: Number(s && s.members) || 0, description: str(s && s.description, 300),
    tags: (Array.isArray(s && s.tags) ? s.tags : []).slice(0, 5).map((t) => str(t, 20).toLowerCase()).filter(Boolean),
    invite: INVITE_RE.test(str(s && s.invite, 60)) ? s.invite : null, bumped: Number(s && s.bumped) || 0,
  })).filter((s) => s.id && s.name && s.invite);
  directoryCache = { at: Date.now(), body: { servers } };
  return json(directoryCache.body);
}

async function publicApi(request, c, url) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (url.pathname === '/api/directory') return directoryApi(c);
  if (url.pathname === '/api/status') {
    if (statusCache.body && Date.now() - statusCache.at < 30000) return json(statusCache.body);
    const res = await bot(c, '/api/status');
    const d = res.status === 200 && res.data ? res.data : null;
    const body = d
      ? { online: d.online === true, servers: Number(d.servers) || 0, latency_ms: Number.isFinite(d.latency_ms) ? d.latency_ms : null,
          uptime_s: Number(d.uptime_s) || 0, version: str(d.version, 20), commands: Number(d.commands) || 0, checked: Date.now(),
          history: (Array.isArray(d.history) ? d.history : []).slice(-168).map((v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null)) }
      : { online: false, reachable: false, checked: Date.now() };
    statusCache = { at: Date.now(), body };
    return json(body);
  }
  const guildId = url.searchParams.get('guild_id') || '';
  if (!ID_RE.test(guildId)) return json({ error: 'bad_request' }, 400);
  const res = await bot(c, '/api/leaderboard?guild_id=' + guildId);
  if (res.status === 403) return json({ error: 'private' }, 403);
  const problem = botAnswer(res);
  if (problem) return problem;
  const d = res.data;
  return json({
    guild: { id: str(d.guild && d.guild.id, 25), name: str(d.guild && d.guild.name, 100), icon: str(d.guild && d.guild.icon, 300) || null },
    members: (Array.isArray(d.members) ? d.members : []).slice(0, 100).map((m) => ({
      place: Number(m.place) || 0, name: str(m.name, 64), avatar: str(m.avatar, 300), level: Number(m.level) || 0,
      xp: Number(m.xp) || 0, needed: Number(m.needed) || 1, coins: Number(m.coins) || 0,
    })),
    week: (Array.isArray(d.week) ? d.week : []).slice(0, 10).map((m) => ({
      place: Number(m.place) || 0, name: str(m.name, 64), avatar: str(m.avatar, 300), gained: Number(m.gained) || 0, level: Number(m.level) || 0,
    })),
    week_from: Number.isFinite(d.week_from) ? d.week_from : null,
  });
}

const PRIVATE = { '/api/suggest': ['POST'], '/api/me': ['GET'], '/api/servers': ['GET'], '/api/config': ['GET', 'POST'], '/api/level-roles': ['GET', 'POST'], '/api/messages': ['POST'],
                  '/api/action': ['POST'], '/api/members': ['GET'], '/api/preview': ['POST'], '/api/bracket': ['GET'],
                  '/api/support/mine': ['GET'], '/api/support/new': ['POST'], '/api/support/ticket': ['GET'], '/api/support/topic': ['POST'],
                  '/api/support/send': ['POST'], '/api/support/close': ['POST'], '/api/appeal': ['GET', 'POST'] };

async function api(request, c, url, secure, s, env) {
  const path = url.pathname;
  if (path === '/api/premium' || path === '/api/premium/checkout' || path === '/api/premium/manage') return premiumApi(request, env, c, url, s, path);
  if (path === '/api/status' || path === '/api/leaderboard' || path === '/api/directory') return publicApi(request, c, url);
  if (!Object.prototype.hasOwnProperty.call(PRIVATE, path)) return json({ error: 'not_found' }, 404);
  if (!PRIVATE[path].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
  if (!c.sessionSecret || !c.clientSecret) return json({ error: 'not_configured' }, 503);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return json({ error: 'bad_origin' }, 403);

  const session = s.session;
  if (!session) return json({ error: 'signed_out' }, 401, [hintCookie(false, secure)]);

  // Cheap on purpose: the top bar asks this on page loads, so it never calls Discord.
  // "admin" only decides whether the top bar shows the Admin tab; /admin and its API check again.
  if (path === '/api/me') return json({ user: session.user, admin: s.admin });
  if (path === '/api/suggest') return sendSuggestion(request, c, s);
  if (path === '/api/appeal') return banAppeal(request, c, url, s);
  if (path.startsWith('/api/support/')) return supportChat(request, c, url, s, path);
  // A tournament bracket: anyone signed in can ask, and the bot only answers members of that server.
  if (path === '/api/bracket') {
    const guildId = url.searchParams.get('guild_id') || '';
    const id = url.searchParams.get('id') || '';
    if (!ID_RE.test(guildId) || !/^\d{1,10}$/.test(id)) return json({ error: 'bad_request' }, 400);
    const res = await bot(c, '/api/bracket?guild_id=' + guildId + '&id=' + id + '&viewer_id=' + String(session.user.id));
    if (res.status === 403 || res.status === 404) return json(res.data || { error: 'not_found' }, res.status);
    return botAnswer(res) || json(res.data);
  }

  let view;
  try {
    view = await loadView(session, c, path === '/api/servers' && url.searchParams.get('fresh') === '1');
  } catch (e) {
    if (e instanceof Upstream && e.status === 401) {
      return json({ error: 'signed_out' }, 401, [setCookie(cookieNames(secure).session, '', 0, secure), hintCookie(false, secure)]);
    }
    return json({ error: 'discord_unavailable' }, 502);
  }

  if (path === '/api/servers') return json({ user: session.user, ...view });

  // Only a server this user administers (or was given Dashboard Access in) and BEV is in. The bot also checks it is in the server.
  const allowed = (id) => typeof id === 'string' && ID_RE.test(id) && view.servers.some((s) => s.id === id && s.dashboard);
  // Who is looking, for the bot: someone who isn't an admin there only gets the parts they were given.
  allowed.siteAdmin = !!s.admin;     // BEV's site admins: some bot actions (like Role Permissions) skip the server's own rules for them
  allowed.viewer = (id) => {
    const server = view.servers.find((s) => s.id === id);
    return { viewer_id: String(session.user.id), viewer_full: !!server && server.access !== 'limited' };
  };
  const viewerQuery = (id) => { const v = allowed.viewer(id); return '&viewer_id=' + v.viewer_id + '&viewer_full=' + (v.viewer_full ? '1' : '0'); };

  if (path === '/api/level-roles') return levelRoles(request, c, url, session, allowed);
  if (path === '/api/messages') return sendMessage(request, c, session, allowed);
  if (path === '/api/action') return webAction(request, c, session, allowed);
  if (path === '/api/preview') return previewApi(request, c, session, allowed);
  if (path === '/api/members') return findMembers(c, url, allowed);

  if (request.method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || '';
    if (!ID_RE.test(guildId)) return json({ error: 'bad_request' }, 400);
    if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
    const res = await bot(c, '/api/config?guild_id=' + guildId + viewerQuery(guildId));
    return botAnswer(res) || json(res.data);
  }

  const length = Number(request.headers.get('content-length') || '0');
  if (length > MAX_BODY) return json({ error: 'too_large' }, 413);
  let text;
  try { text = await request.text(); } catch { return json({ error: 'bad_request' }, 400); }
  if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad_request' }, 400); }
  const guildId = body && body.guild_id;
  if (typeof guildId !== 'string' || !ID_RE.test(guildId)) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const save = cleanSave(body, guildId, `${session.user.name} (${session.user.id}) on the website`);
  if (!save) return json({ error: 'bad_request' }, 400);
  const res = await bot(c, '/api/config', { method: 'POST', body: JSON.stringify({ ...save, ...allowed.viewer(guildId) }) });
  return botAnswer(res) || json({ ok: true, notes: (Array.isArray(res.data.notes) ? res.data.notes : []).slice(0, 80).map((n) => str(n, 500)), config: res.data.config });
}

/* ---------- making level roles (BEV creates roles named after levels, for a server you administer) ---------- */

async function levelRoles(request, c, url, session, allowed) {
  if (request.method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || '';
    if (!ID_RE.test(guildId)) return json({ error: 'bad_request' }, 400);
    if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
    const v = allowed.viewer(guildId);
    const res = await bot(c, '/api/level-roles?guild_id=' + guildId + '&viewer_id=' + v.viewer_id + '&viewer_full=' + (v.viewer_full ? '1' : '0'));
    return levelRolesProblem(res) || json({ job: cleanLevelJob(res.data.job) });
  }
  const body = await readJson(request, 2000);
  const guildId = body && body.guild_id;
  const count = body && body.count;
  if (typeof guildId !== 'string' || !ID_RE.test(guildId) || !Number.isInteger(count) || count < 1 || count > 100) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const res = await bot(c, '/api/level-roles', {
    method: 'POST', body: JSON.stringify({ guild_id: guildId, count, actor: `${session.user.name} (${session.user.id}) on the website`, ...allowed.viewer(guildId) }),
  });
  return levelRolesProblem(res) || json({ ok: true, job: cleanLevelJob(res.data.job) });
}

function levelRolesProblem(res) {
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 401) return json({ error: 'bot_rejected_key' }, 502);
  if (res.status === 403) return json({ error: 'no_access' }, 403);
  if (res.status === 404 && !(res.data && res.data.error)) return json({ error: 'bot_outdated' }, 501);
  if (res.status === 404) return json({ error: 'bot_not_in_server' }, 404);
  if (res.status === 503) return json({ error: 'bot_starting' }, 503);
  if (res.status === 409) return json({ error: 'busy' }, 409);
  if (res.status === 400) return json({ error: 'refused', message: str(res.data && res.data.error, 300) }, 400);
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return json({ error: 'bot_error', status: res.status }, 502);
  return null;
}

function cleanLevelJob(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return {
    state: j.state === 'running' ? 'running' : 'done',
    levels: (Array.isArray(j.levels) ? j.levels : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100).slice(0, 100),
    total: whole(j.total), done: whole(j.done), created: whole(j.created), reused: whole(j.reused),
    failed: (Array.isArray(j.failed) ? j.failed : []).slice(0, 25).map((f) => ({ level: whole(f && f.level), reason: str(f && f.reason, 200) })),
    started: whole(j.started_at), finished: whole(j.finished_at) || null,
  };
}

/* ---------- the Message Designer: send a saved message, or update the copy sent before, in a server you administer ---------- */

const TEMPLATE_RE = /^[a-z0-9]{4,12}$/;
const MESSAGE_LINK_RE = /^https:\/\/discord\.com\/channels\/\d{5,25}\/\d{5,25}\/\d{5,25}$/;

async function sendMessage(request, c, session, allowed) {
  const body = await readJson(request, 2000);
  const guildId = body && body.guild_id;
  const templateId = body && body.template_id;
  const mode = body && body.mode;
  if (typeof guildId !== 'string' || !ID_RE.test(guildId) || typeof templateId !== 'string' || !TEMPLATE_RE.test(templateId)
      || (mode !== 'send' && mode !== 'update')) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const res = await bot(c, '/api/custom-messages/send', {
    method: 'POST', body: JSON.stringify({ guild_id: guildId, template_id: templateId, mode, actor: `${session.user.name} (${session.user.id}) on the website`, ...allowed.viewer(guildId) }),
  });
  return levelRolesProblem(res) || json({ ok: true, posted: cleanPosted(res.data.posted) });
}

/* ---------- buttons on dashboard cards, and the member search, for a server you administer ---------- */

// What a button sends: a few simple values, like a member's id, an amount or a role.
function cleanValues(v) {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  const entries = Object.entries(v);
  if (entries.length > 20) return null;
  for (const [k, value] of entries) {
    if (!KEY_RE.test(k)) return null;
    if (typeof value === 'string') out[k] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) out[k] = value;
    else if (typeof value === 'boolean') out[k] = value;
    else return null;
  }
  return out;
}

// The bot's extra answer (a member's numbers, scan results, the emoji list): plain values only, trimmed.
function cleanData(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 1000);
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 250).map((x) => cleanData(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) if (KEY_RE.test(k)) out[k] = cleanData(x, depth + 1);
    return out;
  }
  return null;
}

// Preview buttons: the bot builds a feature's messages (with the card's unsaved settings) without sending them.
const PICTURE_DATA_RE = /^data:image\/(png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanPreview(v, depth = 0, key = '') {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (key === 'data') return v.length <= 2100000 && PICTURE_DATA_RE.test(v) ? v : null;
    return v.slice(0, 6000);
  }
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => cleanPreview(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (KEY_RE.test(k)) out[k] = cleanPreview(x, depth + 1, k);
    return out;
  }
  return null;
}

async function previewApi(request, c, session, allowed) {
  const body = await readJson(request, 150000);
  const guildId = body && body.guild_id;
  const feature = body && body.feature;
  const item = body && body.item;
  const draft = body && body.draft;
  if (typeof guildId !== 'string' || !ID_RE.test(guildId) || typeof feature !== 'string' || !KEY_RE.test(feature)
      || (item !== undefined && item !== null && (typeof item !== 'string' || !KEY_RE.test(item)))
      || (draft !== undefined && (draft === null || typeof draft !== 'object' || Array.isArray(draft)))) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const res = await bot(c, '/api/preview', {
    method: 'POST',
    body: JSON.stringify({ guild_id: guildId, feature, item: item || null, draft: draft || {}, actor_id: session.user.id,
                          actor_name: str(session.user.username || session.user.name, 64) || null, ...allowed.viewer(guildId) }),
  });
  if (res.status === 404 && res.data && typeof res.data.error === 'string' && !/server/i.test(res.data.error)) return json({ error: 'invalid', message: str(res.data.error) }, 400);
  return botAnswer(res) || json(cleanPreview(res.data));
}

async function webAction(request, c, session, allowed) {
  const body = await readJson(request, 8000);
  const guildId = body && body.guild_id;
  const owner = body && body.owner;
  const action = body && body.action;
  const values = cleanValues(body && body.values);
  if (typeof guildId !== 'string' || !ID_RE.test(guildId) || typeof owner !== 'string' || !KEY_RE.test(owner)
      || typeof action !== 'string' || !KEY_RE.test(action) || values === null) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const res = await bot(c, '/api/action', {
    method: 'POST',
    body: JSON.stringify({ guild_id: guildId, owner, action, values, actor: `${session.user.name} (${session.user.id}) on the website`, actor_id: session.user.id, site_admin: !!allowed.siteAdmin, ...allowed.viewer(guildId) }),
  });
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 401) return json({ error: 'bot_rejected_key' }, 502);
  if (res.status === 403) return json({ error: 'no_access' }, 403);
  if (res.status === 404) {
    // The bot says which: it isn't in that server, or (an older bot) it doesn't know this button yet.
    return res.data && res.data.error === 'BEV is not in that server' ? json({ error: 'bot_not_in_server' }, 404) : json({ error: 'bot_outdated' }, 501);
  }
  if (res.status === 503) return json({ error: 'bot_starting' }, 503);
  if ([400, 409, 504].includes(res.status)) return json({ error: 'refused', message: str(res.data && res.data.error, 400) }, res.status === 504 ? 504 : 400);
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return json({ error: 'bot_error', status: res.status }, 502);
  return json({ ok: true, note: str(res.data.note, 1000) || null, reload: res.data.reload === true, data: cleanData(res.data.data) });
}

async function findMembers(c, url, allowed) {
  const guildId = url.searchParams.get('guild_id') || '';
  const q = (url.searchParams.get('q') || '').slice(0, 40);
  if (!ID_RE.test(guildId)) return json({ error: 'bad_request' }, 400);
  if (!allowed(guildId)) return json({ error: 'forbidden' }, 403);
  const v = allowed.viewer(guildId);
  const res = await bot(c, '/api/members?guild_id=' + guildId + '&q=' + encodeURIComponent(q) + '&viewer_id=' + v.viewer_id + '&viewer_full=' + (v.viewer_full ? '1' : '0'));
  const problem = levelRolesProblem(res);
  if (problem) return problem;
  return json({ members: (Array.isArray(res.data.members) ? res.data.members : []).slice(0, 20).map((m) => ({
    id: ID_RE.test(String(m && m.id)) ? String(m.id) : '', name: str(m && m.name, 64), display: str(m && m.display, 64), avatar: str(m && m.avatar, 300),
  })).filter((m) => m.id) });
}

function cleanPosted(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const url = str(p.url, 200);
  return { channel: ID_RE.test(String(p.channel)) ? String(p.channel) : null, channel_name: str(p.channel_name, 100) || null,
           at: whole(p.at), url: MESSAGE_LINK_RE.test(url) ? url : null };
}

/* ---------- security headers on everything this file sends ---------- */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function withSecurity(res, extra = {}) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/* ---------- site settings: maintenance mode and the banner (D1 database SITE_DB) ---------- */

const BLANK = {
  maintenance: { on: false, message: DEFAULT_MESSAGE, minutes: 0, until: null, showUntil: true, at: 0, by: '' },
  banner: { on: false, text: '', link: '', linkText: '', style: 'info', id: '', at: 0, by: '' },
  // Site admins added or removed on /admin, on top of the main list (SITE_ADMIN_IDS or the built-in one).
  admins: { added: [], mainAdded: [], demoted: [], removed: [], at: 0, by: '' },
  // 4.64: what each regular admin can see and do on /admin: { perms: { "<id>": { section: "off" | "view" | "full" } } }
  adminPerms: { perms: {}, at: 0, by: '' },
};

const ADMINS_MAX = 25;

// Who is a site admin right now, and which kind. Main and regular admins can both use /admin; only the accounts in
// ADMIN_MANAGER_IDS can change who is an admin and whether each is main or regular. The built-in/Cloudflare list is
// the starting point; what main admins change on /admin is saved as: added (regular), mainAdded, demoted, removed.
const idList = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((id) => ID_RE.test(id)))];

function deriveAdmins(baseMain, st) {
  const R = new Set(idList(st.removed)), D = new Set(idList(st.demoted)), MA = new Set(idList(st.mainAdded));
  const main = [...new Set([...baseMain, ...MA])].filter((id) => !D.has(id) && !R.has(id));
  const regular = [...new Set([...DEFAULT_REGULAR_ADMIN_IDS, ...idList(st.added), ...D])].filter((id) => !R.has(id) && !main.includes(id));
  return { main, regular };
}

function applyAdmins(c, site) {
  if (!c.baseMainIds) c.baseMainIds = c.adminIds.slice();
  const d = deriveAdmins(c.baseMainIds, (site && site.admins) || {});
  c.mainAdminIds = d.main.length ? d.main : c.baseMainIds.slice();      // never zero main admins
  c.addedAdminIds = d.regular.filter((id) => !c.mainAdminIds.includes(id));
  c.adminIds = [...c.mainAdminIds, ...c.addedAdminIds];
  return c;
}

// action: add (role main|regular), remove, set (role main|regular: change an existing admin's kind)
async function changeAdmins(request, env, c, s) {
  const body = await readJson(request, 2000);
  const id = body && String(body.id || '').trim();
  const action = body && body.action;
  const role = body && body.role === 'main' ? 'main' : 'regular';
  if (!ID_RE.test(id || '') || !['add', 'remove', 'set'].includes(action)) return json({ error: 'bad_request' }, 400);
  const me = String(s.session.user.id);
  if (!ADMIN_MANAGER_IDS.includes(me)) return json({ error: 'not_manager' }, 403);
  if (!database(env)) return json({ error: 'no_database' }, 503);
  const base = config(env).adminIds;
  const baseRegular = DEFAULT_REGULAR_ADMIN_IDS;
  const cur = s.site.admins || {};
  const st = { added: new Set(idList(cur.added)), mainAdded: new Set(idList(cur.mainAdded)), demoted: new Set(idList(cur.demoted)), removed: new Set(idList(cur.removed)) };
  const isAdmin = c.adminIds.includes(id);
  const makeRole = (kind) => {
    st.removed.delete(id);
    if (kind === 'main') {
      st.demoted.delete(id); st.added.delete(id);
      if (!base.includes(id)) st.mainAdded.add(id);
    } else {
      st.mainAdded.delete(id);
      if (base.includes(id)) st.demoted.add(id);
      else if (!baseRegular.includes(id)) st.added.add(id);
    }
  };
  if (action === 'add') {
    if (isAdmin) return json({ error: 'already_admin' }, 400);
    makeRole(role);
    if (st.added.size + st.mainAdded.size > ADMINS_MAX) return json({ error: 'too_many_admins' }, 400);
  } else if (action === 'remove') {
    if (id === me) return json({ error: 'cant_remove_self' }, 400);
    if (!isAdmin) return json({ error: 'not_admin' }, 400);
    st.added.delete(id); st.mainAdded.delete(id); st.demoted.delete(id);
    if (base.includes(id) || baseRegular.includes(id)) st.removed.add(id);
  } else {
    if (id === me) return json({ error: 'cant_change_self' }, 400);
    if (!isAdmin) return json({ error: 'not_admin' }, 400);
    makeRole(role);
  }
  if (!deriveAdmins(base, Object.fromEntries(Object.entries(st).map(([k, v]) => [k, [...v]]))).main.length) return json({ error: 'need_main_admin' }, 400);
  try {
    await saveSetting(env, 'admins', { added: [...st.added], mainAdded: [...st.mainAdded], demoted: [...st.demoted], removed: [...st.removed] }, `${s.session.user.name} (${me})`);
  } catch {
    return json({ error: 'database_error' }, 503);
  }
  const site = await loadSite(env);
  const fresh = applyAdmins(config(env), site);
  return json(await adminState(env, fresh, { ...s, site }, site));
}

function database(env) {
  const db = env.SITE_DB;
  return db && typeof db.prepare === 'function' ? db : null;
}

// Creates the two tables the first time each copy of this file uses the database.
const prepared = new WeakMap();
async function ready(db) {
  if (!prepared.has(db)) {
    const p = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)'),
      db.prepare('CREATE TABLE IF NOT EXISTS page_views (day TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, '
        + 'visits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path))'),
      db.prepare('CREATE TABLE IF NOT EXISTS update_seen (user_id TEXT PRIMARY KEY, version TEXT NOT NULL, seen_at INTEGER NOT NULL)'),
    ]);
    prepared.set(db, p);
    p.catch(() => prepared.delete(db));
  }
  await prepared.get(db);
  return db;
}

let siteCache = { db: null, at: 0, value: null };

// Maintenance and banner settings. Read at most every SETTINGS_TTL per copy. If the database can't be read
// (a Cloudflare problem, or the free daily limit), the last settings this copy knew are kept.
async function loadSite(env) {
  const db = database(env);
  if (!db) return { ...structuredClone(BLANK), database: false };
  if (siteCache.db === db && siteCache.value && Date.now() - siteCache.at < SETTINGS_TTL) return siteCache.value;
  try {
    await ready(db);
    const { results } = await db.prepare('SELECT key, value, updated_at, updated_by FROM site_settings').all();
    const value = { ...structuredClone(BLANK), database: true };
    for (const row of results || []) {
      if (!Object.prototype.hasOwnProperty.call(BLANK, row.key)) continue;
      try {
        value[row.key] = { ...BLANK[row.key], ...JSON.parse(row.value), at: Number(row.updated_at) || 0, by: str(row.updated_by, 120) };
      } catch { /* a damaged row: keep the blank setting */ }
    }
    siteCache = { db, at: Date.now(), value };
    return value;
  } catch {
    if (siteCache.db === db && siteCache.value) return siteCache.value;
    return { ...structuredClone(BLANK), database: true, error: true };
  }
}

async function saveSetting(env, key, value, by) {
  const db = await ready(database(env));
  await db.prepare('INSERT INTO site_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(key, JSON.stringify(value), Date.now(), by).run();
  siteCache = { db: null, at: 0, value: null }; // this copy uses the new settings straight away; others within SETTINGS_TTL
}

// Maintenance is on until an admin turns it off, or until its end time passes (it then ends by itself).
const maintenanceOn = (m) => !!m && m.on === true && (!m.until || Date.now() < m.until);

/* ---------- pages this file writes: the maintenance page and short notices ---------- */

const ARROW = '<span class="plus"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';

function ukTime(t) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: STATS_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

function messagePage({ title, tag, heading, text, until = null, refresh = 0, teamLink = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ''}<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta name="theme-color" content="#2563EB">
<link rel="icon" type="image/png" href="/bev-icon.png?v=3c7be32d19">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500..800&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/styles.css?v=4aa14ccc6b">
</head>
<body class="notice">
<div class="hero">
<div class="floor" aria-hidden="true"></div>
<div class="orb" aria-hidden="true"></div>
<div class="scan" aria-hidden="true"></div>
<header class="wrap nav"><span class="logo disp">BEV</span></header>
<main class="wrap head">
<div class="tag mono rise">${esc(tag)}</div>
<h1 class="disp rise d1">${esc(heading)}</h1>
<p class="lead rise d2">${text}</p>
${until ? `<p class="backat rise d2"><span class="dot" aria-hidden="true"></span><span>Expected back by <time datetime="${new Date(until).toISOString()}" data-local>${esc(ukTime(until))} (UK time)</time></span></p>\n` : ''}<div class="ctablock rise d3">
<span class="ctaw"><a class="cta" href="https://discord.gg/cbevs" target="_blank" rel="noopener noreferrer">${ARROW}<span>Join the BEV Discord</span></a></span>
<p class="note">News and updates are posted in the BEV Discord server.</p>
</div>
</main>
</div>
<footer class="wrap foot">
<div class="logo disp small">BEV</div>
<p>BEV is not affiliated with or endorsed by Discord.</p>
${teamLink ? '<nav class="llinks" aria-label="Team"><a href="/auth/login">Team sign-in</a></nav>\n' : ''}</footer>
${until ? '<script src="/maintenance.js?v=dc3f1f7bdc" defer></script>\n' : ''}</body>
</html>
`;
}

function htmlResponse(body, status, extra = {}) {
  return withSecurity(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra } }));
}

function maintenancePage(m, method) {
  const retry = m.until ? Math.max(60, Math.round((m.until - Date.now()) / 1000)) : 1800;
  const body = messagePage({
    title: 'BEV | Down for maintenance', tag: 'Maintenance', heading: 'Temporarily down for maintenance',
    text: esc(m.message || DEFAULT_MESSAGE).replace(/\n/g, '<br>'), until: m.until && m.showUntil ? m.until : null, refresh: 120, teamLink: true,
  });
  return htmlResponse(method === 'HEAD' ? null : body, 503, { 'retry-after': String(retry) });
}

function notAdminPage(method) {
  const body = messagePage({
    title: 'BEV | Not available', tag: 'Admin', heading: 'This page is for site admins',
    text: 'Only the BEV team can open this page. <a class="inl" href="/">Go to the home page</a>.',
  });
  return htmlResponse(method === 'HEAD' ? null : body, 403);
}

/* ---------- the announcement banner, and the reminder admins see during maintenance ---------- */

function bannerHtml(b) {
  const internal = b.link.startsWith('/');
  const link = b.link
    ? ` <a href="${esc(b.link)}"${internal ? '' : ' target="_blank" rel="noopener noreferrer"'}>${esc(b.linkText || 'Find out more')}</a>` : '';
  return `<div class="sitebanner sb-${b.style}" id="sitebanner" data-id="${esc(b.id)}" role="region" aria-label="Announcement">`
    + `<div class="wrap sbw"><p>${esc(b.text)}${link}</p><button class="sbx" id="sbclose" type="button" aria-label="Close this announcement" hidden>`
    + '<span aria-hidden="true">×</span></button></div></div>';
}

const ADMIN_NOTICE = '<div class="sitebanner sb-warning" role="status"><div class="wrap sbw"><p><b>Maintenance mode is on.</b> '
  + 'Visitors see the maintenance page. Only site admins can see the website. <a href="/admin">Manage maintenance</a></p></div></div>';

function bannerFor(site, request) {
  const b = site.banner;
  if (!b || !b.on || !b.text) return '';
  // Someone who closed this banner (same text, link and style) doesn't get it again.
  if (b.id && readCookies(request).bev_banner === b.id) return '';
  return bannerHtml(b);
}

/* ---------- visit counting: no cookies, nothing about the visitor is stored ---------- */

function pageKey(pathname) {
  const p = pathname.replace(/\.html$/, '').replace(/\/index$/, '/').replace(/(.)\/+$/, '$1');
  return Object.prototype.hasOwnProperty.call(PAGES, p) ? p : null;
}

function ukDay(t = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: STATS_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// The last n days (oldest first), counted back from a YYYY-MM-DD day.
function lastDays(today, n) {
  const [y, m, d] = today.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
}

function looksLikeAPerson(request) {
  if (request.method !== 'GET') return false;
  const ua = request.headers.get('user-agent') || '';
  if (!ua || NOT_A_PERSON.test(ua)) return false;
  const purpose = (request.headers.get('sec-purpose') || request.headers.get('purpose') || '').toLowerCase();
  return !purpose.includes('prefetch') && !purpose.includes('prerender');
}

// A visit is someone arriving from outside the site. Opening another page from the site is only a page view.
function arrivedFromOutside(request, url) {
  const ref = request.headers.get('referer');
  if (!ref) return true;
  try { return new URL(ref).host !== url.host; } catch { return true; }
}

async function countView(env, key, visit) {
  const db = database(env);
  if (!db) return;
  try {
    await ready(db);
    await db.prepare('INSERT INTO page_views (day, path, views, visits) VALUES (?1, ?2, 1, ?3) '
      + 'ON CONFLICT(day, path) DO UPDATE SET views = views + 1, visits = visits + ?3').bind(ukDay(), key, visit ? 1 : 0).run();
  } catch { /* counting is best effort: the page was already sent */ }
}

async function visitStats(env) {
  const db = database(env);
  if (!db) return null;
  try {
    await ready(db);
    const days = lastDays(ukDay(), 30);
    const [series, pages, total] = await db.batch([
      db.prepare('SELECT day, SUM(views) AS views, SUM(visits) AS visits FROM page_views WHERE day >= ?1 GROUP BY day').bind(days[0]),
      db.prepare('SELECT path, SUM(views) AS views, SUM(visits) AS visits FROM page_views WHERE day >= ?1 GROUP BY path ORDER BY views DESC LIMIT 10').bind(days[0]),
      db.prepare('SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(visits), 0) AS visits, MIN(day) AS first FROM page_views'),
    ]);
    const byDay = new Map((series.results || []).map((r) => [r.day, r]));
    const daily = days.map((day) => ({ day, views: Number(byDay.get(day)?.views) || 0, visits: Number(byDay.get(day)?.visits) || 0 }));
    const sum = (list) => list.reduce((a, d) => ({ views: a.views + d.views, visits: a.visits + d.visits }), { views: 0, visits: 0 });
    const t = (total.results && total.results[0]) || {};
    return {
      today: daily[29], yesterday: daily[28], week: sum(daily.slice(-7)), month: sum(daily),
      all: { views: Number(t.views) || 0, visits: Number(t.visits) || 0 }, since: t.first || null, daily,
      pages: (pages.results || []).map((r) => ({ path: r.path, name: PAGES[r.path] || r.path, views: Number(r.views) || 0, visits: Number(r.visits) || 0 })),
      zone: STATS_ZONE,
    };
  } catch {
    return { error: true };
  }
}

/* ---------- serving pages: banner, maintenance reminder and counting ---------- */

async function servePage(request, env, ctx, s, { noStore = false, count = true } = {}) {
  const url = new URL(request.url);
  const inject = bannerFor(s.site, request) + (s.admin && s.down ? ADMIN_NOTICE : '');
  let req = request;
  if (inject) {
    // Ask for the whole page (not "unchanged since last time"), so the banner is always added to it.
    const headers = new Headers(request.headers);
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    req = new Request(request, { headers });
  }
  let res = await env.ASSETS.fetch(req);
  // A page that doesn't exist gets BEV's own "Page not found" page (still with the 404 status).
  if (res.status === 404 && request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
    const lost = await env.ASSETS.fetch(new Request(new URL('/404', url), { headers: { accept: 'text/html' } }));
    if (lost.status === 200) res = new Response(lost.body, { status: 404, headers: lost.headers });
  }
  const html = (res.headers.get('content-type') || '').includes('text/html');
  if (res.status === 200 && html && inject && request.method === 'GET') {
    const page = await res.text();
    const headers = new Headers(res.headers);
    for (const h of ['etag', 'last-modified', 'content-length']) headers.delete(h);
    headers.set('cache-control', noStore ? 'no-store' : 'no-cache');
    res = new Response(page.replace(/<body[^>]*>/i, (tag) => tag + inject), { status: 200, headers });
  } else if (noStore) {
    res = withSecurity(res, { 'cache-control': 'no-store' });
  } else if (html) {
    // Browsers check for a newer copy of every page each time (a quick "not changed" answer when there isn't one),
    // so a new upload shows straight away instead of an old copy kept in the browser.
    res = withSecurity(res, { 'cache-control': 'no-cache' });
  }
  const key = count && res.status === 200 && html && !s.admin && looksLikeAPerson(request) ? pageKey(url.pathname) : null;
  if (key) {
    const counting = countView(env, key, arrivedFromOutside(request, url));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(counting);
    else await counting;
  }
  return withSecurity(res);
}

/* ---------- page gates: the dashboard (signed in) and /admin (site admins) ---------- */

async function dashboardPage(request, env, ctx, c, secure, s) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return withSecurity(new Response('Method not allowed', { status: 405 }));
  if (!s.session) return withSecurity(redirect('/auth/login', [hintCookie(false, secure)]));
  let view;
  try {
    view = await loadView(s.session, c);
  } catch (e) {
    return withSecurity(redirect(e instanceof Upstream && e.status === 401 ? '/auth/login' : '/servers.html?error=discord'));
  }
  if (!view.servers.length) return withSecurity(redirect('/servers.html?error=denied'));
  return servePage(request, env, ctx, s, { noStore: true });
}

async function adminPage(request, env, ctx, secure, s) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return withSecurity(new Response('Method not allowed', { status: 405 }));
  if (!s.session) return withSecurity(redirect('/auth/login', [hintCookie(false, secure)]));
  if (!s.admin) return notAdminPage(request.method);
  return servePage(request, env, ctx, s, { noStore: true, count: false });
}

/* ---------- the admin API ---------- */

const ADMIN_ROUTES = {
  '/api/admin/state': 'GET', '/api/admin/maintenance': 'POST', '/api/admin/banner': 'POST', '/api/admin/check': 'POST',
  '/api/admin/alert': 'GET', '/api/admin/alert/send': 'POST', '/api/admin/inbox': 'GET', '/api/admin/inbox/mark': 'POST',
  '/api/admin/features': 'GET', '/api/admin/features/set': 'POST', '/api/admin/suggestions': 'GET', '/api/admin/suggestions/answer': 'POST',
  '/api/admin/support': 'GET', '/api/admin/support/act': 'POST', '/api/admin/admins': 'POST', '/api/admin/health': 'GET',
  '/api/admin/data': 'GET', '/api/admin/data/table': 'GET', '/api/admin/data/download': 'GET', '/api/admin/data/upload': 'POST',
  '/api/admin/backup': 'GET', '/api/admin/backup/set': 'POST',
  '/api/admin/premium': 'GET', '/api/admin/premium/set': 'POST', '/api/admin/premium/gift': 'POST', '/api/admin/premium/paypal-plans': 'POST',
  '/api/admin/premium/check': 'POST', '/api/admin/perms': 'POST',
};

/* ---------- the inbox: what still needs setting up, which site admins can mark as done ---------- */

const INBOX_MAX_DONE = 100;
const INBOX_KEY = /^[a-z0-9_]{1,40}$/;

// What's missing on the website's side. Only names of settings are mentioned, never their values.
function siteSetupItems(env, c) {
  const items = [];
  const add = (key, title, detail, how, level = 'needed') => items.push({ key, title, detail, how, level, where: 'site' });
  if (!c.clientSecret) add('site_client_secret', 'Discord sign-in', "DISCORD_CLIENT_SECRET isn't set, so nobody can sign in to the website.",
    'In the Discord Developer Portal, open BEV → OAuth2 and copy the client secret. In Cloudflare, add it as a secret called DISCORD_CLIENT_SECRET.');
  if (!c.sessionSecret) add('site_session_secret', 'Sign-in cookie key', c.sessionSecretShort
    ? 'SESSION_SECRET is shorter than 32 characters, so sign-in is switched off.' : "SESSION_SECRET isn't set, so sign-in is switched off.",
    'In Cloudflare, add a secret called SESSION_SECRET: a random string of at least 32 characters.');
  if (!c.botToken) add('site_bot_token', "BEV's bot token on the website", "DISCORD_BOT_TOKEN isn't set, so the website can't tell which servers BEV is in.",
    'In Cloudflare, add the bot token as a secret called DISCORD_BOT_TOKEN.');
  if (!c.botApiBase) add('site_bot_address', "The bot's address", "BOT_API_BASE isn't set (or isn't a full https:// address), so the dashboard can't reach BEV.",
    "In Cloudflare, add a variable called BOT_API_BASE with the bot's web address, starting with https://.");
  if (!c.botApiKey) add('site_bot_key', 'The key shared with the bot', "BOT_API_KEY isn't set, so BEV won't answer the website.",
    "In Cloudflare, add a secret called BOT_API_KEY with exactly the same value as BOT_API_KEY in the bot's settings.");
  if (!database(env)) add('site_database', 'The site database', "No D1 database is connected as SITE_DB, so maintenance mode, the banner, visits and this inbox's ticks can't be saved.",
    'In Cloudflare, create a D1 database and bind it to this site as SITE_DB (Settings → Bindings), then upload the site again.');
  return items;
}

const cleanItem = (i) => (i && typeof i === 'object' && typeof i.key === 'string' && INBOX_KEY.test(i.key) ? {
  key: i.key, title: str(i.title, 120), detail: str(i.detail, 600), how: str(i.how, 600),
  level: i.level === 'needed' ? 'needed' : 'optional', where: i.where === 'site' ? 'site' : 'bot',
} : null);

async function loadInboxDone(env) {
  const db = database(env);
  if (!db) return {};
  try {
    await ready(db);
    const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'inbox_done'").first();
    const done = row ? JSON.parse(row.value) : {};
    return done && typeof done === 'object' && !Array.isArray(done) ? done : {};
  } catch {
    return {};
  }
}

async function inboxState(env, c) {
  const items = siteSetupItems(env, c);
  let botState = 'ok';
  if (!c.botApiBase || !c.botApiKey) botState = 'not_configured';
  else {
    const res = await bot(c, '/api/setup');
    if (res.error) botState = 'unreachable';
    else if (res.status === 401) botState = 'rejected';
    else if (res.status === 404) botState = 'outdated';
    else if (res.status !== 200 || !res.data || !Array.isArray(res.data.items)) botState = 'error';
    else for (const raw of res.data.items.slice(0, 30)) { const i = cleanItem(raw); if (i && i.where === 'bot') items.push(i); }
  }
  if (botState === 'outdated') {
    items.push({ key: 'bot_update', title: 'Update the bot', detail: "The bot running now can't report what it needs, so its side of this inbox is empty.",
      how: 'Upload the newest bev_bot.py, wait for the bot to restart, then press Check again.', level: 'needed', where: 'bot' });
  }
  const done = await loadInboxDone(env);
  const open = items.map((i) => ({ ...i, done: done[i.key] ? { at: Number(done[i.key].at) || 0, by: str(done[i.key].by, 120) } : null }));
  const here = new Set(items.map((i) => i.key));
  // Ticked items that aren't reported any more: kept in the Done list with the title they had.
  const gone = Object.entries(done).filter(([k]) => !here.has(k) && INBOX_KEY.test(k)).map(([key, d]) => ({
    key, title: str(d && d.title, 120) || key, detail: '', how: '', level: 'optional', where: d && d.where === 'site' ? 'site' : 'bot',
    done: { at: Number(d && d.at) || 0, by: str(d && d.by, 120) }, fixed: true,
  }));
  return { items: open.concat(gone), bot: botState, database: !!database(env), checked: Date.now() };
}

async function markInbox(request, env, s) {
  const body = await readJson(request, 2000);
  if (!body || typeof body.key !== 'string' || !INBOX_KEY.test(body.key) || typeof body.done !== 'boolean') return json({ error: 'bad_request' }, 400);
  if (!database(env)) return json({ error: 'no_database' }, 503);
  try {
    const done = await loadInboxDone(env);
    if (body.done) {
      if (!done[body.key] && Object.keys(done).length >= INBOX_MAX_DONE) {
        const oldest = Object.entries(done).sort((a, b) => (Number(a[1] && a[1].at) || 0) - (Number(b[1] && b[1].at) || 0))[0];
        if (oldest) delete done[oldest[0]];
      }
      done[body.key] = { at: Date.now(), by: `${s.session.user.name} (${s.session.user.id})`, title: str(body.title, 120), where: body.where === 'site' ? 'site' : 'bot' };
    } else {
      delete done[body.key];
    }
    await saveSetting(env, 'inbox_done', done, `${s.session.user.name} (${s.session.user.id})`);
  } catch {
    return json({ error: 'database_error' }, 503);
  }
  return json({ ok: true });
}

// The Discord alert: a notice BEV posts in every server that switched on "BEV Status Alerts".
const ALERT_MAX = 1000;
const DEFAULT_ALERT = 'BEV will be down for maintenance shortly. While it’s offline, commands and automatic features such as moderation, '
  + 'levels and logging will be paused. It should be back within a few minutes. Thank you for your patience!';

async function readJson(request, limit) {
  if (Number(request.headers.get('content-length') || '0') > limit) return null;
  let text;
  try { text = await request.text(); } catch { return null; }
  if (text.length > limit) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function cleanMaintenance(b) {
  if (typeof b.on !== 'boolean' || (b.message != null && typeof b.message !== 'string')) return null;
  const message = typeof b.message === 'string' ? b.message.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  const minutes = Number(b.minutes ?? 0);
  if (message.length > 600 || !DURATIONS.includes(minutes)) return null;
  return {
    on: b.on, message: message || DEFAULT_MESSAGE, minutes,
    until: b.on && minutes ? Date.now() + minutes * 60000 : null, showUntil: b.showUntil !== false,
  };
}

// A link in the banner: a page on this site (like /status) or any https:// address.
function safeLink(link) {
  if (/^\/(?!\/)[\w\-./?=&#%]*$/.test(link)) return true;
  try {
    const u = new URL(link);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

async function cleanBanner(b) {
  if (typeof b.on !== 'boolean') return null;
  const one = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : null);
  const text = one(b.text ?? '');
  const linkText = one(b.linkText ?? '');
  const link = typeof b.link === 'string' ? b.link.trim() : b.link == null ? '' : null;
  const style = BANNER_STYLES.includes(b.style) ? b.style : null;
  if (text === null || linkText === null || link === null || !style) return null;
  if (text.length > 200 || linkText.length > 40 || link.length > 300 || (b.on && !text) || (link && !safeLink(link))) return null;
  // The id lets people's "close" stick until the banner's wording, link or style changes.
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode([text, link, linkText, style].join('\n'))));
  const id = Array.from(hash.slice(0, 6), (x) => x.toString(16).padStart(2, '0')).join('');
  return { on: b.on, text, link, linkText: link ? linkText : '', style, id };
}

let profileCache = { at: 0, key: '', list: null };

// Names and pictures of the site admins, looked up with the bot token and remembered for 10 minutes.
async function adminProfiles(c) {
  const key = c.adminIds.join(',') + '|' + (c.botToken ? 1 : 0);
  if (profileCache.list && profileCache.key === key && Date.now() - profileCache.at < 600000) return profileCache.list;
  const list = await Promise.all(c.adminIds.map(async (id) => {
    if (!c.botToken) return { id, name: null, username: null, avatar: null };
    try {
      const u = await discord('/users/' + id, 'Bot ' + c.botToken);
      const hash = typeof u.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(u.avatar) ? u.avatar : null;
      return { id, name: str(u.global_name || u.username, 64) || null, username: str(u.username, 64) || null, avatar: hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64` : null };
    } catch {
      return { id, name: null, username: null, avatar: null };
    }
  }));
  profileCache = { at: Date.now(), key, list };
  return list;
}

async function adminState(env, c, s, site) {
  return {
    me: s.session.user,
    database: { connected: !!database(env), error: !!site.error },
    maintenance: { ...site.maintenance, active: maintenanceOn(site.maintenance) },
    banner: site.banner,
    defaults: { message: DEFAULT_MESSAGE, durations: DURATIONS, alert: DEFAULT_ALERT, alertMax: ALERT_MAX },
    admins: (await adminProfiles(c)).map((a) => ({ ...a, main: (c.mainAdminIds || c.adminIds).includes(a.id), manager: ADMIN_MANAGER_IDS.includes(a.id) })),
    adminsFromSetting: c.adminFromSetting,
    canManageAdmins: ADMIN_MANAGER_IDS.includes(String(s.session.user.id)),
    isMainAdmin: (c.mainAdminIds || c.adminIds).includes(String(s.session.user.id)),
    sections: ADMIN_SECTIONS.map(([key, name]) => ({ key, name })),
    myPerms: adminPermsFor(c, s, s.session.user.id),
    allPerms: ADMIN_MANAGER_IDS.includes(String(s.session.user.id))
      ? Object.fromEntries(c.adminIds.map((id) => [id, adminPermsFor(c, s, id)])) : {},
    visits: await visitStats(env),
    now: Date.now(),
  };
}

// Checks every link in the chain and says, in plain words, what to fix.
async function connectionCheck(env, c) {
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });

  add('signin', 'Sign-in settings', !!(c.clientSecret && c.sessionSecret), !c.clientSecret
    ? 'DISCORD_CLIENT_SECRET is missing in Cloudflare, so nobody can sign in.'
    : !c.sessionSecret
      ? (c.sessionSecretShort ? 'SESSION_SECRET is shorter than 32 characters. Make a longer one.' : 'SESSION_SECRET is missing in Cloudflare.')
      : 'The client secret and the session secret are both set.');

  if (!c.botToken) {
    add('token', 'Bot token', false, "DISCORD_BOT_TOKEN is missing in Cloudflare, so the site can't see which servers BEV is in.");
  } else {
    try {
      const me = await discord('/users/@me', 'Bot ' + c.botToken);
      add('token', 'Bot token', true, `Discord accepted it. The token belongs to ${str(me.username, 40) || 'your bot'}.`);
    } catch (e) {
      add('token', 'Bot token', false, e instanceof Upstream && e.status === 401
        ? 'Discord refused DISCORD_BOT_TOKEN. If the token was reset, paste the new one in Cloudflare (and in the bot\'s settings).'
        : "Couldn't reach Discord to check the token. Try again in a minute.");
    }
  }

  let reachable = false;
  if (!c.botApiBase) {
    add('address', 'Bot address', false, "BOT_API_BASE is missing or isn't a full https:// address of the bot, like https://your-bot.example.com.");
  } else {
    const started = Date.now();
    try {
      const r = await fetch(c.botApiBase + '/health', { signal: AbortSignal.timeout(60000) });
      const data = await r.json().catch(() => null);
      reachable = r.status === 200;
      add('address', 'Bot address', reachable, reachable
        ? `BEV answered in ${Date.now() - started} ms${data && data.ready === false ? ", but it's still connecting to Discord" : ''}.`
        : `${c.botApiBase} answered with error ${r.status}. Check that BOT_API_BASE is the bot's web address.`);
    } catch {
      add('address', 'Bot address', false, `Nothing answered at ${c.botApiBase}. BEV may be offline or restarting, or the address is wrong.`);
    }
  }

  if (!c.botApiKey) {
    add('key', 'Bot API key', false, 'BOT_API_KEY is missing in Cloudflare.');
  } else if (reachable) {
    const res = await bot(c, '/api/status');
    if (res.status === 200 && res.data) {
      add('key', 'Bot API key', true, `The keys match. BEV is ${res.data.online ? 'online' : 'not connected to Discord'} in ${Number(res.data.servers) || 0} server(s)`
        + `${res.data.version ? `, version ${str(res.data.version, 20)}` : ''}.`);
    } else if (res.status === 401) {
      add('key', 'Bot API key', false, 'BEV refused the key. BOT_API_KEY in Cloudflare must be exactly the same as BOT_API_KEY in the bot\'s settings.');
    } else {
      add('key', 'Bot API key', false, `BEV didn't answer the key check${res.status ? ` (error ${res.status})` : ''}.`);
    }
  } else {
    add('key', 'Bot API key', null, "Can't be checked until BEV answers at its address.");
  }

  const db = database(env);
  if (!db) {
    add('database', 'Site database', false, "No D1 database is connected as SITE_DB, so maintenance mode, the banner and visit counts can't be saved.");
  } else {
    try {
      await ready(db);
      await db.prepare('SELECT COUNT(*) AS n FROM site_settings').first();
      add('database', 'Site database', true, 'SITE_DB is connected and working.');
    } catch {
      add('database', 'Site database', false, "SITE_DB is connected but didn't answer. Cloudflare may be having problems, or today's free limit was reached.");
    }
  }
  return checks;
}

/* ---------- the Discord alert (sent by the bot) ---------- */

const whole = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// Only the parts of the bot's answer the Admin page shows, checked for shape.
function cleanAlertJob(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return {
    state: j.state === 'sending' ? 'sending' : 'done',
    text: str(j.text, ALERT_MAX), by: str(j.by, 120),
    started: whole(j.started_at), finished: whole(j.finished_at) || null,
    total: whole(j.total), done: whole(j.done), sent: whole(j.sent),
    failed: (Array.isArray(j.failed) ? j.failed : []).slice(0, 25).map((f) => ({ server: str(f && f.server, 100), reason: str(f && f.reason, 200) })),
  };
}

// What went wrong talking to the bot, in a form the Admin page understands. null when the answer is usable.
function alertProblem(res) {
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 401) return json({ error: 'bot_rejected_key' }, 502);
  if (res.status === 404 || res.status === 405) return json({ error: 'bot_outdated' }, 501);
  if (res.status === 503) return json({ error: 'bot_starting' }, 503);
  if (res.status === 400) return json({ error: 'bad_request' }, 400);
  if (res.status === 409 || res.status === 429) {
    const code = res.data && res.data.error;
    return json({ error: ['busy', 'no_servers', 'cooldown'].includes(code) ? code : 'busy', retryAfter: whole(res.data && res.data.retry_after) }, res.status);
  }
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') return json({ error: 'bot_error', status: res.status }, 502);
  return null;
}

async function alertApi(request, c, s, path) {
  if (path === '/api/admin/alert') {
    const res = await bot(c, '/api/bev-alert');
    const problem = alertProblem(res);
    if (problem) return problem;
    return json({ servers: whole(res.data.servers), missingChannel: whole(res.data.missing_channel), job: cleanAlertJob(res.data.job) });
  }
  const body = await readJson(request, 8000);
  const text = body && typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  if (!text || text.length > ALERT_MAX) return json({ error: 'bad_request' }, 400);
  const res = await bot(c, '/api/bev-alert', { method: 'POST', body: JSON.stringify({ text, by: `${s.session.user.name} (${s.session.user.id})` }) });
  const problem = alertProblem(res);
  if (problem) return problem;
  return json({ ok: true, job: cleanAlertJob(res.data.job) });
}

async function adminApi(request, env, c, url, secure, s) {
  const path = url.pathname;
  if (!Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, path)) return json({ error: 'not_found' }, 404);
  if (request.method !== ADMIN_ROUTES[path]) return json({ error: 'method_not_allowed' }, 405);
  if (!c.sessionSecret || !c.clientSecret) return json({ error: 'not_configured' }, 503);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return json({ error: 'bad_origin' }, 403);
  if (!s.session) return json({ error: 'signed_out' }, 401, [hintCookie(false, secure)]);
  if (!s.admin) return json({ error: 'forbidden' }, 403);
  const section = adminSectionOf(path);
  if (section) {
    const level = adminPermsFor(c, s, s.session.user.id)[section];
    if (level === 'off' || (level === 'view' && request.method !== 'GET' && path !== '/api/admin/check')) return json({ error: 'no_permission', section }, 403);
  }

  if (path === '/api/admin/state') return json(await adminState(env, c, s, s.site));
  if (path === '/api/admin/perms') return changeAdminPerms(request, env, c, s);
  if (path.startsWith('/api/admin/premium')) return adminPremium(request, env, c, s, url, path);
  if (path === '/api/admin/check') return json({ checks: await connectionCheck(env, c) });
  if (path.startsWith('/api/admin/alert')) return alertApi(request, c, s, path);
  if (path === '/api/admin/inbox') return json(await inboxState(env, c));
  if (path === '/api/admin/inbox/mark') return markInbox(request, env, s);
  if (path === '/api/admin/features' || path === '/api/admin/features/set') return ownerFeatures(request, c, s, path);
  if (path === '/api/admin/suggestions' || path === '/api/admin/suggestions/answer') return adminSuggestions(request, c, s, path);
  if (path === '/api/admin/support' || path === '/api/admin/support/act') return adminSupport(request, c, s, path);
  if (path === '/api/admin/admins') return changeAdmins(request, env, c, s);
  if (path === '/api/admin/health') return botHealth(c);
  if (path.startsWith('/api/admin/data')) return botData(request, c, s, url, path);
  if (path.startsWith('/api/admin/backup')) return backupTiming(request, c, s, path);

  const body = await readJson(request, 20000);
  if (!body) return json({ error: 'bad_request' }, 400);
  const value = path === '/api/admin/maintenance' ? cleanMaintenance(body) : await cleanBanner(body);
  if (!value) return json({ error: 'bad_request' }, 400);
  if (!database(env)) return json({ error: 'no_database' }, 503);
  try {
    await saveSetting(env, path === '/api/admin/maintenance' ? 'maintenance' : 'banner', value, `${s.session.user.name} (${s.session.user.id})`);
  } catch {
    return json({ error: 'database_error' }, 503);
  }
  const site = await loadSite(env);
  return json(await adminState(env, c, s, site));
}

/* ---------- BEV's data: download, upload (admin managers only) and a read-only browser (main admins only) ---------- */

const DATA_UPLOAD_MAX = 95 * 1024 * 1024;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

async function botData(request, c, s, url, path) {
  const me = String(s.session.user.id);
  if (!(c.mainAdminIds || c.adminIds).includes(me)) return json({ error: 'need_main_admin' }, 403);
  if (!c.botApiBase || !c.botApiKey) return json({ error: 'bot_not_configured' }, 503);
  const headers = { 'x-api-key': c.botApiKey };
  if (path === '/api/admin/data/download') {
    let r;
    try { r = await fetch(c.botApiBase + '/api/data/download', { headers, signal: AbortSignal.timeout(120000) }); } catch { return json({ error: 'bot_unreachable' }, 503); }
    if (r.status === 404) return json({ error: 'bot_outdated' }, 501);
    if (r.status !== 200) return json({ error: 'bot_error' }, 502);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(r.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="bev-data-${day}.db"`, 'x-content-type-options': 'nosniff' } });
  }
  if (path === '/api/admin/data/upload') {
    if (!ADMIN_MANAGER_IDS.includes(me)) return json({ error: 'not_manager' }, 403);
    if (Number(request.headers.get('content-length') || 0) > DATA_UPLOAD_MAX) return json({ error: 'too_big' }, 413);
    const body = await request.arrayBuffer();
    if (!body.byteLength) return json({ error: 'empty' }, 400);
    if (body.byteLength > DATA_UPLOAD_MAX) return json({ error: 'too_big' }, 413);
    let r;
    try {
      r = await fetch(c.botApiBase + '/api/data/upload', { method: 'POST', body, headers: { ...headers, 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(120000) });
    } catch { return json({ error: 'bot_unreachable' }, 503); }
    let d = null;
    try { d = await r.json(); } catch { d = null; }
    if (r.status === 404) return json({ error: 'bot_outdated' }, 501);
    if (r.status !== 200 || !d || !d.ok) return json({ error: (d && str(d.error, 40)) || 'bot_error', detail: d ? str(d.detail, 300) : '' }, r.status >= 400 && r.status < 500 ? 400 : 502);
    return json({ ok: true, tables: Number(d.tables) || 0, servers: Number(d.servers) || 0, backup: str(d.backup, 200) });
  }
  let target = '/api/data/overview';
  if (path === '/api/admin/data/table') {
    const name = url.searchParams.get('name') || '';
    const guild = url.searchParams.get('guild') || '';
    const page = Math.max(0, Math.min(100000, parseInt(url.searchParams.get('page') || '0', 10) || 0));
    if (!TABLE_RE.test(name) || (guild && !ID_RE.test(guild))) return json({ error: 'bad_request' }, 400);
    target = `/api/data/table?name=${encodeURIComponent(name)}&page=${page}` + (guild ? `&guild=${guild}` : '');
  }
  const res = await bot(c, target);
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 404) return json({ error: path === '/api/admin/data/table' ? 'unknown_table' : 'bot_outdated' }, path === '/api/admin/data/table' ? 404 : 501);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
  return json(res.data);
}

/* ---------- 4.63: how often BEV posts a database backup to Discord (main admins only), 30 minutes to 30 days ---------- */

function cleanBackup(d) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const l = d.last && typeof d.last === 'object' ? d.last : null;
  return { set_up: d.set_up === true, every_minutes: num(d.every_minutes), min_minutes: num(d.min_minutes) || 30, max_minutes: num(d.max_minutes) || 43200,
    keep_days: num(d.keep_days), last: l ? { at: num(l.at), ok: l.ok === true, bytes: num(l.bytes), parts: num(l.parts), note: str(l.note, 200) } : null };
}

async function backupTiming(request, c, s, path) {
  if (!(c.mainAdminIds || c.adminIds).includes(String(s.session.user.id))) return json({ error: 'need_main_admin' }, 403);
  let res;
  if (path === '/api/admin/backup/set') {
    const body = await readJson(request, 2000);
    const minutes = body ? Number(body.every_minutes) : NaN;
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 43200) return json({ error: 'bad_interval' }, 400);
    res = await bot(c, '/api/backup', { method: 'POST', body: JSON.stringify({ every_minutes: minutes }) });
  } else res = await bot(c, '/api/backup');
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 404) return json({ error: 'bot_outdated' }, 501);
  if (res.status === 400) return json({ error: 'bad_interval' }, 400);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
  if (res.data.every_minutes === undefined) return json({ error: 'bot_outdated' }, 501);
  return json(cleanBackup(res.data));
}

/* ---------- bot health: each part of BEV, its background jobs and recent errors (site admins only) ---------- */

async function botHealth(c) {
  const res = await bot(c, '/api/health-details');
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 404) return json({ error: 'bot_outdated' }, 501);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
  const d = res.data;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const b = d.backup && typeof d.backup === 'object' ? d.backup : null;
  return json({
    version: str(d.version, 20), online: d.online === true, uptime_s: num(d.uptime_s), latency_ms: num(d.latency_ms), servers: num(d.servers),
    db_bytes: num(d.db_bytes), music_players: num(d.music_players), errors_24h: num(d.errors_24h) || 0,
    backup: b ? { at: num(b.at), ok: b.ok === true, bytes: num(b.bytes), note: str(b.note, 200) } : null,
    areas: (Array.isArray(d.areas) ? d.areas : []).slice(0, 60).map((a) => ({ area: str(a.area, 80), errors_24h: num(a.errors_24h) || 0,
      last_at: num(a.last_at), last_message: str(a.last_message, 300) })),
    recent: (Array.isArray(d.recent) ? d.recent : []).slice(0, 40).map((r) => ({ at: num(r.at), area: str(r.area, 80), kind: str(r.kind, 60),
      message: str(r.message, 300) })),
    jobs: (Array.isArray(d.jobs) ? d.jobs : []).slice(0, 80).map((j) => ({ name: str(j.name, 60), every: num(j.every), last_run: num(j.last_run),
      seconds: num(j.seconds), ok: j.ok === true ? true : j.ok === false ? false : null, error: str(j.error, 200) || null, runs: num(j.runs) || 0, late: j.late === true })),
  });
}

/* ---------- what's new: which update each person last pressed "Got it" on ---------- */

const UPDATE_ID_RE = /^[\w.-]{1,20}$/;

async function updatesApi(request, env, url, s) {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return json({ error: 'bad_origin' }, 403);
  if (!s.session) return json({ error: 'signed_out' }, 401);
  const userId = String(s.session.user.id);
  const db = database(env);
  if (request.method === 'GET') {
    if (!db) return json({ seen: null, saved: false, admin: s.admin });
    try {
      await ready(db);
      const row = await db.prepare('SELECT version FROM update_seen WHERE user_id = ?1').bind(userId).first();
      return json({ seen: row ? row.version : null, saved: true, admin: s.admin });
    } catch {
      return json({ seen: null, saved: false, admin: s.admin });
    }
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const version = body && typeof body.version === 'string' ? body.version : '';
  if (!UPDATE_ID_RE.test(version)) return json({ error: 'bad_request' }, 400);
  if (!db) return json({ ok: true, saved: false });
  try {
    await ready(db);
    await db.prepare('INSERT INTO update_seen (user_id, version, seen_at) VALUES (?1, ?2, ?3) '
      + 'ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, seen_at = excluded.seen_at').bind(userId, version, Date.now()).run();
    return json({ ok: true, saved: true });
  } catch {
    return json({ ok: true, saved: false });
  }
}

/* ---------- Dashboard settings: switch a feature off for every server (site admins only) ---------- */

function cleanOwnerFeatures(d) {
  const list = Array.isArray(d && d.features) ? d.features : [];
  return {
    features: list.slice(0, 200).filter((f) => f && KEY_RE.test(String(f.key))).map((f) => ({
      key: String(f.key), name: str(f.name, 60), icon: str(f.icon, 12), category: KEY_RE.test(String(f.category)) ? String(f.category) : 'other',
      about: str(f.about, 400), off: f.off === true, since: Number.isFinite(f.since) ? f.since : null,
      mode: ['on', 'off', 'except'].includes(f.mode) ? f.mode : (f.off === true ? 'off' : 'on'),
      keep: (Array.isArray(f.keep) ? f.keep : []).map(String).filter((id) => ID_RE.test(id)).slice(0, 500),
    })),
    servers: (Array.isArray(d && d.servers) ? d.servers : []).slice(0, 1000).filter((g) => g && ID_RE.test(String(g.id))).map((g) => ({
      id: String(g.id), name: str(g.name, 100), members: Number.isFinite(g.members) ? g.members : 0,
      icon: typeof g.icon === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(g.icon) ? g.icon.slice(0, 300) : null,
    })),
    categories: (Array.isArray(d && d.categories) ? d.categories : []).slice(0, 20).filter((c) => c && KEY_RE.test(String(c.key)))
      .map((c) => ({ key: String(c.key), icon: str(c.icon, 12), name: str(c.name, 40) })),
  };
}

async function ownerFeatures(request, c, s, path) {
  let res;
  if (path === '/api/admin/features/set') {
    const body = await readJson(request, 40000);
    if (!body || typeof body.key !== 'string' || !KEY_RE.test(body.key)) return json({ error: 'bad_request' }, 400);
    // mode: on | off | except (off everywhere except the servers in keep). The older { off: true|false } still works.
    const mode = body.mode !== undefined ? body.mode : (typeof body.off === 'boolean' ? (body.off ? 'off' : 'on') : null);
    if (!['on', 'off', 'except'].includes(mode)) return json({ error: 'bad_request' }, 400);
    const keep = mode === 'except' && Array.isArray(body.keep) ? [...new Set(body.keep.map(String).filter((id) => ID_RE.test(id)))].slice(0, 500) : [];
    res = await bot(c, '/api/owner-features', { method: 'POST', body: JSON.stringify({ key: body.key, mode, keep, by: `${s.session.user.name} (${s.session.user.id})` }) });
  } else {
    res = await bot(c, '/api/owner-features');
  }
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 404) return json({ error: 'bot_outdated' }, 501);
  if (res.status === 400) return json({ error: 'bad_request' }, 400);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
  return json(cleanOwnerFeatures(res.data));
}

/* ---------- suggestions for BEV: sent from /suggest or the website, answered by site admins ---------- */

function cleanSuggestion(x) {
  const status = ['pending', 'approved', 'denied'].includes(x && x.status) ? x.status : 'pending';
  return {
    id: Number(x.id) || 0, user_id: ID_RE.test(String(x.user_id)) ? String(x.user_id) : '', username: str(x.username, 64), display: str(x.display, 64),
    avatar: typeof x.avatar === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(x.avatar) ? x.avatar.slice(0, 300) : null,
    guild: str(x.guild, 100) || null, text: str(x.text, 1500), source: x.source === 'website' ? 'website' : 'discord',
    created: Number(x.created) || 0, status, decided_at: Number(x.decided_at) || null, decided_by: str(x.decided_by, 120) || null,
    note: str(x.note, 1000) || null, told: x.told === true,
  };
}

async function adminSuggestions(request, c, s, path) {
  let res;
  if (path === '/api/admin/suggestions/answer') {
    const body = await readJson(request, 4000);
    if (!body || !Number.isInteger(body.id) || !['approved', 'denied'].includes(body.decision)) return json({ error: 'bad_request' }, 400);
    res = await bot(c, '/api/bev-suggestions/answer', { method: 'POST', body: JSON.stringify({
      id: body.id, decision: body.decision, note: str(body.note, 1000), tell: body.tell === true, by: `${s.session.user.name} (${s.session.user.id})` }) });
  } else {
    res = await bot(c, '/api/bev-suggestions');
  }
  if (res.error) return json({ error: res.error }, 503);
  if (res.status === 404 && !(res.data && res.data.error)) return json({ error: 'bot_outdated' }, 501);
  if (res.status === 400 || res.status === 404) return json({ error: 'refused', message: str(res.data && res.data.error, 300) }, 400);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
  if (path === '/api/admin/suggestions/answer') return json({ ok: true, suggestion: cleanSuggestion(res.data.suggestion || {}), dm: typeof res.data.dm === 'boolean' ? res.data.dm : null });
  return json({ suggestions: (Array.isArray(res.data.suggestions) ? res.data.suggestions : []).slice(0, 300).map(cleanSuggestion), waiting: Number(res.data.waiting) || 0 });
}

// Anyone signed in can send a suggestion from the website. Who they are comes from their sign-in, never the page.
async function sendSuggestion(request, c, s) {
  if (!s.session) return json({ error: 'signed_out' }, 401);
  const body = await readJson(request, 4000);
  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length < 5 || text.length > 1500) return json({ error: 'invalid', message: 'Write between 5 and 1,500 characters.' }, 400);
  const u = s.session.user;
  const avatar = u.avatar && /^[\w]+$/.test(u.avatar) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null;
  const res = await bot(c, '/api/bev-suggestions/submit', { method: 'POST', body: JSON.stringify({ user_id: String(u.id), username: u.username || u.name, display: u.name, avatar, text }) });
  if (res.error) return json({ error: res.error, message: "BEV didn't answer. Try again in a minute." }, 503);
  if (res.status === 400) return json({ error: 'invalid', message: str(res.data && res.data.error, 300) }, 400);
  if (res.status === 404) return json({ error: 'bot_outdated', message: "This needs the newest version of BEV. Try again later." }, 501);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error', message: 'Something went wrong. Try again in a minute.' }, 502);
  return json({ ok: true, id: Number(res.data.id) || 0 });
}

/* ---------- ban appeals: someone banned from a server asks its staff to unban them ---------- */

// Who is appealing always comes from their sign-in; the page only says which server.
async function banAppeal(request, c, url, s) {
  const u = s.session.user;
  if (request.method === 'GET') {
    const guildId = url.searchParams.get('guild_id') || '';
    if (!ID_RE.test(guildId)) return json({ error: 'bad_request', message: 'That link is missing the server.' }, 400);
    const res = await bot(c, '/api/appeals/status?guild_id=' + guildId + '&user_id=' + String(u.id));
    if (res.error) return json({ error: res.error, message: "BEV didn't answer. Try again in a minute." }, 503);
    if (res.status === 404 && res.data && res.data.error) return json({ error: 'not_found', message: "BEV isn't in that server, so it can't take an appeal for it." }, 404);
    if (res.status === 404) return json({ error: 'bot_outdated', message: 'This needs the newest version of BEV. Try again later.' }, 501);
    if (res.status !== 200 || !res.data) return json({ error: 'bot_error', message: 'Something went wrong. Try again in a minute.' }, 502);
    const d = res.data;
    const a = d.appeal && typeof d.appeal === 'object' ? d.appeal : null;
    const g = d.guild || {};
    return json({
      guild: { id: String(g.id || guildId), name: str(g.name, 100), icon: typeof g.icon === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(g.icon) ? g.icon.slice(0, 300) : null },
      enabled: d.enabled === true, banned: d.banned === true, can_appeal: d.can_appeal === true, intro: str(d.intro, 600),
      wait_until: Number.isFinite(d.wait_until) ? d.wait_until : null, min: Number(d.min) || 20, max: Number(d.max) || 2000,
      appeal: a ? { id: Number(a.id) || 0, status: ['pending', 'approved', 'denied'].includes(a.status) ? a.status : 'pending',
                    created: Number(a.created) || 0, note: str(a.note, 500) || null } : null,
    });
  }
  const body = await readJson(request, 6000);
  const guildId = body && String(body.guild_id || '');
  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!ID_RE.test(guildId)) return json({ error: 'bad_request', message: 'That link is missing the server.' }, 400);
  if (text.length < 20 || text.length > 2000) return json({ error: 'invalid', message: 'Write between 20 and 2,000 characters.' }, 400);
  const avatar = u.avatar && /^[\w]+$/.test(u.avatar) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null;
  const res = await bot(c, '/api/appeals/submit', { method: 'POST', body: JSON.stringify({ guild_id: guildId, user_id: String(u.id), username: u.username || u.name, display: u.name, avatar, text }) });
  if (res.error) return json({ error: res.error, message: "BEV didn't answer. Try again in a minute." }, 503);
  if (res.status === 400) return json({ error: 'invalid', message: str(res.data && res.data.error, 300) || "That appeal couldn't be sent." }, 400);
  if (res.status === 404 && res.data && res.data.error) return json({ error: 'not_found', message: "BEV isn't in that server, so it can't take an appeal for it." }, 404);
  if (res.status === 404) return json({ error: 'bot_outdated', message: 'This needs the newest version of BEV. Try again later.' }, 501);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error', message: 'Something went wrong. Try again in a minute.' }, 502);
  return json({ ok: true, id: Number(res.data.id) || 0 });
}

/* ---------- the support chat: tickets with BEV's AI, passed to site admins when someone asks for a person ---------- */

const SUPPORT_WHO = new Set(['user', 'bev', 'agent', 'system', 'note']);
const SUPPORT_STATUS = new Set(['bot', 'waiting', 'agent', 'closed']);

function cleanTicket(t, admin, me) {
  t = t || {};
  const out = {
    id: Number(t.id) || 0, topic: ['question', 'suggestion'].includes(t.topic) ? t.topic : null, topic_label: str(t.topic_label, 60) || null,
    status: SUPPORT_STATUS.has(t.status) ? t.status : 'bot', created: Number(t.created) || 0, updated: Number(t.updated) || 0,
    with: t.with === 'Support Agent' ? 'Support Agent' : 'BEV',
    messages: (Array.isArray(t.messages) ? t.messages : []).slice(-300).filter(m => m && SUPPORT_WHO.has(m.who) && (admin || m.who !== 'note'))
      .map(m => Object.assign({ id: Number(m.id) || 0, who: m.who, text: str(m.text, 4000), at: Number(m.at) || 0 }, admin && m.agent ? { agent: str(m.agent, 80) } : {})),
  };
  if (admin) Object.assign(out, {
    user_id: ID_RE.test(String(t.user_id)) ? String(t.user_id) : '', username: str(t.username, 64), display: str(t.display, 64),
    avatar: typeof t.avatar === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(t.avatar) ? t.avatar.slice(0, 300) : null,
    agent: str(t.agent, 80) || null, agent_is_me: !!me && t.status === 'agent' && String(t.agent_id || '') === me, escalated: Number(t.escalated) || null, closed_by: str(t.closed_by, 80) || null,
  });
  return out;
}

function cleanTicketSummary(t) {
  t = t || {};
  return { id: Number(t.id) || 0, topic_label: str(t.topic_label, 60) || 'New ticket', status: SUPPORT_STATUS.has(t.status) ? t.status : 'bot',
           updated: Number(t.updated) || 0, created: Number(t.created) || 0, with: t.with === 'Support Agent' ? 'Support Agent' : 'BEV', last: str(t.last, 120) };
}

function supportError(res) {
  if (res.error) return json({ error: res.error, message: "BEV didn't answer. Try again in a minute." }, 503);
  if (res.status === 404 && !(res.data && res.data.error)) return json({ error: 'bot_outdated', message: 'This needs the newest version of BEV. Try again later.' }, 501);
  if ([400, 404, 429].includes(res.status)) return json({ error: 'refused', message: str(res.data && res.data.error, 300) }, res.status);
  if (res.status !== 200 || !res.data) return json({ error: 'bot_error', message: 'Something went wrong. Try again in a minute.' }, 502);
  return null;
}

// Who the person is always comes from their sign-in, never from the page.
async function supportChat(request, c, url, s, path) {
  const u = s.session.user;
  const uid = String(u.id);
  let res;
  if (path === '/api/support/mine') {
    res = await bot(c, '/api/site-support/mine?user_id=' + uid);
    return supportError(res) || json({ tickets: (Array.isArray(res.data.tickets) ? res.data.tickets : []).slice(0, 50).map(cleanTicketSummary) });
  }
  if (path === '/api/support/ticket') {
    const id = url.searchParams.get('id') || '';
    if (!/^\d{1,10}$/.test(id)) return json({ error: 'bad_request' }, 400);
    res = await bot(c, '/api/site-support/ticket?user_id=' + uid + '&id=' + id);
    return supportError(res) || json({ ticket: cleanTicket(res.data.ticket, false) });
  }
  const body = (await readJson(request, 6000)) || {};
  if (path === '/api/support/new') {
    const avatar = u.avatar && /^[\w]+$/.test(u.avatar) ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null;
    res = await bot(c, '/api/site-support/new', { method: 'POST', body: JSON.stringify({ user_id: uid, username: u.username || u.name, display: u.name, avatar }) });
    return supportError(res) || json({ ticket: cleanTicket(res.data.ticket, false) });
  }
  if (!Number.isInteger(body.id)) return json({ error: 'bad_request' }, 400);
  const send = { user_id: uid, id: body.id };
  if (path === '/api/support/topic') {
    if (!['question', 'suggestion', 'nevermind'].includes(body.topic)) return json({ error: 'bad_request' }, 400);
    send.topic = body.topic;
  }
  if (path === '/api/support/send') {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) return json({ error: 'invalid', message: 'Write a message (at most 2,000 characters).' }, 400);
    send.text = body.text;
  }
  res = await bot(c, '/api/site-support/' + path.slice('/api/support/'.length), { method: 'POST', body: JSON.stringify(send) });
  const bad = supportError(res);
  if (bad) return bad;
  if (res.data.deleted) return json({ deleted: true });
  return json({ ticket: cleanTicket(res.data.ticket, false) });
}

async function adminSupport(request, c, s, path) {
  let res;
  if (path === '/api/admin/support/act') {
    const body = await readJson(request, 6000);
    if (!body || !Number.isInteger(body.id) || !['accept', 'reply', 'note', 'close'].includes(body.action)) return json({ error: 'bad_request' }, 400);
    res = await bot(c, '/api/site-support/admin/act', { method: 'POST', body: JSON.stringify({
      id: body.id, action: body.action, text: str(body.text, 2000), by: s.session.user.name, by_id: String(s.session.user.id) }) });
    return supportError(res) || json({ ticket: cleanTicket(res.data.ticket, true, String(s.session.user.id)) });
  }
  res = await bot(c, '/api/site-support/admin');
  return supportError(res) || json({ tickets: (Array.isArray(res.data.tickets) ? res.data.tickets : []).slice(0, 200).map(t => cleanTicket(t, true, String(s.session.user.id))),
                                     waiting: Number(res.data.waiting) || 0 });
}

/* ---------- 4.64: Premium. Built and ready, but off until BEV's owner switches it on from /admin ---------- */
// BEV (the bot) keeps who has Premium and which features need it. This file only talks to the payment providers:
//   • Stripe: card, Apple Pay and Google Pay. Needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Cloudflare.
//   • PayPal: needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID (and PAYPAL_MODE=sandbox while testing).
// Both pay out to the owner's own bank account from their Stripe or PayPal account: nothing here touches bank details.
// A payment provider's webhook says a subscription changed; this file looks the subscription up again with the provider
// (so a faked webhook can't give anyone Premium) and tells the bot how long that person's Premium runs.

const PREMIUM_PATHS = new Set(['/premium']);
const PREMIUM_FOREVER = 253402300799;
let premiumMemo = { at: 0, value: null };

function payConfig(env) {
  const get = (k) => {
    const v = String(env[k] ?? '').trim();
    return v && !/^YOUR_/i.test(v) ? v : '';
  };
  const mode = get('PAYPAL_MODE').toLowerCase() === 'live' ? 'live' : 'sandbox';
  return {
    stripeKey: get('STRIPE_SECRET_KEY'), stripeHook: get('STRIPE_WEBHOOK_SECRET'),
    paypalId: get('PAYPAL_CLIENT_ID'), paypalSecret: get('PAYPAL_CLIENT_SECRET'), paypalHook: get('PAYPAL_WEBHOOK_ID'), paypalMode: mode,
    paypalBase: mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
  };
}

function cleanPlanList(list) {
  return (Array.isArray(list) ? list : []).slice(0, 400).map((x) => ({ key: str(x.key, 60), name: str(x.name, 160), icon: str(x.icon, 16), kind: str(x.kind, 10) }));
}

async function premiumPublic(c, fresh = false) {
  if (!fresh && premiumMemo.value && Date.now() - premiumMemo.at < 60000) return premiumMemo.value;
  const res = await bot(c, '/api/premium/public');
  if (res.status !== 200 || !res.data) return premiumMemo.value || { enabled: false, month: 500, year: 5400, free: [], premium: [], unreachable: true };
  const d = res.data;
  const value = { enabled: d.enabled === true, currency: 'GBP', month: Number(d.month) || 500, year: Number(d.year) || 5400,
    free: cleanPlanList(d.free), premium: cleanPlanList(d.premium) };
  premiumMemo = { at: Date.now(), value };
  return value;
}

async function premiumPerson(c, userId) {
  const res = await bot(c, `/api/premium/user?user_id=${userId}`);
  if (res.status !== 200 || !res.data) return null;
  const d = res.data;
  return { has: d.has === true, until: Number(d.until) || null, plan: str(d.plan, 10) || null, source: str(d.source, 10) || null,
    status: str(d.status, 40) || null, customer: str(d.customer, 120) || null,
    servers: (Array.isArray(d.servers) ? d.servers : []).slice(0, 200).map((g) => ({ id: str(g.id, 25), name: str(g.name, 100) })) };
}

async function grantPremium(c, body) {
  const res = await bot(c, '/api/premium/grant', { method: 'POST', body: JSON.stringify(body) });
  return res.status === 200;
}

/* ----- Stripe ----- */

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') form(v, key, out);
    else if (v !== undefined && v !== null) out.append(key, String(v));
  }
  return out;
}

async function stripe(p, method, path, body) {
  const r = await fetch('https://api.stripe.com' + path, {
    method,
    headers: { authorization: `Bearer ${p.stripeKey}`, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
    body: body ? form(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function stripeSignatureOk(secret, header, payload) {
  const parts = Object.create(null);
  const sigs = [];
  for (const piece of String(header || '').split(',')) {
    const [k, v] = piece.split('=');
    if (k === 'v1') sigs.push(v); else if (k) parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, te.encode(`${t}.${payload}`)));
  return sigs.some((s) => s.length === want.length && [...s].reduce((acc, ch, i) => acc | (ch.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

// Looks the subscription up with Stripe and tells the bot. Statuses that still mean "paid up" keep Premium.
async function syncStripeSubscription(c, p, subId) {
  if (!/^sub_[A-Za-z0-9]{6,80}$/.test(subId || '')) return false;
  const { status, data } = await stripe(p, 'GET', `/v1/subscriptions/${subId}`);
  if (status !== 200 || !data) return false;
  const userId = String((data.metadata && data.metadata.user_id) || '');
  if (!ID_RE.test(userId)) return false;
  const item = data.items && data.items.data && data.items.data[0];
  const end = Number(data.current_period_end || (item && item.current_period_end) || 0);
  const interval = item && item.price && item.price.recurring ? item.price.recurring.interval : null;
  const live = ['active', 'trialing', 'past_due'].includes(data.status);
  const until = live ? end : Number(data.ended_at || data.canceled_at || Date.now() / 1000);
  return grantPremium(c, { user_id: userId, until, plan: interval === 'year' ? 'year' : 'month', source: 'stripe', ref: subId,
    customer: typeof data.customer === 'string' ? data.customer : '', status: data.status });
}

async function stripeWebhook(request, env, c) {
  const p = payConfig(env);
  if (!p.stripeKey || !p.stripeHook) return json({ error: 'not_configured' }, 503);
  const payload = await request.text();
  if (payload.length > 200000) return json({ error: 'too_big' }, 413);
  if (!(await stripeSignatureOk(p.stripeHook, request.headers.get('stripe-signature'), payload))) return json({ error: 'bad_signature' }, 400);
  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'bad_request' }, 400); }
  const o = (event && event.data && event.data.object) || {};
  let subId = '';
  if (event.type === 'checkout.session.completed') subId = o.subscription;
  else if (String(event.type).startsWith('customer.subscription.')) subId = o.id;
  else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    subId = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || '';
  }
  if (typeof subId === 'string' && subId) {
    const ok = await syncStripeSubscription(c, p, subId);
    if (!ok) return json({ error: 'sync_failed' }, 500);   // Stripe tries again later
  }
  return json({ ok: true });
}

/* ----- PayPal ----- */

async function paypalToken(p) {
  const r = await fetch(p.paypalBase + '/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: 'Basic ' + btoa(`${p.paypalId}:${p.paypalSecret}`), 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status !== 200) return '';
  try { return (await r.json()).access_token || ''; } catch { return ''; }
}

async function paypal(p, token, method, path, body) {
  const r = await fetch(p.paypalBase + path, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' },
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
}

async function syncPaypalSubscription(c, p, token, subId) {
  if (!/^I-[A-Z0-9]{6,40}$/.test(subId || '')) return false;
  const { status, data } = await paypal(p, token, 'GET', `/v1/billing/subscriptions/${subId}`);
  if (status !== 200 || !data) return false;
  const userId = String(data.custom_id || '');
  if (!ID_RE.test(userId)) return false;
  const plans = await paypalPlans(c);
  const yearly = data.plan_id && data.plan_id === plans.year;
  const info = data.billing_info || {};
  const next = Date.parse(info.next_billing_time || '') / 1000;
  const last = Date.parse((info.last_payment && info.last_payment.time) || '') / 1000;
  const paidUntil = last ? last + (yearly ? 366 : 31) * 86400 : 0;
  // Active: paid up to the next charge. Cancelled or expired: what was already paid for still counts until it runs out.
  const until = data.status === 'ACTIVE' ? (next || paidUntil) : data.status === 'APPROVAL_PENDING' ? 0 : (paidUntil || Date.now() / 1000);
  return grantPremium(c, { user_id: userId, until, plan: yearly ? 'year' : 'month', source: 'paypal', ref: subId, status: String(data.status || '').toLowerCase() });
}

async function paypalPlans(c) {
  const res = await bot(c, '/api/premium/admin');
  return (res.status === 200 && res.data && res.data.paypal_plans) || {};
}

async function paypalWebhook(request, env, c) {
  const p = payConfig(env);
  if (!p.paypalId || !p.paypalSecret || !p.paypalHook) return json({ error: 'not_configured' }, 503);
  const payload = await request.text();
  if (payload.length > 200000) return json({ error: 'too_big' }, 413);
  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'bad_request' }, 400); }
  const token = await paypalToken(p);
  if (!token) return json({ error: 'paypal_unreachable' }, 500);
  const h = (k) => request.headers.get(k) || '';
  const check = await paypal(p, token, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: p.paypalHook, webhook_event: event,
  });
  if (!check.data || check.data.verification_status !== 'SUCCESS') return json({ error: 'bad_signature' }, 400);
  const r = event.resource || {};
  const subId = String(event.event_type || '').startsWith('BILLING.SUBSCRIPTION.') ? r.id : r.billing_agreement_id;
  if (subId) {
    const ok = await syncPaypalSubscription(c, p, token, subId);
    if (!ok) return json({ error: 'sync_failed' }, 500);
  }
  return json({ ok: true });
}

/* ----- what people do on /premium ----- */

async function premiumApi(request, env, c, url, s, path) {
  if (path === '/api/premium') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const plans = await premiumPublic(c);
    const p = payConfig(env);
    const out = { ...plans, providers: { stripe: !!p.stripeKey, paypal: !!(p.paypalId && p.paypalSecret) }, signedIn: !!s.session };
    if (!plans.enabled) return json({ enabled: false });
    if (s.session) out.me = await premiumPerson(c, String(s.session.user.id));
    return json(out);
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (request.headers.get('origin') !== url.origin) return json({ error: 'bad_origin' }, 403);
  if (!s.session) return json({ error: 'signed_out' }, 401);
  const plans = await premiumPublic(c, true);
  if (!plans.enabled) return json({ error: 'premium_off' }, 403);
  const userId = String(s.session.user.id);
  const p = payConfig(env);
  if (path === '/api/premium/checkout') {
    const body = await readJson(request, 500);
    const plan = body && body.plan === 'year' ? 'year' : 'month';
    const provider = body && body.provider === 'paypal' ? 'paypal' : 'stripe';
    const back = `${url.origin}/premium`;
    if (provider === 'stripe') {
      if (!p.stripeKey) return json({ error: 'stripe_not_set_up' }, 503);
      const me = await premiumPerson(c, userId);
      const session = {
        mode: 'subscription', success_url: `${back}?paid=1`, cancel_url: `${back}?cancelled=1`, client_reference_id: userId,
        allow_promotion_codes: 'true', metadata: { user_id: userId }, subscription_data: { metadata: { user_id: userId } },
        line_items: { 0: { quantity: 1, price_data: { currency: 'gbp', unit_amount: plan === 'year' ? plans.year : plans.month,
          recurring: { interval: plan }, product_data: { name: plan === 'year' ? 'BEV Premium (yearly)' : 'BEV Premium (monthly)' } } } },
      };
      if (me && /^cus_/.test(me.customer || '')) session.customer = me.customer;
      const r = await stripe(p, 'POST', '/v1/checkout/sessions', session);
      if (r.status !== 200 || !r.data || !/^https:\/\/checkout\.stripe\.com\//.test(r.data.url || '')) return json({ error: 'stripe_error' }, 502);
      return json({ url: r.data.url });
    }
    if (!p.paypalId || !p.paypalSecret) return json({ error: 'paypal_not_set_up' }, 503);
    const ids = await paypalPlans(c);
    if (!ids[plan] || ids.mode !== p.paypalMode) return json({ error: 'paypal_plans_missing' }, 503);
    const token = await paypalToken(p);
    if (!token) return json({ error: 'paypal_error' }, 502);
    const r = await paypal(p, token, 'POST', '/v1/billing/subscriptions', {
      plan_id: ids[plan], custom_id: userId,
      application_context: { brand_name: 'BEV', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: `${back}?paid=1`, cancel_url: `${back}?cancelled=1` },
    });
    const link = r.data && Array.isArray(r.data.links) ? r.data.links.find((l) => l.rel === 'approve') : null;
    if (!link || !/^https:\/\/www\.(sandbox\.)?paypal\.com\//.test(link.href || '')) return json({ error: 'paypal_error' }, 502);
    return json({ url: link.href });
  }
  if (path === '/api/premium/manage') {
    const me = await premiumPerson(c, userId);
    if (!me || !me.source) return json({ error: 'no_subscription' }, 400);
    if (me.source === 'paypal') return json({ url: p.paypalMode === 'live' ? 'https://www.paypal.com/myaccount/autopay/' : 'https://www.sandbox.paypal.com/myaccount/autopay/' });
    if (me.source !== 'stripe' || !/^cus_/.test(me.customer || '') || !p.stripeKey) return json({ error: 'no_subscription' }, 400);
    const r = await stripe(p, 'POST', '/v1/billing_portal/sessions', { customer: me.customer, return_url: `${url.origin}/premium` });
    if (r.status !== 200 || !r.data || !/^https:\/\/billing\.stripe\.com\//.test(r.data.url || '')) return json({ error: 'stripe_portal_error' }, 502);
    return json({ url: r.data.url });
  }
  return json({ error: 'not_found' }, 404);
}

/* ----- the Admin page's Premium section (admins allowed "premium" in their admin permissions) ----- */

async function adminPremium(request, env, c, s, url, path) {
  const p = payConfig(env);
  const providerState = () => ({
    stripe: { key: !!p.stripeKey, keyLive: /^sk_live_/.test(p.stripeKey), webhook: !!p.stripeHook, webhookUrl: `${url.origin}/api/stripe/webhook` },
    paypal: { id: !!p.paypalId, secret: !!p.paypalSecret, webhook: !!p.paypalHook, mode: p.paypalMode, webhookUrl: `${url.origin}/api/paypal/webhook` },
  });
  const load = async () => {
    const res = await bot(c, '/api/premium/admin');
    if (res.error) return { error: res.error };
    if (res.status === 404) return { error: 'bot_outdated' };
    if (res.status !== 200 || !res.data) return { error: 'bot_error' };
    return res.data;
  };
  const answer = (d) => (d.error ? json({ error: d.error }, d.error === 'bot_outdated' ? 501 : 503) : json({ ...cleanAdminPremium(d), providers: providerState() }));
  if (path === '/api/admin/premium') return answer(await load());
  const body = (await readJson(request, 60000)) || {};
  if (path === '/api/admin/premium/set') {
    const out = {};
    if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
    if (body.reset_tiers === true) out.reset_tiers = true;
    if (body.tiers && typeof body.tiers === 'object') {
      out.tiers = { features: {}, settings: {} };
      for (const part of ['features', 'settings']) {
        for (const [k, v] of Object.entries(body.tiers[part] || {}).slice(0, 600)) if (/^[a-z0-9_]{1,60}$/.test(k) && typeof v === 'boolean') out.tiers[part][k] = v;
      }
    }
    const res = await bot(c, '/api/premium/admin', { method: 'POST', body: JSON.stringify(out) });
    premiumMemo = { at: 0, value: null };
    if (res.status !== 200 || !res.data) return json({ error: res.error || 'bot_error' }, 502);
    return answer(res.data);
  }
  if (path === '/api/admin/premium/gift') {
    const id = String(body.user_id || '');
    const forever = body.forever === true;
    const days = forever ? 1 : Number(body.days);
    if (!ID_RE.test(id) || !Number.isInteger(days) || days < 0 || days > 3660) return json({ error: 'bad_request' }, 400);
    // "Until I take it away": the last second of the year 9999, which the bot also treats as never ending.
    const until = forever ? PREMIUM_FOREVER : days ? Date.now() / 1000 + days * 86400 : 0;
    const what = forever ? 'Given until taken away' : days ? `Given for ${days} days` : 'Taken away';
    const ok = await grantPremium(c, { user_id: id, until, plan: 'gift', source: 'admin', status: days ? 'gift' : 'removed',
      note: `${what} by ${s.session.user.name} (${s.session.user.id})` });
    if (!ok) return json({ error: 'bot_error' }, 502);
    return answer(await load());
  }
  if (path === '/api/admin/premium/paypal-plans') {
    if (!p.paypalId || !p.paypalSecret) return json({ error: 'paypal_not_set_up' }, 400);
    const token = await paypalToken(p);
    if (!token) return json({ error: 'paypal_login_failed' }, 502);
    const prices = await premiumPublic(c, true);
    const product = await paypal(p, token, 'POST', '/v1/catalogs/products', { name: 'BEV Premium', type: 'SERVICE', category: 'SOFTWARE' });
    if (!product.data || !product.data.id) return json({ error: 'paypal_error' }, 502);
    const makePlan = (unit, pence, name) => paypal(p, token, 'POST', '/v1/billing/plans', {
      product_id: product.data.id, name, status: 'ACTIVE',
      billing_cycles: [{ frequency: { interval_unit: unit, interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: (pence / 100).toFixed(2), currency_code: 'GBP' } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
    });
    const month = await makePlan('MONTH', prices.month, 'BEV Premium (monthly)');
    const year = await makePlan('YEAR', prices.year, 'BEV Premium (yearly)');
    if (!month.data || !month.data.id || !year.data || !year.data.id) return json({ error: 'paypal_error' }, 502);
    const res = await bot(c, '/api/premium/admin', { method: 'POST', body: JSON.stringify({ paypal_plans: { product: product.data.id, month: month.data.id, year: year.data.id, mode: p.paypalMode } }) });
    if (res.status !== 200 || !res.data) return json({ error: 'bot_error' }, 502);
    return answer(res.data);
  }
  if (path === '/api/admin/premium/check') {
    const checks = [];
    const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });
    if (!p.stripeKey) add('stripe', 'Stripe', false, 'STRIPE_SECRET_KEY isn\'t set in Cloudflare yet.');
    else {
      const r = await stripe(p, 'GET', '/v1/balance');
      add('stripe', 'Stripe', r.status === 200, r.status === 200 ? `Connected (${/^sk_live_/.test(p.stripeKey) ? 'live' : 'test'} mode).` : 'Stripe refused the key. Copy the secret key again.');
    }
    add('stripe_hook', 'Stripe webhook', !!p.stripeHook, p.stripeHook ? 'STRIPE_WEBHOOK_SECRET is set.' : 'STRIPE_WEBHOOK_SECRET isn\'t set, so payments can\'t switch Premium on.');
    if (!p.paypalId || !p.paypalSecret) add('paypal', 'PayPal', false, 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET aren\'t both set.');
    else {
      const ok = !!(await paypalToken(p));
      add('paypal', 'PayPal', ok, ok ? `Connected (${p.paypalMode}).` : 'PayPal refused the client ID and secret, or PAYPAL_MODE is wrong.');
      const plans = await paypalPlans(c);
      add('paypal_plans', 'PayPal plans', !!(plans.month && plans.year && plans.mode === p.paypalMode),
        plans.month && plans.mode === p.paypalMode ? 'Monthly and yearly plans are made.' : 'Press "Make the PayPal plans".');
    }
    add('paypal_hook', 'PayPal webhook', !!p.paypalHook, p.paypalHook ? 'PAYPAL_WEBHOOK_ID is set.' : 'PAYPAL_WEBHOOK_ID isn\'t set, so PayPal payments can\'t switch Premium on.');
    return json({ checks, providers: providerState() });
  }
  return json({ error: 'not_found' }, 404);
}

function cleanAdminPremium(d) {
  const b = (v) => v === true;
  return {
    enabled: b(d.enabled), month: Number(d.month) || 500, year: Number(d.year) || 5400,
    features: (Array.isArray(d.features) ? d.features : []).slice(0, 200).map((f) => ({ key: str(f.key, 60), name: str(f.name, 100), icon: str(f.icon, 16),
      category: str(f.category, 30), premium: b(f.premium), default: b(f.default),
      settings: (Array.isArray(f.settings) ? f.settings : []).slice(0, 60).map((x) => ({ key: str(x.key, 60), label: str(x.label, 120), premium: b(x.premium), default: b(x.default) })) })),
    categories: (Array.isArray(d.categories) ? d.categories : []).slice(0, 30).map((x) => ({ key: str(x.key, 30), icon: str(x.icon, 16), name: str(x.name, 60) })),
    people: (Array.isArray(d.people) ? d.people : []).slice(0, 500).map((x) => ({ user_id: str(x.user_id, 25), until: Number(x.until) || 0, plan: str(x.plan, 10),
      source: str(x.source, 10), status: str(x.status, 40), note: str(x.note, 200), active: b(x.active) })),
    paypalPlans: d.paypal_plans && typeof d.paypal_plans === 'object' ? { month: !!d.paypal_plans.month, year: !!d.paypal_plans.year, mode: str(d.paypal_plans.mode, 10) } : {},
    freeCount: Number(d.free_count) || 0, premiumCount: Number(d.premium_count) || 0,
  };
}

/* ---------- 4.64: what each site admin can see and do on /admin (chosen by the admin managers) ---------- */

const ADMIN_SECTIONS = [
  ['inbox', 'Inbox'], ['suggestions', 'Suggestions'], ['support', 'Support chats'], ['feats', 'Dashboard settings'], ['maint', 'Maintenance mode'],
  ['alert', 'Discord alert'], ['bann', 'Announcement banner'], ['visits', 'Visits'], ['health', 'Bot health'], ['bdata', "BEV's data"],
  ['check', 'Connection check'], ['premium', 'Premium and payments'], ['admins', 'Site admins'],
];
const ADMIN_SECTION_KEYS = new Set(ADMIN_SECTIONS.map(([k]) => k));
const PERM_LEVELS = ['off', 'view', 'full'];
// Until a manager changes it, admins can use what they always could; Premium and payments start hidden from them.
const PERM_DEFAULT = { premium: 'off' };

function adminPermsFor(c, s, id) {
  if (ADMIN_MANAGER_IDS.includes(String(id))) return Object.fromEntries(ADMIN_SECTIONS.map(([k]) => [k, 'full']));
  const saved = (s.site && s.site.adminPerms && s.site.adminPerms.perms && s.site.adminPerms.perms[String(id)]) || {};
  return Object.fromEntries(ADMIN_SECTIONS.map(([k]) => [k, PERM_LEVELS.includes(saved[k]) ? saved[k] : (PERM_DEFAULT[k] || 'full')]));
}

function adminSectionOf(path) {
  if (path.startsWith('/api/admin/inbox')) return 'inbox';
  if (path.startsWith('/api/admin/suggestions')) return 'suggestions';
  if (path.startsWith('/api/admin/support')) return 'support';
  if (path.startsWith('/api/admin/features')) return 'feats';
  if (path === '/api/admin/maintenance') return 'maint';
  if (path.startsWith('/api/admin/alert')) return 'alert';
  if (path === '/api/admin/banner') return 'bann';
  if (path === '/api/admin/health') return 'health';
  if (path.startsWith('/api/admin/data') || path.startsWith('/api/admin/backup')) return 'bdata';
  if (path === '/api/admin/check') return 'check';
  if (path.startsWith('/api/admin/premium')) return 'premium';
  if (path === '/api/admin/admins' || path === '/api/admin/perms') return 'admins';
  return null;
}

async function changeAdminPerms(request, env, c, s) {
  const me = String(s.session.user.id);
  if (!ADMIN_MANAGER_IDS.includes(me)) return json({ error: 'not_manager' }, 403);
  if (!database(env)) return json({ error: 'no_database' }, 503);
  const body = await readJson(request, 4000);
  const id = body && String(body.id || '');
  if (!ID_RE.test(id || '') || !c.adminIds.includes(id)) return json({ error: 'not_admin' }, 400);
  if (ADMIN_MANAGER_IDS.includes(id)) return json({ error: 'manager_has_all' }, 400);
  const changes = body.perms && typeof body.perms === 'object' ? body.perms : {};
  const all = structuredClone((s.site.adminPerms && s.site.adminPerms.perms) || {});
  const mine = { ...(all[id] || {}) };
  for (const [k, v] of Object.entries(changes)) {
    if (!ADMIN_SECTION_KEYS.has(k) || !PERM_LEVELS.includes(v)) return json({ error: 'bad_request' }, 400);
    mine[k] = v;
  }
  all[id] = mine;
  try {
    await saveSetting(env, 'adminPerms', { perms: all }, `${s.session.user.name} (${me})`);
  } catch {
    return json({ error: 'database_error' }, 503);
  }
  s.site = await loadSite(env);
  return json(await adminState(env, c, s, s.site));
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = config(env);
    const secure = url.protocol === 'https:';
    const path = url.pathname;
    try {
      // Signing in always works, so admins can still sign in while the site is in maintenance.
      if (path === '/auth/login' && request.method === 'GET') return withSecurity(await login(c, url, secure));
      if (path === '/auth/callback' && request.method === 'GET') return withSecurity(await callback(request, c, url, secure));
      if (path === '/auth/logout' && request.method === 'POST') return withSecurity(await logout(request, c, url, secure));
      if (STATIC_FILE.test(path)) return env.ASSETS.fetch(request);

      const site = await loadSite(env);
      applyAdmins(c, site);
      const session = await readSession(request, c, secure);
      const admin = !!session && c.adminIds.includes(String(session.user.id));
      const s = { site, session, admin, down: maintenanceOn(site.maintenance) };

      // Payment providers telling BEV about a subscription: checked against the provider itself, so they skip sign-in.
      if (path === '/api/stripe/webhook' && request.method === 'POST') return withSecurity(await stripeWebhook(request, env, c));
      if (path === '/api/paypal/webhook' && request.method === 'POST') return withSecurity(await paypalWebhook(request, env, c));
      if (path.startsWith('/api/admin/')) return withSecurity(await adminApi(request, env, c, url, secure, s));
      if (s.down && !admin && path !== '/api/me') {
        if (path.startsWith('/api/')) return withSecurity(json({ error: 'maintenance' }, 503));
        return maintenancePage(site.maintenance, request.method);
      }
      if (path === '/api/updates') return withSecurity(await updatesApi(request, env, url, s));
      if (path.startsWith('/api/')) return withSecurity(await api(request, c, url, secure, s, env));
      if (DASHBOARD_PATHS.has(path)) return await dashboardPage(request, env, ctx, c, secure, s);
      if (ADMIN_PATHS.has(path)) return await adminPage(request, env, ctx, secure, s);
      // A bracket's page: /bracket/<server>/<bracket> shows bracket.html, which loads the bracket itself.
      if (/^\/bracket\/\d{15,25}\/\d{1,10}\/?$/.test(path)) {
        return await servePage(new Request(new URL('/bracket', url), request), env, ctx, s, { noStore: true, count: false });
      }
      return await servePage(request, env, ctx, s);
    } catch {
      return withSecurity(json({ error: 'server_error' }, 500));
    }
  },
};
