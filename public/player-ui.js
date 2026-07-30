function countryFlagUrl(code) {
  if (!code || String(code).length !== 2) return "";
  return `/flags/${String(code).toLowerCase()}.svg`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCountryFlagImg(code, countryName) {
  const url = countryFlagUrl(code);
  if (!url) return "";
  const alt = escapeHtml(countryName || code);
  return `<img class="player-flag-img" src="${url}" alt="${alt}" width="32" height="24" loading="lazy">`;
}

function renderPlayerProfile(player) {
  const safeName = escapeHtml(player.name || "Player");
  const photoHtml = player.photo
    ? `<img class="player-avatar" src="${player.photo}" alt="">`
    : `<span class="player-avatar player-avatar-placeholder" aria-hidden="true">?</span>`;
  const flagHtml = player.countryCode
    ? renderCountryFlagImg(player.countryCode, player.countryName)
    : "";
  return `<span class="player-profile">${photoHtml}${flagHtml}<span class="player-name">${safeName}</span></span>`;
}

function renderLeaderboardItem(player, index, unitLabel) {
  const rank = index + 1;
  let rankClass = "";
  if (index === 0) rankClass = "rank-first";
  else if (index === 1) rankClass = "rank-second";
  else if (index === 2) rankClass = "rank-third";

  const badgeContent =
    index === 0
      ? '<span class="rank-medal" aria-hidden="true">🥇</span>'
      : index === 1
        ? '<span class="rank-medal" aria-hidden="true">🥈</span>'
        : index === 2
          ? '<span class="rank-medal" aria-hidden="true">🥉</span>'
          : `<span class="rank-num">${rank}</span>`;

  const unit = unitLabel || "rows";

  return `
    <div class="leaderboard-row ${rankClass}">
      <div class="rank-badge">${badgeContent}</div>
      <div class="rank-player">${renderPlayerProfile(player)}</div>
      <div class="rank-score">
        <span class="rank-score-num">${player.score}</span>
        <span class="rank-score-unit">${escapeHtml(unit)}</span>
      </div>
    </div>
  `;
}

let gameAudioContext = null;
let wheelSoundStyle = "classic";

function getGameAudioContext() {
  if (!gameAudioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    gameAudioContext = new AudioCtx();
  }
  return gameAudioContext;
}

function primeGameAudio() {
  const ctx = getGameAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
}

function setWheelSoundStyle(style) {
  const allowed = ["classic", "casino", "soft", "dramatic", "off"];
  wheelSoundStyle = allowed.includes(style) ? style : "classic";
  try {
    localStorage.setItem("bingo_wheel_sound", wheelSoundStyle);
  } catch (_err) {
    /* ignore */
  }
}

function getWheelSoundStyle() {
  try {
    const saved = localStorage.getItem("bingo_wheel_sound");
    if (saved) setWheelSoundStyle(saved);
  } catch (_err) {
    /* ignore */
  }
  return wheelSoundStyle;
}

function toneAt(ctx, freq, start, duration, volume, type) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playDrawSpinSound(style, durationMs) {
  try {
    const pack = style || getWheelSoundStyle();
    if (pack === "off") return;
    const ctx = getGameAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const dur = Math.max(1.5, (durationMs || 4800) / 1000);

    if (pack === "casino") {
      let t = 0;
      let gap = 0.055;
      while (t < dur - 0.25) {
        toneAt(ctx, 900 + Math.random() * 200, now + t, 0.035, 0.07, "square");
        toneAt(ctx, 180, now + t, 0.04, 0.03, "triangle");
        t += gap;
        gap = Math.min(0.28, gap * 1.065);
      }
      return;
    }

    if (pack === "soft") {
      let t = 0;
      let gap = 0.12;
      const notes = [523.25, 587.33, 659.25, 698.46, 783.99];
      let i = 0;
      while (t < dur - 0.3) {
        toneAt(ctx, notes[i % notes.length], now + t, 0.12, 0.06, "sine");
        i += 1;
        t += gap;
        gap = Math.min(0.32, gap * 1.05);
      }
      return;
    }

    if (pack === "dramatic") {
      const rumble = ctx.createOscillator();
      const rumbleGain = ctx.createGain();
      rumble.type = "sawtooth";
      rumble.frequency.value = 55;
      rumbleGain.gain.setValueAtTime(0.0001, now);
      rumbleGain.gain.exponentialRampToValueAtTime(0.05, now + 0.2);
      rumbleGain.gain.linearRampToValueAtTime(0.03, now + dur - 0.4);
      rumbleGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      rumble.connect(rumbleGain);
      rumbleGain.connect(ctx.destination);
      rumble.start(now);
      rumble.stop(now + dur + 0.05);

      let t = 0;
      let gap = 0.07;
      while (t < dur - 0.2) {
        toneAt(ctx, 140 + t * 40, now + t, 0.05, 0.08, "triangle");
        t += gap;
        gap = Math.min(0.25, gap * 1.06);
      }
      return;
    }

    for (let i = 0; i < 12; i += 1) {
      toneAt(
        ctx,
        180 + i * 40 + Math.random() * 30,
        now + i * 0.05,
        0.06,
        0.05,
        "square"
      );
    }
  } catch (_err) {
    /* ignore */
  }
}

function playNumberRevealSound(style) {
  try {
    const pack = style || getWheelSoundStyle();
    if (pack === "off") return;
    const ctx = getGameAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;

    if (pack === "casino") {
      toneAt(ctx, 880, now, 0.12, 0.16, "square");
      toneAt(ctx, 1174.7, now + 0.1, 0.18, 0.14, "square");
      toneAt(ctx, 1318.5, now + 0.22, 0.35, 0.12, "triangle");
      return;
    }

    if (pack === "soft") {
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        toneAt(ctx, freq, now + i * 0.1, 0.4, 0.1, "sine");
      });
      return;
    }

    if (pack === "dramatic") {
      [196, 246.94, 311.13, 392, 523.25].forEach((freq, i) => {
        toneAt(ctx, freq, now + i * 0.08, 0.35, 0.14, "sawtooth");
        toneAt(ctx, freq * 2, now + i * 0.08, 0.25, 0.05, "sine");
      });
      return;
    }

    const notes = [392, 523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      toneAt(ctx, freq, now + i * 0.07, 0.35, 0.18, "triangle");
    });
  } catch (_err) {
    /* ignore */
  }
}

function playChampionSound() {
  try {
    const ctx = getGameAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const melody = [
      { freq: 523.25, at: 0, dur: 0.14 },
      { freq: 659.25, at: 0.11, dur: 0.14 },
      { freq: 783.99, at: 0.22, dur: 0.14 },
      { freq: 1046.5, at: 0.33, dur: 0.5 }
    ];
    for (const note of melody) {
      toneAt(ctx, note.freq, now + note.at, note.dur, 0.22, "triangle");
    }
  } catch (_err) {
    /* ignore */
  }
}

getWheelSoundStyle();

