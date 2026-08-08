const authLib = require("./auth");
const userStore = require("./user-store");

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch (_error) {
      out[key] = value;
    }
  }
  return out;
}

function attachSocketAuthMiddleware(io) {
  io.use((socket, next) => {
    try {
      const cookies = parseCookieHeader(socket.handshake.headers.cookie);
      const token = cookies[authLib.COOKIE_NAME];
      const decoded = authLib.verifyToken(token);
      if (decoded?.sub) {
        const user = userStore.findUserById(decoded.sub);
        if (user) {
          socket.data.authUser = userStore.publicUser(user);
        }
      }
      const accessToken = cookies[userStore.ACCESS_COOKIE_NAME];
      const accessSession = userStore.getAccessSession(accessToken);
      if (accessSession?.code) {
        socket.data.accessSession = accessSession;
      }
    } catch (_error) {
      // Allow anonymous host/mobile connections.
    }
    next();
  });
}

module.exports = {
  attachSocketAuthMiddleware
};
