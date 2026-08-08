const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const STORE_PATH = path.join(DATA_DIR, 'access-db.json');
const ACCESS_COOKIE = 'bingo_access';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h host session
const MAX_LOGS_PER_ACCOUNT = 80;
const MAX_ACTIVITY = 500;
const GUEST_DEMO_ID = '00000000-0000-4000-8000-0000000000aa';

/** @typedef {'demo'|'day'|'days3'|'week'|'month'} AccessPlan */

const PLAN_META = {
  demo: {
    label: 'Demo (15 spins)',
    usernamePrefix: 'DEMO',
    durationMs: 30 * 60 * 1000,
    startOnFirstLogin: true,
    rounds: 15,
    maxPlayers: 5,
  },
  day: {
    label: '1 day',
    usernamePrefix: 'DAY',
    durationMs: 24 * 60 * 60 * 1000,
    startOnFirstLogin: true,
    rounds: 90,
    maxPlayers: 150,
  },
  days3: {
    label: '3 days',
    usernamePrefix: '3DAY',
    durationMs: 3 * 24 * 60 * 60 * 1000,
    startOnFirstLogin: true,
    rounds: 90,
    maxPlayers: 150,
  },
  week: {
    label: '1 week',
    usernamePrefix: 'WEEK',
    durationMs: 7 * 24 * 60 * 60 * 1000,
    startOnFirstLogin: true,
    rounds: 90,
    maxPlayers: 150,
  },
  month: {
    label: '1 month',
    usernamePrefix: 'MONTH',
    durationMs: 30 * 24 * 60 * 60 * 1000,
    startOnFirstLogin: true,
    rounds: 90,
    maxPlayers: 150,
  },
};

let cache = null;

function defaultStore() {
  return { accounts: [], sessions: [], activity: [] };
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(len = 10) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();
}

function readStore() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!Array.isArray(parsed.accounts)) parsed.accounts = [];
    if (!Array.isArray(parsed.sessions)) parsed.sessions = [];
    if (!Array.isArray(parsed.activity)) parsed.activity = [];
    cache = parsed;
    normalizeFirstLoginExpiry(cache);
    return cache;
  } catch {
    cache = defaultStore();
    writeStore(cache);
    return cache;
  }
}

/** Plans that start on first open should not expire until first login. */
function normalizeFirstLoginExpiry(store) {
  let changed = false;
  for (const account of store.accounts) {
    const meta = planMeta(account.plan);
    if (!meta?.startOnFirstLogin) continue;
    if (!account.firstLoginAt && account.expiresAt) {
      account.expiresAt = null;
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

function writeStore(data) {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
  cache = data;
}

function pushActivity(store, entry) {
  store.activity.unshift({
    id: crypto.randomUUID(),
    at: nowIso(),
    ...entry,
  });
  if (store.activity.length > MAX_ACTIVITY) {
    store.activity.length = MAX_ACTIVITY;
  }
}

function planMeta(plan) {
  return PLAN_META[plan] || null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const e = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function makeAccount(plan, note = '', email = '', options = {}) {
  const meta = planMeta(plan);
  if (!meta) throw new Error('Invalid plan');
  const createdAt = Date.now();
  const expiresAt = meta.startOnFirstLogin
    ? null
    : new Date(createdAt + meta.durationMs).toISOString();
  const normalizedEmail = normalizeEmail(email);
  const selfRegistered = !!options.selfRegistered;
  const password = options.password
    ? String(options.password)
    : randomToken(8);

  const customerName = String(options.customerName || note || '')
    .trim()
    .slice(0, 80);

  return {
    id: crypto.randomUUID(),
    plan,
    email: normalizedEmail || '',
    username: `${meta.usernamePrefix}-${randomToken(6)}`,
    password,
    selfRegistered,
    customerName,
    note: customerName,
    paid: !!options.paid,
    disabled: false,
    disabledAt: null,
    disabledReason: null,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt,
    firstLoginAt: null,
    lastLoginAt: null,
    loginCount: 0,
    lastIp: null,
    lastCountry: null,
    lastCity: null,
    lastRegion: null,
    usageLogs: [],
  };
}

function publicAccount(account, { includePassword = true } = {}) {
  const status = getAccountStatus(account);
  const meta = planMeta(account.plan) || {};
  return {
    id: account.id,
    plan: account.plan,
    planLabel: meta.label || account.plan,
    tier: account.plan,
    rounds: meta.rounds || 15,
    maxPlayers: meta.maxPlayers || 5,
    email: account.email || '',
    username: account.username,
    ...(includePassword ? { password: account.password } : {}),
    selfRegistered: !!account.selfRegistered,
    guest: !!account.guest,
    customerName: account.customerName || account.note || '',
    note: account.note || account.customerName || '',
    paid: !!account.paid,
    disabled: !!account.disabled,
    disabledAt: account.disabledAt,
    disabledReason: account.disabledReason,
    createdAt: account.createdAt,
    expiresAt: account.expiresAt,
    firstLoginAt: account.firstLoginAt,
    lastLoginAt: account.lastLoginAt,
    loginCount: account.loginCount || 0,
    lastIp: account.lastIp,
    lastCountry: account.lastCountry,
    lastCity: account.lastCity,
    lastRegion: account.lastRegion,
    status: status.state,
    statusLabel: status.label,
    msRemaining: status.msRemaining,
    usageLogs: (account.usageLogs || []).slice(0, 20),
  };
}

function ensureGuestDemoAccount(store) {
  let account = store.accounts.find((a) => a.id === GUEST_DEMO_ID);
  if (!account) {
    account = {
      id: GUEST_DEMO_ID,
      plan: 'demo',
      email: '',
      username: 'GUEST-DEMO',
      password: 'GUEST-DEMO',
      selfRegistered: false,
      guest: true,
      note: 'Built-in free demo',
      disabled: false,
      disabledAt: null,
      disabledReason: null,
      createdAt: nowIso(),
      expiresAt: null,
      firstLoginAt: null,
      lastLoginAt: null,
      loginCount: 0,
      lastIp: null,
      lastCountry: null,
      lastCity: null,
      lastRegion: null,
      usageLogs: [],
    };
    store.accounts.unshift(account);
    writeStore(store);
  } else if (account.disabled || account.plan !== 'demo') {
    account.disabled = false;
    account.plan = 'demo';
    account.guest = true;
    account.expiresAt = null;
    writeStore(store);
  }
  return account;
}

function createGuestDemoSession() {
  const store = readStore();
  const account = ensureGuestDemoAccount(store);
  const session = createSession(account.id);
  return {
    token: session.token,
    code: publicAccount(account),
    account: publicAccount(account),
    expiresAt: session.expiresAt,
  };
}

function formatRemaining(ms) {
  if (ms == null) return 'Starts on login';
  if (ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getAccountStatus(account) {
  if (account.disabled) {
    return { state: 'disabled', label: 'Disabled', msRemaining: 0 };
  }
  if (!account.expiresAt && planMeta(account.plan)?.startOnFirstLogin && !account.firstLoginAt) {
    return { state: 'ready', label: 'Ready (starts on login)', msRemaining: null };
  }
  if (account.expiresAt) {
    const ms = new Date(account.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      return { state: 'expired', label: 'Expired', msRemaining: 0 };
    }
    return { state: 'active', label: 'Active', msRemaining: ms };
  }
  return { state: 'active', label: 'Active', msRemaining: null };
}

function isAccountUsable(account) {
  const status = getAccountStatus(account);
  return status.state === 'active' || status.state === 'ready';
}

function passwordsMatch(input, account) {
  const stored = String(account?.password || '');
  const given = String(input || '');
  if (!stored || !given) return false;
  if (account.selfRegistered) return stored === given;
  // Admin-generated codes were historically case-insensitive
  return stored === given || stored.toUpperCase() === given.toUpperCase();
}

function findAccountByCredentials(emailOrUsername, password) {
  const login = String(emailOrUsername || '').trim();
  const given = String(password || '').trim();
  if (!login || !given) return null;
  const store = readStore();
  const email = normalizeEmail(login);
  return (
    store.accounts.find((a) => {
      if (!passwordsMatch(given, a)) return false;
      if (a.email && normalizeEmail(a.email) === email) return true;
      return String(a.username).toUpperCase() === login.toUpperCase();
    }) || null
  );
}

function findAccountById(id) {
  return readStore().accounts.find((a) => a.id === id) || null;
}

function signupAccount(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const pass = String(password || '');
  if (!isValidEmail(normalizedEmail)) throw new Error('Enter a valid email address');
  if (pass.length < 6) throw new Error('Password must be at least 6 characters');
  if (pass.length > 72) throw new Error('Password is too long');

  const store = readStore();
  const taken = store.accounts.some(
    (a) => !a.disabled && a.email && normalizeEmail(a.email) === normalizedEmail,
  );
  if (taken) throw new Error('An account with this email already exists. Please sign in.');

  const account = makeAccount('demo', 'Self signup', normalizedEmail, {
    password: pass,
    selfRegistered: true,
  });
  store.accounts.unshift(account);
  pushActivity(store, {
    type: 'account_signup',
    accountId: account.id,
    email: account.email,
    username: account.username,
    plan: account.plan,
  });
  writeStore(store);
  return publicAccount(account, { includePassword: false });
}

function createAccounts(plan, count = 1, note = '', email = '', customerName = '', password = '', paid = false) {
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const normalizedEmail = normalizeEmail(email);
  const name = String(customerName || note || '').trim().slice(0, 80);
  const customPassword = String(password || '').trim().slice(0, 64);
  const isPaid = !!paid;
  if (normalizedEmail && !isValidEmail(normalizedEmail)) {
    throw new Error('Invalid email address');
  }
  if (normalizedEmail) {
    const storeCheck = readStore();
    const taken = storeCheck.accounts.some(
      (a) => !a.disabled && normalizeEmail(a.email) === normalizedEmail,
    );
    if (taken) throw new Error('An active account already uses this email');
  }

  const store = readStore();
  const created = [];
  for (let i = 0; i < n; i++) {
    // Optional email; leave blank to create upgrade codes (username + password)
    // Optional password; leave blank to auto-generate (same password when count > 1)
    const account = makeAccount(plan, name, normalizedEmail && n === 1 ? normalizedEmail : '', {
      customerName: name,
      paid: isPaid,
      ...(customPassword ? { password: customPassword } : {}),
    });
    store.accounts.unshift(account);
    created.push(account);
    pushActivity(store, {
      type: 'account_created',
      accountId: account.id,
      email: account.email || null,
      username: account.username,
      plan: account.plan,
      customerName: account.customerName || null,
      note: account.note,
    });
  }
  writeStore(store);
  return created.map(publicAccount);
}

/**
 * Logged-in user enters a sold plan username/password to upgrade from demo.
 */
function claimPlanCode(currentAccountId, username, password) {
  const store = readStore();
  const current = store.accounts.find((a) => a.id === currentAccountId);
  if (!current) throw new Error('Sign in first to upgrade your plan');

  const codeUser = String(username || '').trim().toUpperCase();
  const codePass = String(password || '').trim();
  if (!codeUser || !codePass) throw new Error('Plan username and password required');

  const voucher = store.accounts.find((a) => {
    if (String(a.username).toUpperCase() !== codeUser) return false;
    if (a.selfRegistered) return false;
    return passwordsMatch(codePass, a);
  });
  if (!voucher) throw new Error('Invalid plan username or password');
  if (voucher.id === current.id) throw new Error('Enter the plan code from support, not your login');
  if (voucher.disabled || voucher.claimedBy) {
    throw new Error('This plan code was already used');
  }
  if (voucher.plan === 'demo') {
    throw new Error('Use a day, 3-day, week, or month plan code to upgrade');
  }
  if (!isAccountUsable(voucher)) {
    throw new Error('This plan code is expired or disabled');
  }

  const meta = planMeta(voucher.plan);
  if (!meta) throw new Error('Invalid plan');

  const now = Date.now();
  current.plan = voucher.plan;
  current.firstLoginAt = new Date(now).toISOString();
  current.expiresAt = new Date(now + meta.durationMs).toISOString();
  current.note = [current.note, `Upgraded with ${voucher.username}`].filter(Boolean).join(' · ').slice(0, 120);

  voucher.disabled = true;
  voucher.disabledAt = nowIso();
  voucher.disabledReason = `Claimed by ${current.email || current.username}`;
  voucher.claimedBy = current.id;
  voucher.claimedAt = nowIso();
  store.sessions = store.sessions.filter((s) => s.accountId !== voucher.id);

  pushActivity(store, {
    type: 'plan_claimed',
    accountId: current.id,
    email: current.email || null,
    username: current.username,
    plan: current.plan,
    voucherUsername: voucher.username,
    voucherId: voucher.id,
  });
  writeStore(store);
  return publicAccount(current, { includePassword: false });
}

function setAccountEmail(id, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) throw new Error('Invalid email address');
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  const taken = store.accounts.some(
    (a) => a.id !== id && !a.disabled && normalizeEmail(a.email) === normalizedEmail,
  );
  if (taken) throw new Error('An active account already uses this email');
  account.email = normalizedEmail;
  pushActivity(store, {
    type: 'account_email_set',
    accountId: account.id,
    email: account.email,
    username: account.username,
  });
  writeStore(store);
  return publicAccount(account);
}

function setAccountCustomerName(id, customerName = '') {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  const name = String(customerName || '').trim().slice(0, 80);
  account.customerName = name;
  account.note = name;
  pushActivity(store, {
    type: 'account_customer_name_set',
    accountId: account.id,
    username: account.username,
    customerName: name || null,
  });
  writeStore(store);
  return publicAccount(account);
}

function setAccountPaid(id, paid = false) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.paid = !!paid;
  pushActivity(store, {
    type: 'account_paid_set',
    accountId: account.id,
    username: account.username,
    paid: account.paid,
  });
  writeStore(store);
  return publicAccount(account);
}

function disableAccount(id, reason = 'Disabled by admin') {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.disabled = true;
  account.disabledAt = nowIso();
  account.disabledReason = String(reason || 'Disabled by admin').slice(0, 120);
  store.sessions = store.sessions.filter((s) => s.accountId !== id);
  pushActivity(store, {
    type: 'account_disabled',
    accountId: account.id,
    username: account.username,
    reason: account.disabledReason,
  });
  writeStore(store);
  return publicAccount(account);
}

function enableAccount(id) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return null;
  account.disabled = false;
  account.disabledAt = null;
  account.disabledReason = null;
  pushActivity(store, {
    type: 'account_enabled',
    accountId: account.id,
    username: account.username,
  });
  writeStore(store);
  return publicAccount(account);
}

function regenerateAccount(id) {
  const store = readStore();
  const idx = store.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const old = store.accounts[idx];
  old.disabled = true;
  old.disabledAt = nowIso();
  old.disabledReason = 'Replaced with new credentials';
  store.sessions = store.sessions.filter((s) => s.accountId !== id);

  const next = makeAccount(old.plan, old.customerName || old.note, old.email || '', {
    selfRegistered: !!old.selfRegistered,
    customerName: old.customerName || old.note || '',
    paid: !!old.paid,
  });
  store.accounts.splice(idx, 0, next);
  pushActivity(store, {
    type: 'account_regenerated',
    accountId: next.id,
    email: next.email || null,
    username: next.username,
    replacedId: old.id,
    plan: next.plan,
  });
  writeStore(store);
  return { old: publicAccount(old), next: publicAccount(next) };
}

function forceLogoutAccount(id) {
  const store = readStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.accountId !== id);
  const removed = before - store.sessions.length;
  const account = store.accounts.find((a) => a.id === id);
  if (account) {
    pushActivity(store, {
      type: 'force_logout',
      accountId: account.id,
      username: account.username,
      sessionsEnded: removed,
    });
  }
  writeStore(store);
  return { removed };
}

function pruneExpiredSessions(store) {
  const now = Date.now();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
  return before !== store.sessions.length;
}

function createSession(accountId) {
  const store = readStore();
  pruneExpiredSessions(store);
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    token,
    accountId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  store.sessions.unshift(session);
  writeStore(store);
  return session;
}

function getSession(token) {
  if (!token) return null;
  const store = readStore();
  pruneExpiredSessions(store);
  const session = store.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const account = store.accounts.find((a) => a.id === session.accountId);
  if (!account || !isAccountUsable(account)) return null;
  return { session, account };
}

function destroySession(token) {
  const store = readStore();
  store.sessions = store.sessions.filter((s) => s.token !== token);
  writeStore(store);
}

function recordLogin(accountId, geo) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) return null;

  const meta = planMeta(account.plan);
  const now = Date.now();
  if (!account.firstLoginAt) {
    account.firstLoginAt = new Date(now).toISOString();
    if (meta?.startOnFirstLogin && !account.expiresAt) {
      account.expiresAt = new Date(now + meta.durationMs).toISOString();
    }
  }
  account.lastLoginAt = new Date(now).toISOString();
  account.loginCount = (account.loginCount || 0) + 1;
  account.lastIp = geo?.ip || account.lastIp || null;
  account.lastCountry = geo?.country || account.lastCountry || null;
  account.lastCity = geo?.city || account.lastCity || null;
  account.lastRegion = geo?.region || account.lastRegion || null;

  const log = {
    at: nowIso(),
    event: 'login',
    ip: geo?.ip || null,
    country: geo?.country || null,
    city: geo?.city || null,
    region: geo?.region || null,
  };
  account.usageLogs = [log, ...(account.usageLogs || [])].slice(0, MAX_LOGS_PER_ACCOUNT);

  pushActivity(store, {
    type: 'login',
    accountId: account.id,
    username: account.username,
    plan: account.plan,
    ip: log.ip,
    country: log.country,
    city: log.city,
  });

  writeStore(store);
  return account;
}

function listAccounts() {
  const store = readStore();
  return store.accounts.map(publicAccount);
}

function getSummary() {
  const accounts = listAccounts();
  const byPlan = { demo: 0, day: 0, days3: 0, week: 0, month: 0 };
  const byStatus = { active: 0, ready: 0, expired: 0, disabled: 0 };
  for (const a of accounts) {
    if (byPlan[a.plan] != null) byPlan[a.plan] += 1;
    if (byStatus[a.status] != null) byStatus[a.status] += 1;
  }
  const store = readStore();
  pruneExpiredSessions(store);
  return {
    total: accounts.length,
    activeSessions: store.sessions.length,
    byPlan,
    byStatus,
    recentActivity: store.activity.slice(0, 40),
  };
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || req.socket?.remoteAddress || req.ip || '';
  return raw.replace(/^::ffff:/, '') || null;
}

const geoCache = new Map();

async function lookupGeo(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return { ip, country: 'Local', city: 'Local network', region: null };
  }
  if (geoCache.has(ip)) return geoCache.get(ip);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,query`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    const result = data?.status === 'success'
      ? {
          ip: data.query || ip,
          country: data.country || null,
          city: data.city || null,
          region: data.regionName || null,
        }
      : { ip, country: null, city: null, region: null };
    geoCache.set(ip, result);
    return result;
  } catch {
    const fallback = { ip, country: null, city: null, region: null };
    geoCache.set(ip, fallback);
    return fallback;
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function getAccessTokenFromReq(req) {
  const cookies = parseCookies(req);
  return cookies[ACCESS_COOKIE] || null;
}

function accessCookieOptions(maxAgeMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

function formatSetCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearAccessCookieHeader() {
  return formatSetCookie(ACCESS_COOKIE, '', { ...accessCookieOptions(0), maxAge: 0 });
}

function setAccessCookieHeader(token) {
  return formatSetCookie(ACCESS_COOKIE, token, accessCookieOptions());
}

function isAccessGateEnabled() {
  if (process.env.ACCESS_BYPASS === '1' || process.env.ACCESS_BYPASS === 'true') return false;
  return true;
}

module.exports = {
  ACCESS_COOKIE,
  ACCESS_COOKIE_NAME: ACCESS_COOKIE,
  ACCESS_SESSION_TTL_MS: SESSION_TTL_MS,
  PLAN_META,
  isAccessGateEnabled,
  createAccounts,
  claimPlanCode,
  signupAccount,
  setAccountEmail,
  setAccountCustomerName,
  setAccountPaid,
  listAccounts,
  getSummary,
  disableAccount,
  enableAccount,
  regenerateAccount,
  forceLogoutAccount,
  findAccountByCredentials,
  findAccountById,
  isValidEmail,
  normalizeEmail,
  isAccountUsable,
  getAccountStatus,
  publicAccount,
  createSession,
  getSession,
  destroySession,
  recordLogin,
  getClientIp,
  lookupGeo,
  getAccessTokenFromReq,
  setAccessCookieHeader,
  clearAccessCookieHeader,
  createGuestDemoSession,
  formatRemaining,
  planMeta,
  GUEST_DEMO_ID,
};
