const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { IS_PRODUCTION } = require("./config");
const userStore = require("./user-store");

const COOKIE_NAME = "bingo_auth";
const BCRYPT_ROUNDS = 10;
const JWT_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function getJwtSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    return fromEnv;
  }
  if (IS_PRODUCTION) {
    throw new Error("SESSION_SECRET env var is required in production (min 16 characters).");
  }
  return `dev-insecure-${crypto.randomBytes(8).toString("hex")}`;
}

let cachedSecret = null;
function jwtSecret() {
  if (!cachedSecret) {
    cachedSecret = getJwtSecret();
  }
  return cachedSecret;
}

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function signUserToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: userStore.isAdminEmail(user.email) ? "admin" : "user"
  };
  return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_TTL_SEC });
}

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, jwtSecret());
  } catch (_error) {
    return null;
  }
}

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    maxAge: JWT_TTL_SEC * 1000,
    path: "/"
  };
}

function attachUserMiddleware() {
  return (req, _res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    const decoded = verifyToken(token);
    req.user = null;
    if (decoded && decoded.sub) {
      req.user = userStore.publicUser(userStore.findUserById(decoded.sub)) || null;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/", secure: IS_PRODUCTION, sameSite: "lax" });
}

function setAuthSession(res, user) {
  const token = signUserToken(user);
  res.cookie(COOKIE_NAME, token, authCookieOptions());
  return userStore.publicUser(user);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  signUserToken,
  verifyToken,
  authCookieOptions,
  clearAuthCookie,
  setAuthSession,
  attachUserMiddleware,
  requireAuth,
  requireAdmin
};
