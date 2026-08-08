const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./config");

const STORE_PATH = path.join(DATA_DIR, "users-db.json");
const MAX_ACTIVITY = 3000;
const MAX_GAME_NAMES_PER_RECORD = 40;
const ACCESS_SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const ACCESS_COOKIE_NAME = "bingo_access";
const DEBUG_DEMO_CODE_ID = "00000000-0000-4000-8000-000000000001";
const DEBUG_DEMO_USERNAME = "123";
const DEBUG_DEMO_PASSWORD = "123";
const WEEKLY_ACCESS_CODE_COUNT = 5;
const WEEKLY_ACCESS_TTL_MS = 1000 * 60 * 60 * 24 * 7;

let cache = null;

function defaultStore() {
  return { users: [], mobilePlayers: [], activity: [], accessCodes: [], accessSessions: [] };
}

function readStore() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!Array.isArray(parsed.mobilePlayers)) parsed.mobilePlayers = [];
    if (!Array.isArray(parsed.activity)) parsed.activity = [];
    if (!Array.isArray(parsed.accessCodes)) parsed.accessCodes = [];
    if (!Array.isArray(parsed.accessSessions)) parsed.accessSessions = [];
    cache = parsed;
    ensureDebugDemoCode(cache);
    ensureAccessCodePools(cache);
    return cache;
  } catch (_error) {
    cache = defaultStore();
    ensureDebugDemoCode(cache);
    ensureAccessCodePools(cache);
    writeStore(cache);
    return cache;
  }
}

function writeStore(data) {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0), "utf8");
  fs.renameSync(tmp, STORE_PATH);
  cache = data;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(len = 12) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len).toUpperCase();
}

function normalizePlayerName(name) {
  return String(name || "").trim().toLowerCase().slice(0, 40);
}

function adminEmailSet() {
  const raw = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function accessTemplate(tier) {
  if (tier === "demo") {
    return { rounds: 5, maxPlayers: 5, usesLimit: 3 };
  }
  if (tier === "weekly") {
    return { rounds: 20, maxPlayers: 150, usesLimit: null, expiresAfterMs: WEEKLY_ACCESS_TTL_MS };
  }
  return { rounds: 20, maxPlayers: 150, usesLimit: 7 };
}

function makeAccessCode(tier) {
  const base = accessTemplate(tier);
  const tag = tier === "demo" ? "DEMO" : tier === "weekly" ? "WEEK" : "REAL";
  return {
    id: crypto.randomUUID(),
    tier,
    username: `${tag}-${randomToken(6)}`,
    password: randomToken(10),
    rounds: base.rounds,
    maxPlayers: base.maxPlayers,
    usesLimit: base.usesLimit,
    usesCount: 0,
    disabled: false,
    disabledAt: null,
    disabledReason: null,
    expiresAt: base.expiresAfterMs ? new Date(Date.now() + base.expiresAfterMs).toISOString() : null,
    createdAt: nowIso(),
    usageLogs: []
  };
}

function isAccessCodeExpired(code, now = Date.now()) {
  return Boolean(code?.expiresAt && Date.parse(code.expiresAt) <= now);
}

function hasAccessCodeUsesRemaining(code) {
  if (!code) return false;
  if (code.usesLimit == null) return true;
  return Number(code.usesCount || 0) < Number(code.usesLimit || 0);
}

function makeDebugDemoCode() {
  const base = accessTemplate("real");
  return {
    id: DEBUG_DEMO_CODE_ID,
    tier: "real",
    username: DEBUG_DEMO_USERNAME,
    password: DEBUG_DEMO_PASSWORD,
    rounds: base.rounds,
    maxPlayers: base.maxPlayers,
    usesLimit: 99999,
    usesCount: 0,
    disabled: false,
    disabledAt: null,
    disabledReason: null,
    expiresAt: null,
    createdAt: nowIso(),
    usageLogs: []
  };
}

function ensureDebugDemoCode(store) {
  const base = accessTemplate("real");
  let code = store.accessCodes.find((c) => c.id === DEBUG_DEMO_CODE_ID);
  let changed = false;

  if (!code) {
    store.accessCodes.unshift(makeDebugDemoCode());
    writeStore(store);
    return true;
  }

  if (code.tier !== "real") {
    code.tier = "real";
    changed = true;
  }
  if (code.username !== DEBUG_DEMO_USERNAME) {
    code.username = DEBUG_DEMO_USERNAME;
    changed = true;
  }
  if (code.password !== DEBUG_DEMO_PASSWORD) {
    code.password = DEBUG_DEMO_PASSWORD;
    changed = true;
  }
  if (code.disabled) {
    code.disabled = false;
    code.disabledAt = null;
    code.disabledReason = null;
    changed = true;
  }
  if (code.rounds !== base.rounds) {
    code.rounds = base.rounds;
    changed = true;
  }
  if (code.maxPlayers !== base.maxPlayers) {
    code.maxPlayers = base.maxPlayers;
    changed = true;
  }
  if ((code.usesLimit || 0) < 99999) {
    code.usesLimit = 99999;
    changed = true;
  }
  if (code.expiresAt) {
    code.expiresAt = null;
    changed = true;
  }
  if ((code.usesCount || 0) >= (code.usesLimit || 0)) {
    code.usesCount = 0;
    changed = true;
  }

  const idx = store.accessCodes.indexOf(code);
  if (idx > 0) {
    store.accessCodes.splice(idx, 1);
    store.accessCodes.unshift(code);
    changed = true;
  }

  if (changed) {
    writeStore(store);
  }
  return changed;
}

function getDebugAccessHint() {
  return { username: "123", password: "123" };
}

function ensureAccessCodePools(store) {
  const activeDemo = store.accessCodes.filter((c) => c.tier === "demo" && !c.disabled).length;
  const activeReal = store.accessCodes.filter((c) => c.tier === "real" && !c.disabled).length;
  for (let i = activeDemo; i < 10; i += 1) {
    store.accessCodes.push(makeAccessCode("demo"));
  }
  for (let i = activeReal; i < 10; i += 1) {
    store.accessCodes.push(makeAccessCode("real"));
  }
}

function ensureWeeklyAccessCodes(count = WEEKLY_ACCESS_CODE_COUNT) {
  const store = readStore();
  const now = Date.now();
  const activeWeekly = store.accessCodes.filter(
    (c) => c.tier === "weekly" && !c.disabled && !isAccessCodeExpired(c, now)
  );
  const needed = Math.max(0, Math.min(20, Number(count) || WEEKLY_ACCESS_CODE_COUNT) - activeWeekly.length);
  const created = [];

  for (let i = 0; i < needed; i += 1) {
    const code = makeAccessCode("weekly");
    store.accessCodes.push(code);
    created.push(code);
  }

  if (created.length) {
    writeStore(store);
  }

  return {
    created: created.map(sanitizeCode),
    weeklyCodes: store.accessCodes
      .filter((c) => c.tier === "weekly" && !c.disabled && !isAccessCodeExpired(c, now))
      .map(sanitizeCode)
  };
}

function sanitizeCode(code) {
  const unlimitedUses = code.usesLimit == null;
  return {
    id: code.id,
    tier: code.tier,
    username: code.username,
    password: code.password,
    rounds: code.rounds,
    maxPlayers: code.maxPlayers,
    usesLimit: code.usesLimit,
    usesCount: code.usesCount,
    usesRemaining: unlimitedUses ? null : Math.max(0, (code.usesLimit || 0) - (code.usesCount || 0)),
    unlimitedUses,
    disabled: !!code.disabled,
    disabledAt: code.disabledAt || null,
    disabledReason: code.disabledReason || null,
    expiresAt: code.expiresAt || null,
    expired: isAccessCodeExpired(code),
    createdAt: code.createdAt,
    usageLogs: Array.isArray(code.usageLogs) ? [...code.usageLogs] : []
  };
}

function listAccessCodes() {
  ensureWeeklyAccessCodes(WEEKLY_ACCESS_CODE_COUNT);
  return readStore()
    .accessCodes
    .slice()
    .sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      if (isAccessCodeExpired(a) !== isAccessCodeExpired(b)) return isAccessCodeExpired(a) ? 1 : -1;
      if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
      return a.username < b.username ? -1 : 1;
    })
    .map(sanitizeCode);
}

function findAccessCodeByCredentials(username, password) {
  const u = String(username || "").trim().toUpperCase();
  const p = String(password || "").trim().toUpperCase();
  if (!u || !p) return null;
  const store = readStore();
  return store.accessCodes.find((c) => c.username === u && c.password === p) || null;
}

function getCodeById(id) {
  if (!id) return null;
  return readStore().accessCodes.find((c) => c.id === id) || null;
}

function disableAndRegenerateAccessCode(id, reason = "disabled_by_admin") {
  const store = readStore();
  const code = store.accessCodes.find((c) => c.id === id);
  if (!code) throw new Error("Access code not found.");
  if (!code.disabled) {
    code.disabled = true;
    code.disabledAt = nowIso();
    code.disabledReason = reason;
  }
  const replacement = makeAccessCode(code.tier);
  store.accessCodes.push(replacement);
  writeStore(store);
  return { disabled: sanitizeCode(code), replacement: sanitizeCode(replacement) };
}

function createAccessSession(codeId) {
  const store = readStore();
  const code = store.accessCodes.find((c) => c.id === codeId);
  if (!code || code.disabled || isAccessCodeExpired(code) || !hasAccessCodeUsesRemaining(code)) return null;
  const token = crypto.randomUUID();
  const now = Date.now();
  store.accessSessions = (store.accessSessions || []).filter((s) => (s.expiresAt || 0) > now);
  store.accessSessions.push({
    token,
    codeId: code.id,
    createdAt: now,
    expiresAt: now + ACCESS_SESSION_TTL_MS
  });
  writeStore(store);
  return { token, code: sanitizeCode(code), expiresAt: now + ACCESS_SESSION_TTL_MS };
}

function getAccessSession(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const store = readStore();
  const now = Date.now();
  const session = store.accessSessions.find((s) => s.token === t && (s.expiresAt || 0) > now);
  if (!session) return null;
  const code = store.accessCodes.find((c) => c.id === session.codeId);
  if (!code || code.disabled || isAccessCodeExpired(code, now)) return null;
  return {
    token: session.token,
    code: sanitizeCode(code),
    expiresAt: session.expiresAt
  };
}

function clearAccessSession(token) {
  const t = String(token || "").trim();
  if (!t) return;
  const store = readStore();
  const before = store.accessSessions.length;
  store.accessSessions = store.accessSessions.filter((s) => s.token !== t);
  if (store.accessSessions.length !== before) {
    writeStore(store);
  }
}

function clearAccessSessionsByCodeId(codeId) {
  const id = String(codeId || "").trim();
  if (!id) return 0;
  const store = readStore();
  const before = store.accessSessions.length;
  store.accessSessions = store.accessSessions.filter((s) => s.codeId !== id);
  const removed = before - store.accessSessions.length;
  if (removed > 0) {
    writeStore(store);
  }
  return removed;
}

function consumeAccessCodeUse(codeId, details) {
  const store = readStore();
  const code = store.accessCodes.find((c) => c.id === codeId);
  if (!code || code.disabled || isAccessCodeExpired(code) || !hasAccessCodeUsesRemaining(code)) return null;
  code.usesCount = Number(code.usesCount || 0) + 1;
  if (!Array.isArray(code.usageLogs)) code.usageLogs = [];
  code.usageLogs.unshift({
    at: nowIso(),
    playerCount: Number(details?.playerCount || 0),
    eventTitle: String(details?.eventTitle || "").slice(0, 80) || "Untitled game"
  });
  code.usageLogs = code.usageLogs.slice(0, 30);
  writeStore(store);
  return sanitizeCode(code);
}

function getActiveCodeStats() {
  ensureWeeklyAccessCodes(WEEKLY_ACCESS_CODE_COUNT);
  const store = readStore();
  const active = store.accessCodes.filter((c) => !c.disabled && !isAccessCodeExpired(c));
  return {
    demo: active.filter((c) => c.tier === "demo").length,
    real: active.filter((c) => c.tier === "real").length,
    weekly: active.filter((c) => c.tier === "weekly").length
  };
}

function isAdminEmail(email) {
  const e = normalizeEmail(email);
  return e && adminEmailSet().has(e);
}

function ensureUserStats(user) {
  if (!user.stats || typeof user.stats !== "object") {
    user.stats = { gamesPlayed: 0, gameNames: [] };
  }
  if (!Array.isArray(user.stats.gameNames)) {
    user.stats.gameNames = [];
  }
  if (typeof user.stats.gamesPlayed !== "number") {
    user.stats.gamesPlayed = 0;
  }
  return user.stats;
}

function pushGameName(list, title) {
  const name = String(title || "").trim().slice(0, 80) || "Untitled game";
  const next = [name, ...list.filter((entry) => entry !== name)];
  return next.slice(0, MAX_GAME_NAMES_PER_RECORD);
}

function publicUser(user) {
  if (!user) return null;
  const providers = [];
  if (user.passwordHash) providers.push("password");
  if (user.googleId) providers.push("google");
  const stats = ensureUserStats(user);
  return {
    id: user.id,
    email: user.email,
    role: isAdminEmail(user.email) ? "admin" : "user",
    createdAt: user.createdAt,
    providers,
    gamesPlayed: stats.gamesPlayed,
    gameNames: [...stats.gameNames]
  };
}

function findUserByEmail(email) {
  const e = normalizeEmail(email);
  return readStore().users.find((u) => u.email === e) || null;
}

function findUserById(id) {
  return readStore().users.find((u) => u.id === id) || null;
}

function findUserByGoogleId(googleId) {
  const gid = String(googleId || "").trim();
  if (!gid) return null;
  return readStore().users.find((u) => u.googleId === gid) || null;
}

function createUser({ email, passwordHash }) {
  const e = normalizeEmail(email);
  if (!e.includes("@") || e.length > 120) {
    throw new Error("Please use a valid email address.");
  }
  const store = readStore();
  const existing = store.users.find((u) => u.email === e);
  if (existing) {
    if (existing.googleId && !existing.passwordHash) {
      throw new Error("This email uses Google sign-in. Use Continue with Google.");
    }
    throw new Error("An account already exists for this email.");
  }
  const user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash,
    googleId: null,
    createdAt: new Date().toISOString(),
    stats: { gamesPlayed: 0, gameNames: [] }
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function findOrCreateGoogleUser({ googleId, email }) {
  const gid = String(googleId || "").trim();
  const e = normalizeEmail(email);
  if (!gid) throw new Error("Invalid Google account.");
  if (!e.includes("@")) throw new Error("Please use a valid email address.");

  const store = readStore();
  let user = store.users.find((u) => u.googleId === gid) || store.users.find((u) => u.email === e);

  if (user) {
    if (user.googleId && user.googleId !== gid) {
      throw new Error("This email is linked to a different Google account.");
    }
    if (!user.googleId) {
      user.googleId = gid;
      writeStore(store);
    }
    ensureUserStats(user);
    return user;
  }

  user = {
    id: crypto.randomUUID(),
    email: e,
    passwordHash: null,
    googleId: gid,
    createdAt: new Date().toISOString(),
    stats: { gamesPlayed: 0, gameNames: [] }
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function appendActivity(entry) {
  const store = readStore();
  store.activity.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userId: entry.userId || null,
    email: entry.email ? normalizeEmail(entry.email) : null,
    type: String(entry.type || "unknown"),
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {}
  });
  if (store.activity.length > MAX_ACTIVITY) {
    store.activity = store.activity.slice(-MAX_ACTIVITY);
  }
  writeStore(store);
}

function listActivity({ limit = 100, offset = 0 } = {}) {
  const store = readStore();
  const slice = [...store.activity].reverse();
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return {
    total: store.activity.length,
    items: slice.slice(off, off + lim)
  };
}

function recordMobilePlayerSession({ displayName, countryCode, eventTitle }) {
  const name = String(displayName || "").trim().slice(0, 20);
  if (!name) return;
  const nameKey = normalizePlayerName(name);
  const store = readStore();
  let row = store.mobilePlayers.find((p) => p.nameKey === nameKey);
  const now = new Date().toISOString();
  const title = String(eventTitle || "").trim().slice(0, 80) || "Untitled game";

  if (!row) {
    row = {
      id: crypto.randomUUID(),
      nameKey,
      displayName: name,
      countryCode: countryCode || null,
      gamesPlayed: 0,
      gameNames: [],
      firstSeenAt: now,
      lastPlayedAt: now
    };
    store.mobilePlayers.push(row);
  }

  row.displayName = name;
  if (countryCode) row.countryCode = countryCode;
  row.gamesPlayed += 1;
  row.gameNames = pushGameName(row.gameNames, title);
  row.lastPlayedAt = now;
  writeStore(store);
}

function recordGameStarted({ hostUserId, hostEmail, eventTitle, players }) {
  const store = readStore();
  const title = String(eventTitle || "").trim().slice(0, 80) || "Untitled game";
  const now = new Date().toISOString();
  let changed = false;

  if (hostUserId) {
    const host = store.users.find((u) => u.id === hostUserId);
    if (host) {
      const stats = ensureUserStats(host);
      stats.gamesPlayed += 1;
      stats.gameNames = pushGameName(stats.gameNames, title);
      stats.lastPlayedAt = now;
      changed = true;
    }
  }

  for (const player of players || []) {
    recordMobilePlayerSession({
      displayName: player.name,
      countryCode: player.countryCode,
      eventTitle: title
    });
  }

  if (changed) {
    writeStore(store);
  }

  appendActivity({
    userId: hostUserId || null,
    email: hostEmail || null,
    type: "game.started",
    meta: {
      eventTitle: title,
      playerCount: (players || []).length,
      hostSignedIn: Boolean(hostUserId)
    }
  });
}

function listUsersPublic() {
  return readStore()
    .users.map((u) => publicUser(u))
    .sort((a, b) => (a.email < b.email ? -1 : 1));
}

function listMobilePlayersAdmin() {
  return readStore()
    .mobilePlayers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      countryCode: p.countryCode,
      gamesPlayed: p.gamesPlayed || 0,
      gameNames: [...(p.gameNames || [])],
      firstSeenAt: p.firstSeenAt,
      lastPlayedAt: p.lastPlayedAt
    }))
    .sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0));
}

function getAdminSummary() {
  const store = readStore();
  const accountGames = store.users.reduce(
    (sum, u) => sum + (ensureUserStats(u).gamesPlayed || 0),
    0
  );
  const mobileGames = store.mobilePlayers.reduce(
    (sum, p) => sum + (p.gamesPlayed || 0),
    0
  );
  return {
    registeredUsers: store.users.length,
    mobilePlayers: store.mobilePlayers.length,
    accountGamesHosted: accountGames,
    mobileGameSessions: mobileGames,
    activityEntries: store.activity.length,
    accessCodes: getActiveCodeStats()
  };
}

async function bootstrapAdminAccount({ email, password, authLib, forceReset = false }) {
  const e = normalizeEmail(email);
  const pass = String(password || "");
  if (!e || !pass || pass.length < 8) return { created: false, reset: false, reason: "invalid" };
  if (!isAdminEmail(e)) return { created: false, reset: false, reason: "not_admin_email" };

  const passwordHash = await authLib.hashPassword(pass);
  const existing = findUserByEmail(e);
  if (existing) {
    if (!forceReset) {
      return { created: false, reset: false, reason: "exists" };
    }
    const store = readStore();
    const user = store.users.find((u) => u.email === e);
    if (!user) return { created: false, reset: false, reason: "exists" };
    user.passwordHash = passwordHash;
    writeStore(store);
    appendActivity({ email: e, type: "auth.password_reset", meta: { source: "bootstrap" } });
    return { created: false, reset: true, reason: "password_reset" };
  }

  createUser({ email: e, passwordHash });
  appendActivity({ email: e, type: "auth.bootstrap", meta: {} });
  return { created: true, reset: false, reason: "created" };
}

module.exports = {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_TTL_MS,
  normalizeEmail,
  normalizePlayerName,
  isAdminEmail,
  publicUser,
  findUserByEmail,
  findUserById,
  findUserByGoogleId,
  createUser,
  findOrCreateGoogleUser,
  appendActivity,
  listActivity,
  recordGameStarted,
  listUsersPublic,
  listMobilePlayersAdmin,
  getAdminSummary,
  bootstrapAdminAccount,
  listAccessCodes,
  findAccessCodeByCredentials,
  disableAndRegenerateAccessCode,
  ensureWeeklyAccessCodes,
  isAccessCodeExpired,
  hasAccessCodeUsesRemaining,
  createAccessSession,
  getAccessSession,
  clearAccessSession,
  clearAccessSessionsByCodeId,
  consumeAccessCodeUse,
  getCodeById,
  getDebugAccessHint
};
