/**
 * Smoke test: two host sessions get different room codes and join URLs.
 * Run with server already listening on PORT (default 3002).
 */
const http = require("http");

const PORT = Number(process.env.PORT || 3002);
const BASE = `http://127.0.0.1:${PORT}`;

function request(path, { method = "GET", cookie = "", body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const setCookie = res.headers["set-cookie"] || [];
          resolve({ status: res.statusCode, text, setCookie, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(setCookie) {
  return setCookie.map((c) => String(c).split(";")[0]).join("; ");
}

async function hostSession() {
  const home = await request("/");
  const cookie = cookieFrom(home.setCookie);
  if (!cookie) throw new Error("No access cookie from /");
  const info = await request("/api/join-info", { cookie });
  const data = JSON.parse(info.text);
  if (!data.room) throw new Error("join-info missing room");
  if (!String(data.primaryPlayerUrl || "").includes(`room=${data.room}`)) {
    throw new Error(`primaryPlayerUrl missing room: ${data.primaryPlayerUrl}`);
  }
  return { cookie, room: data.room, url: data.primaryPlayerUrl };
}

(async () => {
  const a = await hostSession();
  const b = await hostSession();
  if (a.room === b.room) {
    throw new Error(`Rooms collided: both got ${a.room}`);
  }
  if (a.cookie === b.cookie) {
    throw new Error("Host sessions shared the same cookie");
  }
  console.log("OK: room A", a.room, a.url);
  console.log("OK: room B", b.room, b.url);
  console.log("Smoke passed: isolated host rooms");
})().catch((err) => {
  console.error("Smoke failed:", err.message);
  process.exit(1);
});
