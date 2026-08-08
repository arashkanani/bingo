/**
 * Shared auth helpers for account.html and host.html
 */
(function authClient(global) {
  function safeNextUrl(raw) {
    const next = String(raw || "").trim();
    if (!next || !next.startsWith("/") || next.startsWith("//")) {
      return "/";
    }
    return next;
  }

  async function apiFetch(url, options) {
    const init = { credentials: "include", ...options };
    if (options?.body && !init.headers) {
      init.headers = { "Content-Type": "application/json" };
    } else if (options?.body && init.headers && !init.headers["Content-Type"]) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (_err) {
      const err = new Error("Network error — check that the server is running and refresh.");
      err.code = "NETWORK";
      throw err;
    }
    let data = {};
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_parseErr) {
        data = { error: text.slice(0, 200) || `Request failed (${res.status}).` };
      }
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function validateEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, message: "Please enter a valid email address." };
    }
    return { ok: true, email: e };
  }

  function validatePassword(password, { minLength = 8 } = {}) {
    const p = String(password || "");
    if (p.length < minLength) {
      return { ok: false, message: `Password must be at least ${minLength} characters.` };
    }
    return { ok: true, password: p };
  }

  async function getSession() {
    const data = await apiFetch("/api/auth/me");
    return data.user || null;
  }

  async function getAuthConfig() {
    return apiFetch("/api/auth/config");
  }

  async function login(email, password) {
    return apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
  }

  async function register(email, password) {
    return apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
  }

  async function loginWithGoogle(credential) {
    return apiFetch("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential })
    });
  }

  async function logout() {
    return apiFetch("/api/auth/logout", { method: "POST" });
  }

  global.BingoAuth = {
    safeNextUrl,
    apiFetch,
    validateEmail,
    validatePassword,
    getSession,
    getAuthConfig,
    login,
    register,
    loginWithGoogle,
    logout
  };
})(typeof window !== "undefined" ? window : globalThis);
