/**
 * Locked Grid Lottery — game service (sandbox mini-service entry)
 * ---------------------------------------------------------------
 * Express (HTTP API + static overlay) + socket.io (real-time state sync)
 * + optional tiktok-live-connector (lazy-loaded) + built-in simulator.
 *
 * This copy runs as a PLATFORM MINI-SERVICE (mini-services/locked-grid):
 *   - .zscripts/dev.sh auto-starts it on every sandbox boot ("bun run dev")
 *   - the Next.js control center proxies same-origin /api/* here, so the
 *     admin UI keeps working even if this process has to be respawned.
 *
 * Routes
 *   GET  /                    OBS overlay (1080x1920)
 *   GET  /admin.html          Admin control panel
 *   GET  /api/status          health + mode + tiktok/simulator info
 *   GET  /api/state           current game state snapshot
 *   GET  /api/health          liveness probe (used by the Next.js proxy)
 *   GET  /api/admin/winners   [admin] winner history (?round=&from=&to=&limit=)
 *   POST /api/reset           [admin] flush locks, start new round
 *   POST /api/admin/claim     [admin] manually award a slot
 *   POST /api/admin/release   [admin] free a single slot
 *   POST /api/admin/sim       [admin] toggle the auto simulator
 *   POST /api/admin/draw      [admin] start the keno winner draw now
 *   POST /api/admin/ad        [admin] push an ad to the overlay (image/gif/video)
 *   POST /api/admin/ad/stop   [admin] dismiss the overlay ad now
 *   POST /api/simulate/chat   [admin*] inject a chat comment  (*open when SIMULATE=1)
 *   POST /api/simulate/gift   [admin*] inject a gift         (*open when SIMULATE=1)
 *
 * Real-time events (socket.io)
 *   state        -> full game state snapshot (sent on connect + after every change)
 *   slot-locked  -> { slot, entry, round }      (triggers overlay pulse + sound)
 *   slot-released-> { slot }
 *   round-reset  -> { previous, round }
 *   draw-started -> { round, pool, preDelayMs, rollMs, tickMs }  (keno roll begins)
 *   draw-tick    -> { round, number }           (rolling number, same for all clients)
 *   draw-result  -> { round, slot, winner, celebrateMs }         (winner + celebration)
 *   ad:show      -> { url, kind, durationMs, caption }   (overlay ad begins)
 *   ad:hide      -> {}                            (overlay ad dismissed)
 *   activity     -> ticker events (claims, rejections, gifts, joins)
 *   server       -> status info (mode, tiktok, simulator)
 */
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./src/config');
const game = require('./src/gameState');
const store = require('./src/store');
const { TikTokBridge } = require('./src/tiktok');
const { Simulator } = require('./src/simulator');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

/* ads are sent as base64 data URLs inside JSON, so allow big bodies */
app.use(express.json({ limit: `${config.AD_MAX_UPLOAD_MB + 8}mb` }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.redirect('/admin.html'));

/* ── game state ──────────────────────────────────────────────────────── */
const state = game.createGameState();
state.winnerHistory = store.loadWinners(); // survive restarts
console.log(`  [store] loaded ${state.winnerHistory.length} past winner(s) from winners.json`);
const bridge = new TikTokBridge();
const simulator = new Simulator({
  onChat: (user, comment, source) => ingestChat(user, comment, source),
  onGift: (gift, source) => ingestGift(gift, source),
});

const mode = () => (config.TIKTOK_USERNAME ? 'LIVE' : 'SIMULATION');

function serverInfo() {
  return {
    name: 'Locked Grid Lottery',
    mode: mode(),
    simulate: config.SIMULATE,
    simulator: simulator.publicInfo,
    tiktok: bridge.publicInfo,
    totalSlots: state.totalSlots,
    bootedAt: state.bootedAt,
    version: '1.2.0',
  };
}

/* ── broadcast helpers ───────────────────────────────────────────────── */
const broadcastState = () => io.emit('state', game.publicState(state, { server: serverInfo() }));
const broadcastServer = () => io.emit('server', serverInfo());

/* ── ingest pipeline (shared by TikTok bridge + simulator + admin) ───── */
function ingestChat(user, comment, source = 'tiktok') {
  const slotNumber = game.parseSlotComment(comment);

  // Not a number -> not part of the game (counts as ignored chatter)
  if (slotNumber === null) {
    if (String(comment || '').trim()) {
      const ev = game.pushEvent(state, 'chat', { user: { uniqueId: user.uniqueId, nickname: user.nickname }, comment: String(comment).slice(0, 60), source });
      io.emit('activity', ev);
    }
    return { ok: false, reason: 'NOT_A_NUMBER' };
  }

  // Draw in progress -> the round is closed; tell viewers why
  if (state.phase !== 'open') {
    state.stats.ignored += 1;
    const ev = game.pushEvent(state, 'busy', { user: { uniqueId: user.uniqueId, nickname: user.nickname }, comment: String(slotNumber), phase: state.phase, source });
    io.emit('activity', ev);
    return { ok: false, reason: 'DRAW_IN_PROGRESS', message: 'Winner is being drawn — next round starts in a moment!' };
  }

  const result = game.tryClaim(state, slotNumber, user);

  if (result.ok) {
    const ev = game.pushEvent(state, 'claim', {
      slot: result.slot,
      user: { userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl || null, _hue: user._hue || null },
      source,
      round: state.round,
    });
    io.emit('activity', ev);
    io.emit('slot-locked', { slot: result.slot, entry: result.entry, round: state.round, source });
    broadcastState();
    maybeAutoReset();
  } else if (result.reason === 'SLOT_TAKEN') {
    const ev = game.pushEvent(state, 'rejected', { slot: result.slot, user: { uniqueId: user.uniqueId, nickname: user.nickname }, reason: result.reason, source });
    io.emit('activity', ev);
  } else if (result.reason === 'USER_HAS_SLOT') {
    const ev = game.pushEvent(state, 'duplicate', { slot: result.slot, user: { uniqueId: user.uniqueId, nickname: user.nickname }, reason: result.reason, source });
    io.emit('activity', ev);
  } else if (result.reason === 'OUT_OF_RANGE') {
    const ev = game.pushEvent(state, 'invalid', { comment: String(comment).slice(0, 20), user: { uniqueId: user.uniqueId, nickname: user.nickname }, source });
    io.emit('activity', ev);
  }
  return result;
}

function ingestGift(gift, source = 'tiktok') {
  state.stats.gifts += 1;
  const ev = game.pushEvent(state, 'gift', {
    user: { uniqueId: gift.uniqueId, nickname: gift.nickname, profilePictureUrl: gift.profilePictureUrl || null, _hue: gift._hue || null },
    giftName: gift.giftName,
    repeatCount: gift.repeatCount,
    diamondCount: gift.diamondCount,
    source,
  });
  io.emit('activity', ev);
  io.emit('gift-received', ev);
  broadcastState();
  return ev;
}

/** Demo convenience: when simulating, restart the round shortly after the grid fills. */
let autoResetTimer = null;

/* ── winner draw (keno) engine ───────────────────────────────────────── */
const drawTimers = { ticks: null, rollEnd: null, preDelay: null, reset: null };

function clearDrawTimers() {
  for (const k of Object.keys(drawTimers)) {
    if (drawTimers[k]) { clearTimeout(drawTimers[k]); clearInterval(drawTimers[k]); drawTimers[k] = null; }
  }
}

function setPhase(phase) {
  state.phase = phase;
  state.phaseStartedAt = Date.now();
}

/**
 * Run the winner draw:
 *   grid full -> [pre-delay] -> keno roll (server-driven ticks so every
 *   client sees the SAME numbers) -> result + celebration -> auto new round.
 * The winner is picked ONLY from claimed slots. Admin can trigger early.
 */
function startDraw(source = 'admin') {
  if (state.phase !== 'open') {
    return { ok: false, reason: 'DRAW_IN_PROGRESS', message: `A draw is already ${state.phase === 'drawing' ? 'running' : 'celebrating'} — wait for the next round.` };
  }
  const pool = game.claimedSlotNumbers(state);
  if (pool.length < 1) {
    return { ok: false, reason: 'NOTHING_CLAIMED', message: 'No slots are claimed yet — nothing to draw from.' };
  }

  clearDrawTimers();
  setPhase('drawing');
  state.stats.draws += 1;
  const ev = game.pushEvent(state, 'draw-started', {
    round: state.round, pool, poolSize: pool.length, source,
    rollMs: config.DRAW_ROLL_MS, preDelayMs: config.DRAW_PRE_DELAY_MS, tickMs: config.DRAW_TICK_MS,
  });
  io.emit('activity', ev);
  io.emit('draw-started', {
    round: state.round,
    pool,
    preDelayMs: config.DRAW_PRE_DELAY_MS,
    rollMs: config.DRAW_ROLL_MS,
    tickMs: config.DRAW_TICK_MS,
    source,
  });
  broadcastState();

  // 1) pre-delay pause (lets the "grid complete" moment breathe)
  drawTimers.preDelay = setTimeout(() => {
    // 2) keno roll — identical tick stream to every connected client
    const startedAt = Date.now();
    const pickRandom = () => pool[Math.floor(Math.random() * pool.length)];
    drawTimers.ticks = setInterval(() => {
      io.emit('draw-tick', { round: state.round, number: pickRandom(), elapsed: Date.now() - startedAt });
    }, config.DRAW_TICK_MS);

    // 3) stop rolling, crown the winner
    drawTimers.rollEnd = setTimeout(() => {
      clearInterval(drawTimers.ticks);
      drawTimers.ticks = null;
      finishDraw(pool, source);
    }, config.DRAW_ROLL_MS);
  }, config.DRAW_PRE_DELAY_MS);

  return { ok: true, round: state.round, pool };
}

function finishDraw(pool, source = 'admin') {
  const slot = pool[Math.floor(Math.random() * pool.length)];
  const entry = state.slots[slot];
  setPhase('celebrating');
  state.lastWinner = {
    round: state.round,
    slot,
    userId: entry?.userId || null,
    uniqueId: entry?.uniqueId || 'viewer',
    nickname: entry?.nickname || entry?.uniqueId || 'Viewer',
    profilePictureUrl: entry?.profilePictureUrl || null,
    _hue: entry?._hue || null,
    wonAt: Date.now(),
  };
  state.completedRounds += 1;
  game.addWinner(state, { ...state.lastWinner, source });
  store.saveWinners(state.winnerHistory);
  const ev = game.pushEvent(state, 'draw-result', {
    round: state.round, slot, winner: state.lastWinner, source, celebrateMs: config.CELEBRATE_MS,
  });
  io.emit('activity', ev);
  io.emit('draw-result', {
    round: state.round,
    slot,
    winner: state.lastWinner,
    celebrateMs: config.CELEBRATE_MS,
    source,
  });
  broadcastState();

  // 4) celebrate, then start the next round automatically
  drawTimers.reset = setTimeout(() => doReset('auto-draw'), config.CELEBRATE_MS);
  return state.lastWinner;
}

/** Grid full hook: auto-draw (default) or legacy sim auto-reset. */
function maybeAutoReset() {
  if (game.claimedCount(state) < state.totalSlots) return;
  if (autoResetTimer || drawTimers.preDelay) return; // already scheduled
  if (config.AUTO_DRAW) {
    const ev = game.pushEvent(state, 'grid-full', { round: state.round, drawInMs: config.DRAW_PRE_DELAY_MS });
    io.emit('activity', ev);
    drawTimers.preDelay = setTimeout(() => {
      drawTimers.preDelay = null;
      startDraw('auto');
    }, config.DRAW_PRE_DELAY_MS);
    return;
  }
  if (!simulator.enabled || !config.SIM_AUTO_RESET) return;
  const ev = game.pushEvent(state, 'grid-full', { round: state.round, autoResetInMs: 6000 });
  io.emit('activity', ev);
  autoResetTimer = setTimeout(() => {
    autoResetTimer = null;
    doReset('auto-sim');
  }, 6000);
}

function doReset(source = 'admin') {
  clearDrawTimers();
  if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
  const previous = game.resetRound(state);
  setPhase('open');
  const ev = game.pushEvent(state, 'reset', { round: state.round, previousRound: previous.round, source });
  io.emit('activity', ev);
  io.emit('round-reset', { round: state.round, previous, source });
  broadcastState();
  return previous;
}

/* ── admin auth ──────────────────────────────────────────────────────── */
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key || req.body?.adminKey;
  if (!key || key !== config.ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing admin key (x-admin-key header)' });
  }
  return next();
}

/** simulate endpoints stay open in demo mode, but require the admin key in production */
function requireAdminOrSim(req, res, next) {
  if (config.SIMULATE) return next();
  return requireAdmin(req, res, next);
}

/* ── HTTP API ────────────────────────────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ...serverInfo(), round: state.round, claimedCount: game.claimedCount(state) });
});

app.get('/api/state', (req, res) => {
  res.json({ ok: true, state: game.publicState(state, { server: serverInfo() }) });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/reset', requireAdmin, (req, res) => {
  const previous = doReset(req.body?.source || 'admin');
  res.json({ ok: true, message: `Round reset. New round: ${state.round}`, round: state.round, previous });
});

app.post('/api/admin/claim', requireAdmin, (req, res) => {
  const { slot, username, nickname } = req.body || {};
  const user = {
    userId: `manual-${String(username || nickname || 'user').toLowerCase()}`,
    uniqueId: String(username || 'admin_pick').replace(/^@/, ''),
    nickname: String(nickname || username || 'Admin Pick').replace(/^@/, ''),
    profilePictureUrl: null,
  };
  const result = ingestChat(user, String(slot), 'admin');
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/admin/release', requireAdmin, (req, res) => {
  if (state.phase !== 'open') {
    return res.status(409).json({ ok: false, error: `Cannot release slots while ${state.phase === 'drawing' ? 'the winner is being drawn' : 'celebrating'} — the round closes in a moment.` });
  }
  const result = game.releaseSlot(state, req.body?.slot);
  if (result.ok) {
    const ev = game.pushEvent(state, 'released', { slot: result.slot, by: 'admin' });
    io.emit('activity', ev);
    io.emit('slot-released', { slot: result.slot });
    broadcastState();
  }
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/admin/draw', requireAdmin, (req, res) => {
  const result = startDraw(req.body?.source || 'admin');
  res.status(result.ok ? 200 : 409).json(result.ok
    ? { ...result, message: `Draw started — rolling among ${result.pool.length} claimed slot${result.pool.length === 1 ? '' : 's'}…` }
    : result);
});

app.post('/api/admin/sim', requireAdmin, (req, res) => {
  const enable = Boolean(req.body?.enabled);
  if (enable && !config.SIMULATE) {
    return res.status(400).json({ ok: false, error: 'Simulator is disabled in production (SIMULATE=0). Set SIMULATE=1 in .env to allow it.' });
  }
  if (enable) simulator.start(); else simulator.stop();
  broadcastServer();
  return res.json({ ok: true, simulator: simulator.publicInfo });
});

/* ── winner history (admin winner list) ─────────────────────────────── */
app.get('/api/admin/winners', requireAdmin, (req, res) => {
  const q = req.query || {};
  const result = game.queryWinners(state, { round: q.round, from: q.from, to: q.to, limit: q.limit });
  res.json({ ok: true, ...result });
});

/* ── overlay ads (image / gif / short video) ────────────────────────── */
const AD_MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/apng': 'png', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv',
};

app.post('/api/admin/ad', requireAdmin, (req, res) => {
  const body = req.body || {};
  const durationSec = Math.min(Math.max(parseFloat(body.durationSec) || 8, 2), 300);
  const caption = String(body.caption || '').slice(0, 80);
  let url = null;
  let kind = body.kind === 'video' ? 'video' : body.kind === 'image' ? 'image' : null;

  if (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:')) {
    const m = body.dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return res.status(400).json({ ok: false, error: 'Unsupported data URL' });
    const mime = (m[1] || '').toLowerCase();
    const ext = AD_MIME_EXT[mime];
    if (!ext) return res.status(400).json({ ok: false, error: `Unsupported media type: ${mime || 'unknown'}` });
    if (!m[2]) return res.status(400).json({ ok: false, error: 'data URL must be base64' });
    const buffer = Buffer.from(m[3], 'base64');
    if (!buffer.length) return res.status(400).json({ ok: false, error: 'Empty upload' });
    if (buffer.length > config.AD_MAX_UPLOAD_MB * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: `File too large — max ${config.AD_MAX_UPLOAD_MB} MB` });
    }
    try {
      url = store.saveAdFile(buffer, ext, { publicDir: path.join(__dirname, 'public') });
    } catch (err) {
      return res.status(500).json({ ok: false, error: `Could not save upload: ${err.message}` });
    }
    if (!kind) kind = mime.startsWith('video/') ? 'video' : 'image';
  } else if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) {
    url = body.url.trim();
    if (!kind) kind = /\.(mp4|webm|mov|ogv)(\?|#|$)/i.test(url) ? 'video' : 'image';
  } else {
    return res.status(400).json({ ok: false, error: 'Provide a media file (dataUrl) or a public https URL' });
  }

  const payload = {
    url,
    kind,
    caption,
    durationMs: Math.round(durationSec * 1000),
    round: state.round,
    at: Date.now(),
    by: 'admin',
  };
  const ev = game.pushEvent(state, 'ad', { url, kind, caption, durationMs: payload.durationMs });
  io.emit('activity', ev);
  io.emit('ad:show', payload);
  console.log(`  [ad] showing ${kind} for ${durationSec}s -> ${url}`);
  return res.json({ ok: true, message: `Ad is live on the overlay for ${durationSec}s`, ...payload });
});

app.post('/api/admin/ad/stop', requireAdmin, (req, res) => {
  io.emit('ad:hide', { at: Date.now() });
  return res.json({ ok: true, message: 'Overlay ad dismissed' });
});

app.post('/api/simulate/chat', requireAdminOrSim, (req, res) => {
  const { username, nickname, comment, userId } = req.body || {};
  const user = {
    userId: String(userId || `manual-${String(username || 'tester').toLowerCase()}`),
    uniqueId: String(username || 'tester').replace(/^@/, ''),
    nickname: String(nickname || username || 'Tester').replace(/^@/, ''),
    profilePictureUrl: null,
  };
  const result = ingestChat(user, String(comment ?? ''), 'manual');
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/simulate/gift', requireAdminOrSim, (req, res) => {
  const { username, nickname, giftName, count } = req.body || {};
  const ev = ingestGift({
    uniqueId: String(username || 'tester').replace(/^@/, ''),
    nickname: String(nickname || username || 'Tester').replace(/^@/, ''),
    giftName: String(giftName || 'Rose'),
    repeatCount: Math.max(1, parseInt(count, 10) || 1),
    diamondCount: 0,
  }, 'manual');
  res.json({ ok: true, event: ev });
});

/* ── socket.io ───────────────────────────────────────────────────────── */
io.on('connection', (socket) => {
  socket.emit('state', game.publicState(state, { server: serverInfo() }));
  socket.emit('server', serverInfo());
  socket.emit('activity:history', state.events);
});

/* ── boot ────────────────────────────────────────────────────────────── */
server.listen(config.PORT, config.HOST, () => {
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│        🔒  LOCKED GRID LOTTERY — service up         │');
  console.log('└─────────────────────────────────────────────────────┘');
  console.log(`  Overlay (OBS) : http://localhost:${config.PORT}/`);
  console.log(`  Admin panel   : http://localhost:${config.PORT}/admin.html`);
  console.log(`  Mode          : ${mode()}${simulator.enabled ? ' + auto-sim' : ''}`);
  if (config.TIKTOK_USERNAME) {
    console.log(`  TikTok target : @${config.TIKTOK_USERNAME}`);
    bridge.connect();
  } else {
    console.log('  TikTok target : (none) — set TIKTOK_USERNAME in .env to go live');
  }
  if (config.SIMULATE && config.AUTO_SIM) simulator.start();
  if (simulator.enabled) broadcastServer();
});

/* status updates from the TikTok bridge */
bridge.on('status', () => broadcastServer());
bridge.on('log', (line) => console.log(`  [tiktok] ${line}`));
bridge.on('chat', ({ user, comment }) => ingestChat(user, comment, 'tiktok'));
bridge.on('gift', (gift) => ingestGift(gift, 'tiktok'));
bridge.on('join', ({ user }) => {
  const ev = game.pushEvent(state, 'join', { user: { uniqueId: user.uniqueId, nickname: user.nickname }, source: 'tiktok' });
  io.emit('activity', ev);
});

/* graceful shutdown */
function shutdown() {
  console.log('\nShutting down…');
  simulator.stop();
  bridge.disconnect();
  clearDrawTimers();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
