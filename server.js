require("dotenv").config();

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const {
  PORT,
  IS_PRODUCTION,
  PUBLIC_URL,
  MAX_PLAYERS,
  MAX_PHOTO_LENGTH,
  DEFAULT_CARD_ROWS,
  DEFAULT_CARD_COLS,
  MIN_CARD_ROWS,
  MAX_CARD_ROWS,
  MIN_CARD_COLS,
  MAX_CARD_COLS
} = require("./lib/config");
const authLib = require("./lib/auth");
const userStore = require("./lib/user-store");
const accessStore = require("./lib/access-store");
const googleAuth = require("./lib/google-auth");
const { attachSocketAuthMiddleware } = require("./lib/socket-auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  cors: { origin: false }
});

attachSocketAuthMiddleware(io);

const DEMO_SUSPEND_MESSAGE =
  "Demo access is temporarily paused while a real game is running. Please try again later.";

function appendAudit({ userId, email, req, type, meta }) {
  userStore.appendActivity({
    userId: userId ?? req?.user?.id ?? null,
    email: email ? userStore.normalizeEmail(email) : req?.user?.email ?? null,
    type: String(type || "unknown"),
    meta: meta && typeof meta === "object" ? meta : {}
  });
}

function accessCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    maxAge: accessStore.ACCESS_SESSION_TTL_MS,
    path: "/"
  };
}

function toDashboardAccess(sessionBundle) {
  if (!sessionBundle?.account) return null;
  const pub = accessStore.publicAccount(sessionBundle.account);
  return {
    token: sessionBundle.session.token,
    code: pub,
    account: pub,
    expiresAt: sessionBundle.session.expiresAt
  };
}

app.use(compression());
app.use(express.json({ limit: "300kb" }));
app.use(cookieParser());
app.use(authLib.attachUserMiddleware());
app.use((req, _res, next) => {
  const token = req.cookies?.[accessStore.ACCESS_COOKIE];
  req.dashboardAccess = toDashboardAccess(accessStore.getSession(token));
  next();
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

const flagIconsDir = path.join(__dirname, "node_modules", "flag-icons", "flags", "4x3");
app.use("/flags", express.static(flagIconsDir));

const countriesPath = path.join(publicDir, "countries.json");
const countriesRaw = JSON.parse(fs.readFileSync(countriesPath, "utf8"));
const countriesByCode = new Map();
const allowedCountryCodes = new Set();
for (const entry of countriesRaw) {
  const code = String(entry.code || entry.cca2 || "").toUpperCase();
  const name = String(entry.name || entry.name?.common || "").trim();
  if (code.length === 2 && name && code !== "IL") {
    countriesByCode.set(code, name);
    allowedCountryCodes.add(code);
  }
}

const BINGO_LETTERS = ["B", "I", "N", "G", "O"];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeCardSize(rows, cols) {
  return {
    rows: clamp(Number(rows) || DEFAULT_CARD_ROWS, MIN_CARD_ROWS, MAX_CARD_ROWS),
    cols: clamp(Number(cols) || DEFAULT_CARD_COLS, MIN_CARD_COLS, MAX_CARD_COLS)
  };
}

/** Number pool size for a card width (classic 9 → 1–90). */
function maxNumberForCols(cols) {
  if (cols === 9) return 90;
  return cols * 10;
}

/** Decade ranges per column, classic bingo style. */
function columnRange(col, cols) {
  const maxNum = maxNumberForCols(cols);
  if (cols === 9) {
    if (col === 0) return [1, 9];
    if (col === 8) return [80, 90];
    return [col * 10, col * 10 + 9];
  }
  const size = Math.floor(maxNum / cols);
  const min = col * size + 1;
  const max = col === cols - 1 ? maxNum : (col + 1) * size;
  return [min, max];
}

/**
 * Classic old bingo ticket: rows × cols with random empty cells.
 * ~half the cells filled (5 numbers per row on a 9-wide card).
 */
function generateBingoCard(rows, cols) {
  const size = normalizeCardSize(rows, cols);
  const grid = Array.from({ length: size.rows }, () =>
    Array.from({ length: size.cols }, () => null)
  );

  // Classic density: 5 numbers / 4 blanks on 9 cols → scale for other widths.
  const numbersPerRow = clamp(Math.round(size.cols * (5 / 9)), 3, size.cols - 1);
  const usedByCol = Array.from({ length: size.cols }, () => new Set());

  for (let r = 0; r < size.rows; r += 1) {
    const colOrder = shuffle([...Array(size.cols).keys()]);
    const chosenCols = colOrder.slice(0, numbersPerRow).sort((a, b) => a - b);

    for (const c of chosenCols) {
      const [min, max] = columnRange(c, size.cols);
      const pool = [];
      for (let n = min; n <= max; n += 1) {
        if (!usedByCol[c].has(n)) pool.push(n);
      }
      if (!pool.length) continue;
      const num = pool[Math.floor(Math.random() * pool.length)];
      grid[r][c] = num;
      usedByCol[c].add(num);
    }
  }

  return grid;
}

function letterForNumber(n, cols) {
  const c = cols || game.cardCols || DEFAULT_CARD_COLS;
  for (let i = 0; i < c; i += 1) {
    const [min, max] = columnRange(i, c);
    if (n >= min && n <= max) {
      if (c === 5) return BINGO_LETTERS[i] || String(i + 1);
      return String(i + 1);
    }
  }
  return "·";
}

function countCompletedRows(card, marked) {
  let completed = 0;
  for (const row of card) {
    const numbers = row.filter((v) => v != null);
    if (!numbers.length) continue;
    if (numbers.every((n) => marked.has(n))) completed += 1;
  }
  return completed;
}

/** Most marked numbers in any single row (race to first line). */
function bestRowMarkedCount(card, marked) {
  let best = 0;
  for (const row of card) {
    const numbers = row.filter((v) => v != null);
    if (!numbers.length) continue;
    const filled = numbers.filter((n) => marked.has(n)).length;
    if (filled > best) best = filled;
  }
  return best;
}

/** Total marked numbers on the whole card. */
function totalMarkedOnCard(card, marked) {
  let total = 0;
  for (const row of card) {
    for (const value of row) {
      if (value != null && marked.has(value)) total += 1;
    }
  }
  return total;
}

function computePlayerScore(player) {
  if (!player?.card) return 0;
  if (game.firstBingoAchieved) {
    return totalMarkedOnCard(player.card, player.marked);
  }
  return bestRowMarkedCount(player.card, player.marked);
}

function refreshAllPlayerScores() {
  for (const player of players.values()) {
    player.completedRows = player.card
      ? countCompletedRows(player.card, player.marked)
      : 0;
    player.score = computePlayerScore(player);
  }
}

function rankingUnit() {
  return game.firstBingoAchieved ? "cells" : "in row";
}

function normalizeEventTitle(value) {
  const title = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return title;
}

function createNewGame(settings = {}) {
  const size = normalizeCardSize(
    settings.cardRows ?? DEFAULT_CARD_ROWS,
    settings.cardCols ?? DEFAULT_CARD_COLS
  );
  const maxNum = maxNumberForCols(size.cols);
  const winRows = clamp(
    Number(settings.winRows) || size.rows,
    1,
    size.rows
  );

  return {
    started: false,
    ended: false,
    eventTitle: normalizeEventTitle(settings.eventTitle),
    cardRows: size.rows,
    cardCols: size.cols,
    maxNumber: maxNum,
    winRows,
    maxDrawNumbers: settings.maxDrawNumbers || null,
    planTier: settings.planTier || "demo",
    firstBingoAchieved: false,
    firstBingoPlayerId: null,
    calledNumbers: [],
    remainingNumbers: shuffle(Array.from({ length: maxNum }, (_, i) => i + 1)),
    currentNumber: null,
    currentLetter: null,
    drawSequence: 0,
    autoDraw: false,
    autoDrawMs: 12000,
    autoDrawTimer: null
  };
}

const players = new Map();
const socketToPlayerId = new Map();
let game = createNewGame();
let dashboardCodeId = null;
let activeGameCodeId = null;

function currentDashboardCode() {
  const id = activeGameCodeId || dashboardCodeId;
  if (!id) return null;
  const account = accessStore.findAccountById(id);
  return account ? accessStore.publicAccount(account) : null;
}

function isPaidGameRunning() {
  const code = currentDashboardCode();
  const paid = code && code.plan && code.plan !== "demo";
  return Boolean(game.started && !game.ended && paid);
}

function effectiveMaxPlayers() {
  const code = currentDashboardCode();
  if (!code?.maxPlayers) return MAX_PLAYERS;
  return Math.min(MAX_PLAYERS, Number(code.maxPlayers) || MAX_PLAYERS);
}

function getPublicBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.get("host") || `localhost:${PORT}`;
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) result.push(net.address);
    }
  }
  return result;
}

function normalizePhoto(photo) {
  const value = String(photo || "");
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)) return null;
  if (value.length > MAX_PHOTO_LENGTH) return null;
  return value;
}

function findPlayerByToken(token) {
  if (!token) return null;
  for (const player of players.values()) {
    if (player.token === token) return player;
  }
  return null;
}

function bindSocketToPlayer(socket, player) {
  if (player.socketId && player.socketId !== socket.id) {
    socketToPlayerId.delete(player.socketId);
  }
  player.socketId = socket.id;
  socketToPlayerId.set(socket.id, player.id);
  socket.data.playerId = player.id;
}

function toLeaderboardEntry(player, { includePhoto = false } = {}) {
  const entry = {
    id: player.id,
    name: player.name,
    score: player.score,
    completedRows: player.completedRows || 0,
    countryCode: player.countryCode,
    countryName: player.countryName,
    markedCount: player.marked ? player.marked.size : 0
  };
  if (includePhoto) entry.photo = player.photo;
  return entry;
}

function getLeaderboard({ includePhoto = false } = {}) {
  return [...players.values()]
    .map((p) => toLeaderboardEntry(p, { includePhoto }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.completedRows || 0) !== (a.completedRows || 0)) {
        return (b.completedRows || 0) - (a.completedRows || 0);
      }
      if (b.markedCount !== a.markedCount) return b.markedCount - a.markedCount;
      return a.name.localeCompare(b.name);
    });
}

function buildGameStatePayload() {
  const registrationOpen = !game.started || game.ended;
  return {
    started: game.started,
    ended: game.ended,
    cardRows: game.cardRows,
    cardCols: game.cardCols,
    maxNumber: game.maxNumber,
    calledNumbers: game.calledNumbers,
    currentNumber: game.currentNumber,
    currentLetter: game.currentLetter,
    drawSequence: game.drawSequence,
    remainingCount: game.remainingNumbers.length,
    autoDraw: game.autoDraw,
    autoDrawMs: game.autoDrawMs,
    winRows: game.winRows,
    maxDrawNumbers: game.maxDrawNumbers || null,
    planDrawsLeft: drawsRemainingInPlan(),
    planTier: game.planTier || null,
    firstBingoAchieved: !!game.firstBingoAchieved,
    rankingPhase: game.firstBingoAchieved ? "grid" : "row",
    rankingUnit: rankingUnit(),
    firstLevelChampion: (() => {
      if (!game.firstBingoPlayerId) return null;
      const champ = players.get(game.firstBingoPlayerId);
      return champ ? toLeaderboardEntry(champ, { includePhoto: true }) : null;
    })(),
    playerCount: players.size,
    registrationOpen,
    playerCap: effectiveMaxPlayers(),
    eventTitle: game.eventTitle || "",
    settings: {
      cardRows: game.cardRows,
      cardCols: game.cardCols,
      winRows: game.winRows,
      eventTitle: game.eventTitle || "",
      minRows: MIN_CARD_ROWS,
      maxRows: MAX_CARD_ROWS,
      minCols: MIN_CARD_COLS,
      maxCols: MAX_CARD_COLS,
      defaultRows: DEFAULT_CARD_ROWS,
      defaultCols: DEFAULT_CARD_COLS
    },
    leaderboard: getLeaderboard({ includePhoto: game.ended })
  };
}

function emitGameState() {
  io.emit("gameState", buildGameStatePayload());
}

function emitPlayerJoined(player) {
  io.emit("playerJoined", toLeaderboardEntry(player, { includePhoto: true }));
}

function clearAutoDraw() {
  if (game.autoDrawTimer) {
    clearTimeout(game.autoDrawTimer);
    game.autoDrawTimer = null;
  }
}

function scheduleAutoDraw() {
  clearAutoDraw();
  if (!game.autoDraw || !game.started || game.ended) return;
  game.autoDrawTimer = setTimeout(() => {
    drawNextNumber();
  }, game.autoDrawMs);
}

function finishGame(reason) {
  if (game.ended) return;
  game.ended = true;
  game.autoDraw = false;
  clearAutoDraw();
  activeGameCodeId = null;
  const leaderboard = getLeaderboard({ includePhoto: true });
  io.emit("gameOver", { leaderboard, reason: reason || "ended" });
  emitGameState();
}

function drawsRemainingInPlan() {
  if (!game.maxDrawNumbers) return null;
  return Math.max(0, Number(game.maxDrawNumbers) - game.calledNumbers.length);
}

function drawNextNumber() {
  if (!game.started || game.ended) return null;
  if (!game.remainingNumbers.length) {
    finishGame("all_numbers");
    return null;
  }
  if (game.maxDrawNumbers && game.calledNumbers.length >= game.maxDrawNumbers) {
    clearAutoDraw();
    io.emit("drawLimitReached", {
      maxDrawNumbers: game.maxDrawNumbers,
      planTier: game.planTier || "demo",
      message:
        "Demo limit reached (15 numbers). Upgrade your plan to spin the full game."
    });
    emitGameState();
    return null;
  }

  const number = game.remainingNumbers.shift();
  const letter = letterForNumber(number, game.cardCols);
  game.currentNumber = number;
  game.currentLetter = letter;
  game.calledNumbers.push(number);
  game.drawSequence += 1;

  const planDrawsLeft = drawsRemainingInPlan();
  io.emit("numberDrawn", {
    number,
    letter,
    drawSequence: game.drawSequence,
    calledNumbers: game.calledNumbers,
    remainingCount: game.remainingNumbers.length,
    planDrawsLeft
  });
  emitGameState();

  if (game.maxDrawNumbers && game.calledNumbers.length >= game.maxDrawNumbers) {
    clearAutoDraw();
    io.emit("drawLimitReached", {
      maxDrawNumbers: game.maxDrawNumbers,
      planTier: game.planTier || "demo",
      message:
        "Demo limit reached (15 numbers). Upgrade your plan to spin the full game."
    });
  } else {
    scheduleAutoDraw();
  }
  return number;
}

function resetLobby() {
  clearAutoDraw();
  const keptTitle = game.eventTitle;
  for (const player of players.values()) {
    if (player.socketId) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) sock.emit("sessionReset");
    }
  }
  players.clear();
  socketToPlayerId.clear();
  game = createNewGame({ eventTitle: keptTitle });
  io.emit("lobbyCleared");
  emitGameState();
}

function startGame({
  autoDraw = false,
  autoDrawMs,
  cardRows,
  cardCols,
  winRows,
  eventTitle,
  maxDrawNumbers = null,
  planTier = "demo"
} = {}) {
  clearAutoDraw();
  const title =
    eventTitle !== undefined ? normalizeEventTitle(eventTitle) : game.eventTitle;
  game = createNewGame({
    cardRows,
    cardCols,
    winRows,
    eventTitle: title,
    maxDrawNumbers,
    planTier
  });
  game.started = true;
  if (autoDrawMs) game.autoDrawMs = Math.max(10000, Number(autoDrawMs) || 10000);
  game.autoDraw = !!autoDraw;

  for (const player of players.values()) {
    player.card = generateBingoCard(game.cardRows, game.cardCols);
    player.marked = new Set();
    player.completedRows = 0;
    player.score = 0;
  }

  emitGameState();

  for (const player of players.values()) {
    if (!player.socketId) continue;
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit("cardDealt", {
        card: player.card,
        marked: [...player.marked],
        cardRows: game.cardRows,
        cardCols: game.cardCols
      });
    }
  }

  // First number after a short beat so phones can show cards.
  setTimeout(() => drawNextNumber(), 1800);
}

app.get("/dashboard-access", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard-access.html"));
});

app.get("/account", (_req, res) => {
  res.sendFile(path.join(publicDir, "account.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/", (req, res) => {
  // Open on free demo by default (15-number spin limit).
  if (!req.dashboardAccess) {
    const session = accessStore.createGuestDemoSession();
    if (session?.token) {
      res.cookie(accessStore.ACCESS_COOKIE, session.token, accessCookieOptions());
      dashboardCodeId = session.account?.id || accessStore.GUEST_DEMO_ID;
    }
  }
  res.sendFile(path.join(publicDir, "host.html"));
});

app.get("/mobile", (_req, res) => {
  res.sendFile(path.join(publicDir, "mobile.html"));
});

app.get("/api/auth/config", (_req, res) => {
  res.json({ googleClientId: googleAuth.getGoogleClientId() });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = userStore.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email) {
      res.status(400).json({ error: "Email is required." });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }
    const passwordHash = await authLib.hashPassword(password);
    const user = userStore.createUser({ email, passwordHash });
    appendAudit({ userId: user.id, email: user.email, type: "auth.register", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.status(201).json({ user: publicUser });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not register." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = userStore.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const user = userStore.findUserByEmail(email);
    if (!user?.passwordHash) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    const okPass = await authLib.verifyPassword(password, user.passwordHash);
    if (!okPass) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    appendAudit({ userId: user.id, email: user.email, type: "auth.login", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.json({ user: publicUser });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not sign in." });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const profile = await googleAuth.verifyGoogleIdToken(req.body?.credential);
    const user = userStore.findOrCreateGoogleUser({
      googleId: profile.googleId,
      email: profile.email
    });
    appendAudit({ userId: user.id, email: user.email, type: "auth.login_google", meta: {} });
    const publicUser = authLib.setAuthSession(res, user);
    res.json({ user: publicUser });
  } catch (error) {
    const status = /not configured/i.test(error.message) ? 503 : 400;
    res.status(status).json({ error: error.message || "Google sign-in failed." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  appendAudit({ req, type: "auth.logout", meta: {} });
  authLib.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user || null });
});

app.get("/api/access/debug-hint", (_req, res) => {
  res.json({ username: "GUEST-DEMO", password: "GUEST-DEMO", note: "Free demo opens automatically" });
});

app.get("/api/access/me", (req, res) => {
  if (!req.dashboardAccess?.code) {
    res.json({ access: null, paidGameRunning: isPaidGameRunning() });
    return;
  }
  res.json({
    access: req.dashboardAccess.code,
    paidGameRunning: isPaidGameRunning()
  });
});

app.post("/api/access/login", async (req, res) => {
  const username = String(req.body?.username || req.body?.email || "").trim();
  const password = String(req.body?.password || "").trim();
  const account = accessStore.findAccountByCredentials(username, password);
  if (!account || account.disabled) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  if (!accessStore.isAccountUsable(account)) {
    res.status(403).json({ error: "This plan is expired or disabled." });
    return;
  }
  if (account.plan === "demo" && !account.guest && isPaidGameRunning()) {
    res.status(403).json({ error: DEMO_SUSPEND_MESSAGE, reason: "demo_suspended" });
    return;
  }
  const geo = await accessStore.lookupGeo(accessStore.getClientIp(req));
  accessStore.recordLogin(account.id, geo);
  const session = accessStore.createSession(account.id);
  if (!session) {
    res.status(400).json({ error: "Could not create dashboard session." });
    return;
  }
  dashboardCodeId = account.id;
  res.cookie(accessStore.ACCESS_COOKIE, session.token, accessCookieOptions());
  res.json({ access: accessStore.publicAccount(account) });
});

app.post("/api/access/logout", (req, res) => {
  const token = req.cookies?.[accessStore.ACCESS_COOKIE];
  accessStore.destroySession(token);
  res.clearCookie(accessStore.ACCESS_COOKIE, {
    path: "/",
    secure: IS_PRODUCTION,
    sameSite: "lax"
  });
  res.json({ ok: true });
});

app.get("/api/admin/summary", authLib.requireAdmin, (_req, res) => {
  res.json(userStore.getAdminSummary());
});

app.get("/api/admin/users", authLib.requireAdmin, (_req, res) => {
  res.json({ users: userStore.listUsersPublic() });
});

app.get("/api/admin/mobile-players", authLib.requireAdmin, (_req, res) => {
  res.json({ players: userStore.listMobilePlayersAdmin() });
});

app.get("/api/admin/activity", authLib.requireAdmin, (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const offset = Number(req.query.offset) || 0;
  res.json(userStore.listActivity({ limit, offset }));
});

app.get("/api/admin/access/summary", authLib.requireAdmin, (_req, res) => {
  res.json(accessStore.getSummary());
});

app.get("/api/admin/access/accounts", authLib.requireAdmin, (_req, res) => {
  res.json({ accounts: accessStore.listAccounts() });
});

app.post("/api/admin/access/accounts", authLib.requireAdmin, (req, res) => {
  try {
    const accounts = accessStore.createAccounts(
      req.body?.plan,
      req.body?.count,
      req.body?.note,
      req.body?.email,
      req.body?.customerName,
      req.body?.password,
      req.body?.paid
    );
    appendAudit({
      req,
      type: "access.accounts_created",
      meta: { count: accounts.length, plan: req.body?.plan || null }
    });
    res.json({ accounts });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not create accounts." });
  }
});

app.post("/api/admin/access/accounts/:id/email", authLib.requireAdmin, (req, res) => {
  try {
    const account = accessStore.setAccountEmail(req.params.id, req.body?.email);
    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ account });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not save email." });
  }
});

app.post("/api/admin/access/accounts/:id/customer-name", authLib.requireAdmin, (req, res) => {
  try {
    const account = accessStore.setAccountCustomerName(req.params.id, req.body?.customerName);
    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ account });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not save customer name." });
  }
});

app.post("/api/admin/access/accounts/:id/paid", authLib.requireAdmin, (req, res) => {
  try {
    const account = accessStore.setAccountPaid(req.params.id, req.body?.paid);
    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ account });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not save paid status." });
  }
});

app.post("/api/admin/access/accounts/:id/disable", authLib.requireAdmin, (req, res) => {
  const account = accessStore.disableAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  if (dashboardCodeId === req.params.id) dashboardCodeId = null;
  if (activeGameCodeId === req.params.id) {
    activeGameCodeId = null;
    if (game.started && !game.ended) finishGame("admin");
  }
  res.json({ account });
});

app.post("/api/admin/access/accounts/:id/enable", authLib.requireAdmin, (req, res) => {
  const account = accessStore.enableAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json({ account });
});

app.post("/api/admin/access/accounts/:id/regenerate", authLib.requireAdmin, (req, res) => {
  const result = accessStore.regenerateAccount(req.params.id);
  if (!result) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  if (dashboardCodeId === req.params.id) dashboardCodeId = null;
  res.json(result);
});

app.post("/api/admin/access/accounts/:id/logout", authLib.requireAdmin, (req, res) => {
  const result = accessStore.forceLogoutAccount(req.params.id);
  if (dashboardCodeId === req.params.id) dashboardCodeId = null;
  res.json({ ok: true, clearedSessions: result.removed || 0 });
});

app.get("/api/countries", (_req, res) => {
  const countries = [...countriesByCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(countries);
});

app.get("/api/join-info", (req, res) => {
  const base = getPublicBaseUrl(req);
  const localPlayerUrl = `${base}/mobile`;
  const lanAddresses = getLanAddresses();
  const lanUrls = lanAddresses.map((address) => `http://${address}:${PORT}/mobile`);

  // Phones cannot open localhost — prefer a LAN IP for the QR code.
  const primaryPlayerUrl =
    PUBLIC_URL
      ? `${PUBLIC_URL}/mobile`
      : lanUrls[0] || localPlayerUrl;

  const playerUrls = PUBLIC_URL
    ? [primaryPlayerUrl, ...lanUrls.filter((u) => u !== primaryPlayerUrl)]
    : [...lanUrls, localPlayerUrl].filter((url, i, arr) => arr.indexOf(url) === i);

  res.json({
    port: PORT,
    playerUrls,
    primaryPlayerUrl,
    lanUrls,
    hostUrl: `${base}/`,
    isProduction: IS_PRODUCTION
  });
});

app.get("/api/qr", async (req, res, next) => {
  try {
    const text = String(req.query.url || "");
    if (!/^https?:\/\//i.test(text)) {
      res.status(400).send("Invalid url");
      return;
    }
    const png = await QRCode.toBuffer(text, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320
    });
    res.type("image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  socket.emit("gameState", buildGameStatePayload());
  const lobbyPlayers = [...players.values()].map((player) =>
    toLeaderboardEntry(player, { includePhoto: true })
  );
  if (lobbyPlayers.length) {
    socket.emit("lobbySnapshot", { players: lobbyPlayers });
  }

  const existingId = socketToPlayerId.get(socket.id);
  if (existingId) {
    const player = players.get(existingId);
    if (player?.card) {
      socket.emit("cardDealt", {
        card: player.card,
        marked: [...player.marked],
        cardRows: game.cardRows,
        cardCols: game.cardCols
      });
    }
  }

  socket.on("joinPlayer", (payload) => {
    const playerToken = String(payload?.playerToken || "").trim();
    const rawName = String(payload?.name || "").trim();
    const existing = findPlayerByToken(playerToken);
    const registrationOpen = !game.started || game.ended;

    if (!registrationOpen && !existing) {
      socket.emit("joinError", {
        message: "Game in progress — registration is closed. Wait for the next game."
      });
      return;
    }

    if (playerToken && !existing && !rawName) {
      socket.emit("joinError", { message: "Session expired. Please register again." });
      return;
    }

    if (existing) {
      if (existing.socketId) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          oldSocket.disconnect(true);
        }
      }
      bindSocketToPlayer(socket, existing);
      socket.emit("joined", {
        id: existing.id,
        token: existing.token,
        name: existing.name,
        countryCode: existing.countryCode,
        countryName: existing.countryName,
        photo: existing.photo,
        score: existing.score
      });
      if (game.started && existing.card) {
        socket.emit("cardDealt", {
          card: existing.card,
          marked: [...existing.marked],
          cardRows: game.cardRows,
          cardCols: game.cardCols
        });
      }
      emitGameState();
      return;
    }

    const cap = effectiveMaxPlayers();
    if (players.size >= cap) {
      socket.emit("joinError", {
        message: `Game is full (${cap} players max).`
      });
      return;
    }

    const name = rawName.slice(0, 20);
    const countryCode = String(payload?.countryCode || "").toUpperCase();
    const photo = normalizePhoto(payload?.photo);

    if (!name) {
      socket.emit("joinError", { message: "Name is required." });
      return;
    }
    if (!countryCode || !allowedCountryCodes.has(countryCode)) {
      socket.emit("joinError", { message: "Please choose a valid country." });
      return;
    }
    if (!photo) {
      socket.emit("joinError", { message: "Please take or upload a photo." });
      return;
    }

    const countryName = countriesByCode.get(countryCode);
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      socketId: null,
      name,
      score: 0,
      photo,
      countryCode,
      countryName,
      card: null,
      marked: new Set()
    };
    players.set(player.id, player);
    bindSocketToPlayer(socket, player);
    socket.emit("joined", {
      id: player.id,
      token: player.token,
      name,
      countryCode,
      countryName,
      photo,
      score: 0
    });
    emitPlayerJoined(player);
    emitGameState();
  });

  socket.on("markNumber", (payload) => {
    const playerId = socketToPlayerId.get(socket.id);
    const player = playerId ? players.get(playerId) : null;
    if (!player || !game.started || game.ended) {
      socket.emit("markResult", { ok: false, message: "Cannot mark now." });
      return;
    }

    const number = Number(payload?.number);
    if (!Number.isInteger(number) || number < 1 || number > game.maxNumber) {
      socket.emit("markResult", { ok: false, message: "Invalid number." });
      return;
    }

    if (!game.calledNumbers.includes(number)) {
      socket.emit("markResult", { ok: false, message: "Not that one — try again." });
      return;
    }

    if (!player.card) {
      socket.emit("markResult", { ok: false, message: "No card yet." });
      return;
    }

    const onCard = player.card.some((row) => row.includes(number));
    if (!onCard) {
      socket.emit("markResult", { ok: false, message: "Not that one — try again." });
      return;
    }

    if (player.marked.has(number)) {
      socket.emit("markResult", { ok: true, already: true, score: player.score, marked: [...player.marked] });
      return;
    }

    player.marked.add(number);
    player.completedRows = countCompletedRows(player.card, player.marked);

    let phaseChanged = false;
    if (!game.firstBingoAchieved && player.completedRows >= 1) {
      game.firstBingoAchieved = true;
      game.firstBingoPlayerId = player.id;
      phaseChanged = true;
      refreshAllPlayerScores();
      const champEntry = toLeaderboardEntry(player, { includePhoto: true });
      io.emit("rankingPhase", {
        phase: "grid",
        rankingUnit: rankingUnit(),
        firstBingoPlayer: champEntry,
        firstLevelChampion: champEntry
      });
      io.emit("firstLevelChampion", { player: champEntry });
    } else {
      player.score = computePlayerScore(player);
    }

    socket.emit("markResult", {
      ok: true,
      number,
      score: player.score,
      completedRows: player.completedRows,
      rankingPhase: game.firstBingoAchieved ? "grid" : "row",
      rankingUnit: rankingUnit(),
      marked: [...player.marked]
    });

    io.emit("playerMarked", {
      number,
      player: toLeaderboardEntry(player, { includePhoto: true }),
      drawSequence: game.drawSequence,
      rankingPhase: game.firstBingoAchieved ? "grid" : "row",
      rankingUnit: rankingUnit(),
      phaseChanged
    });

    emitGameState();

    // First line crowns "first level" only — final champion needs winRows after that (or host end)
    if (!phaseChanged && player.completedRows >= game.winRows) {
      finishGame("champion");
    }
  });

  socket.on("hostStartGame", (payload) => {
    const accessCode = socket.data.accessSession?.code || currentDashboardCode();
    if (!accessCode) {
      socket.emit("hostError", {
        message: "Dashboard access required. Sign in with your plan username and password."
      });
      return;
    }
    if (accessCode.disabled) {
      socket.emit("hostError", { message: "This access code is disabled. Contact admin for a new code." });
      return;
    }
    const plan = accessCode.plan || accessCode.tier || "demo";
    if (plan === "demo" && !accessCode.guest && isPaidGameRunning()) {
      socket.emit("hostError", { message: DEMO_SUSPEND_MESSAGE });
      return;
    }
    const liveAccount = accessStore.findAccountById(accessCode.id);
    if (!liveAccount || !accessStore.isAccountUsable(liveAccount)) {
      socket.emit("hostError", { message: "This plan is expired or disabled." });
      return;
    }
    if (players.size < 1) {
      socket.emit("hostError", { message: "Need at least one player to start." });
      return;
    }
    if (players.size > accessCode.maxPlayers) {
      socket.emit("hostError", {
        message: `This ${plan} plan allows up to ${accessCode.maxPlayers} players. Current lobby has ${players.size}.`
      });
      return;
    }
    if (game.started && !game.ended) {
      socket.emit("hostError", { message: "Game already in progress." });
      return;
    }

    dashboardCodeId = accessCode.id;
    activeGameCodeId = accessCode.id;
    const eventTitle =
      normalizeEventTitle(payload?.eventTitle) || game.eventTitle || "Bingo";
    const authUser = socket.data.authUser || null;
    userStore.recordGameStarted({
      hostUserId: authUser?.id || null,
      hostEmail: authUser?.email || null,
      eventTitle,
      players: [...players.values()].map((player) => ({
        name: player.name,
        countryCode: player.countryCode
      }))
    });

    const maxDrawNumbers = Number(accessCode.rounds) > 0 ? Number(accessCode.rounds) : null;
    startGame({
      autoDraw: !!payload?.autoDraw,
      autoDrawMs: payload?.autoDrawMs,
      cardRows: payload?.cardRows,
      cardCols: payload?.cardCols,
      winRows: payload?.winRows,
      eventTitle,
      maxDrawNumbers,
      planTier: plan
    });
  });

  socket.on("hostUpdateSettings", (payload) => {
    if (game.started && !game.ended) {
      socket.emit("hostError", { message: "Settings are locked while a game is running." });
      return;
    }
    const size = normalizeCardSize(payload?.cardRows, payload?.cardCols);
    const winRows = clamp(Number(payload?.winRows) || size.rows, 1, size.rows);
    if (!game.started || game.ended) {
      game.cardRows = size.rows;
      game.cardCols = size.cols;
      game.maxNumber = maxNumberForCols(size.cols);
      game.winRows = winRows;
      if (payload && Object.prototype.hasOwnProperty.call(payload, "eventTitle")) {
        game.eventTitle = normalizeEventTitle(payload.eventTitle);
      }
      game.remainingNumbers = shuffle(
        Array.from({ length: game.maxNumber }, (_, i) => i + 1)
      );
      emitGameState();
    }
  });

  socket.on("hostDrawNumber", () => {
    if (!game.started || game.ended) {
      socket.emit("hostError", { message: "Start the game first." });
      return;
    }
    drawNextNumber();
  });

  socket.on("hostToggleAutoDraw", (payload) => {
    if (!game.started || game.ended) return;
    game.autoDraw = !!payload?.autoDraw;
    if (payload?.autoDrawMs) {
      game.autoDrawMs = Math.max(10000, Number(payload.autoDrawMs) || game.autoDrawMs);
    }
    if (game.autoDraw) scheduleAutoDraw();
    else clearAutoDraw();
    emitGameState();
  });

  socket.on("hostEndGame", () => {
    if (!game.started || game.ended) return;
    finishGame("host");
  });

  socket.on("hostResetGame", () => {
    resetLobby();
  });

  socket.on("disconnect", () => {
    const playerId = socketToPlayerId.get(socket.id);
    socketToPlayerId.delete(socket.id);
    if (!playerId) return;
    const player = players.get(playerId);
    if (!player) return;
    if (player.socketId === socket.id) player.socketId = null;

    // Drop from lobby only before the game starts.
    if (!game.started || game.ended) {
      players.delete(playerId);
      io.emit("playerLeft", { id: playerId });
      emitGameState();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddresses()[0];
  console.log(`Bingo host screen: http://localhost:${PORT}/`);
  console.log(
    lan
      ? `Bingo phone join (QR): http://${lan}:${PORT}/mobile`
      : `Bingo mobile join: http://localhost:${PORT}/mobile`
  );
  console.log(`Plan access login: http://localhost:${PORT}/dashboard-access`);
  console.log(`Admin account: http://localhost:${PORT}/account → /admin`);
  console.log(`Local debug plan code: username 123 / password 123`);

  const bootstrapEmail = process.env.ADMIN_BOOTSTRAP_EMAIL;
  const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const bootstrapReset = String(process.env.ADMIN_BOOTSTRAP_RESET || "").toLowerCase() === "true";
  if (bootstrapEmail && bootstrapPassword) {
    userStore
      .bootstrapAdminAccount({
        email: bootstrapEmail,
        password: bootstrapPassword,
        authLib,
        forceReset: bootstrapReset
      })
      .then((result) => {
        const email = userStore.normalizeEmail(bootstrapEmail);
        if (result.created) console.log(`Admin bootstrap OK: created ${email}`);
        else if (result.reset) console.log(`Admin bootstrap OK: password reset for ${email}`);
        else if (result.reason === "exists") {
          console.log(`Admin bootstrap: ${email} already exists`);
        } else if (result.reason === "not_admin_email") {
          console.warn(`Admin bootstrap skipped: ${email} not in ADMIN_EMAILS`);
        }
      })
      .catch((err) => console.warn("Admin bootstrap failed:", err.message));
  }
});
