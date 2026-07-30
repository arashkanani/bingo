const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT) || 3002;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, path.join(__dirname, "..", "data")]
    .filter(Boolean)
    .map((dir) => path.resolve(dir));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_error) {
      // try next
    }
  }

  const fallback = path.join(__dirname, "..", "data");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const DATA_DIR = resolveDataDir();
const PUBLIC_URL = String(
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ""
).replace(/\/$/, "");
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 120;
const MAX_PHOTO_LENGTH = 220000;

/** Classic old-bingo style defaults: 4 rows × 10 cols (columns adjustable 4–10). */
const DEFAULT_CARD_ROWS = Number(process.env.CARD_ROWS) || 4;
const DEFAULT_CARD_COLS = Number(process.env.CARD_COLS) || 10;
const MIN_CARD_ROWS = 3;
const MAX_CARD_ROWS = 6;
const MIN_CARD_COLS = 4;
const MAX_CARD_COLS = 10;

module.exports = {
  PORT,
  NODE_ENV,
  IS_PRODUCTION,
  DATA_DIR,
  PUBLIC_URL,
  MAX_PLAYERS,
  MAX_PHOTO_LENGTH,
  DEFAULT_CARD_ROWS,
  DEFAULT_CARD_COLS,
  MIN_CARD_ROWS,
  MAX_CARD_ROWS,
  MIN_CARD_COLS,
  MAX_CARD_COLS
};
