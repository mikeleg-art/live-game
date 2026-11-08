/**
 * Locked Grid Lottery — game state & ATOMIC LOCKING LOGIC
 * --------------------------------------------------------
 * Node.js runs event handlers on a single thread. Every mutation below is a
 * synchronous critical section (no `await`, no I/O between validation and
 * write), which makes check-then-lock operations atomic: two comments can
 * never claim the same slot simultaneously, even if they arrive in the same
 * event-loop tick.
 */
const { TOTAL_SLOTS, EVENT_BUFFER_SIZE, WINNER_HISTORY_SIZE } = require('./config');

function createGameState() {
  return {
    round: 1,
    roundStartedAt: Date.now(),
    totalSlots: TOTAL_SLOTS,
    /** game phase: 'open' -> claims allowed | 'drawing' -> keno roll running | 'celebrating' -> winner shown */
    phase: 'open',
    /** slot number -> { userId, uniqueId, nickname, profilePictureUrl, lockedAt } | null */
    slots: Array.from({ length: TOTAL_SLOTS + 1 }, () => null), // index 0 unused
    /** userId -> slot number (enforces ONE SLOT PER USER) */
    userToSlot: new Map(),
    /** winner of the most recent draw — survives round resets until a new winner is crowned */
    lastWinner: null,
    stats: { claims: 0, rejectedTaken: 0, rejectedDuplicate: 0, ignored: 0, gifts: 0, resets: 0, draws: 0 },
    /** ring buffer of recent activity events for late joiners */
    events: [],
    /** server boot time (uptime display) */
    bootedAt: Date.now(),
    /** number of rounds where every slot got claimed */
    completedRounds: 0,
    /** timestamp the current phase started (client sync / debugging) */
    phaseStartedAt: Date.now(),
    /** every crowned winner, newest last — persisted to data/winners.json */
    winnerHistory: [],
  };
}

/**
 * Parse a raw chat comment into a slot claim attempt.
 * Accepts bare numbers with optional leading '#': "7", "#7", "10".
 * Anything else (sentences, emoji, other commands) is ignored.
 */
function parseSlotComment(comment) {
  const m = String(comment ?? '').trim().match(/^#?(\d{1,3})$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Try to atomically lock `slotNumber` for `user`.
 * Validation order (per spec §3A):
 *   1. number within range 1..TOTAL_SLOTS
 *   2. slot still free        -> else SLOT_TAKEN
 *   3. user has no other slot -> else USER_HAS_SLOT
 *   4. lock it, record nickname + profile picture
 *
 * @returns {{ok:true, slot:number, entry:object} |
 *           {ok:false, reason:string, message:string, slot?:number}}
 */
function tryClaim(state, slotNumber, user) {
  const slot = Number(slotNumber);

  // 1) range check
  if (!Number.isInteger(slot) || slot < 1 || slot > state.totalSlots) {
    state.stats.ignored += 1;
    return { ok: false, reason: 'OUT_OF_RANGE', message: `Pick a number between 1 and ${state.totalSlots}` };
  }

  // ── critical section: synchronous, no I/O, guaranteed atomic ──────────
  // 2) slot availability
  if (state.slots[slot]) {
    state.stats.rejectedTaken += 1;
    return { ok: false, reason: 'SLOT_TAKEN', slot, message: `Slot ${slot} is already locked` };
  }
  // 3) one slot per user
  const owned = state.userToSlot.get(user.userId);
  if (owned !== undefined) {
    state.stats.rejectedDuplicate += 1;
    return { ok: false, reason: 'USER_HAS_SLOT', slot: owned, message: `@${user.uniqueId} already holds slot ${owned}` };
  }
  // 4) atomic claim
  const entry = {
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,
    profilePictureUrl: user.profilePictureUrl || null,
    lockedAt: Date.now(),
  };
  state.slots[slot] = entry;
  state.userToSlot.set(user.userId, slot);
  state.stats.claims += 1;
  // ── end critical section ───────────────────────────────────────────────

  return { ok: true, slot, entry };
}

/** Admin/manual release of a single slot. */
function releaseSlot(state, slotNumber) {
  const slot = Number(slotNumber);
  const entry = state.slots[slot];
  if (!entry) return { ok: false, message: `Slot ${slot} is not locked` };
  state.slots[slot] = null;
  state.userToSlot.delete(entry.userId);
  return { ok: true, slot, released: entry };
}

/** Flush all locks and start a new round (spec §3B). */
function resetRound(state) {
  const previous = {
    round: state.round,
    claimed: claimedCount(state),
  };
  state.round += 1;
  state.roundStartedAt = Date.now();
  state.slots = Array.from({ length: state.totalSlots + 1 }, () => null);
  state.userToSlot.clear();
  state.stats.resets += 1;
  return previous;
}

function claimedCount(state) {
  let n = 0;
  for (let i = 1; i <= state.totalSlots; i++) if (state.slots[i]) n++;
  return n;
}

/** Slot numbers currently locked, ascending — the draw pool. */
function claimedSlotNumbers(state) {
  const out = [];
  for (let i = 1; i <= state.totalSlots; i++) if (state.slots[i]) out.push(i);
  return out;
}

function freeSlots(state) {
  const out = [];
  for (let i = 1; i <= state.totalSlots; i++) if (!state.slots[i]) out.push(i);
  return out;
}

/** Serializable snapshot broadcast to overlay / admin clients. */
function publicState(state, extras = {}) {
  return {
    round: state.round,
    roundStartedAt: state.roundStartedAt,
    totalSlots: state.totalSlots,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    lastWinner: state.lastWinner,
    slots: state.slots.slice(1).map((s, i) => (s ? { slot: i + 1, ...s } : { slot: i + 1, locked: false })),
    claimedCount: claimedCount(state),
    stats: state.stats,
    completedRounds: state.completedRounds,
    events: state.events,
    serverTime: Date.now(),
    ...extras,
  };
}

/* ── winner history ─────────────────────────────────────────────────── */

/**
 * Append a crowned winner to the history (newest last) and trim the list.
 * The caller is responsible for persisting it to disk.
 */
function addWinner(state, winner) {
  state.winnerHistory.push(winner);
  if (state.winnerHistory.length > WINNER_HISTORY_SIZE) {
    state.winnerHistory.splice(0, state.winnerHistory.length - WINNER_HISTORY_SIZE);
  }
  return winner;
}

/**
 * Filter the winner history.
 *   opts.round — exact round number (optional)
 *   opts.from  — epoch ms/seconds, ISO date or 'YYYY-MM-DD' — won at/after (optional)
 *   opts.to    — epoch ms/seconds, ISO date or 'YYYY-MM-DD' — won at/before (optional,
 *                a bare date is treated as inclusive of the whole local day)
 *   opts.limit — max rows returned (default 200, newest first)
 */

/** Parse a date filter param. Accepts epoch ms / epoch s / ISO / YYYY-MM-DD. Returns ms or null. */
function parseDateParam(v, endOfDay = false) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (/^-?\d{1,13}$/.test(s)) {
    let n = Number(s);
    if (Math.abs(n) < 1e12) n *= 1000; // epoch seconds → ms
    return n;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // bare calendar date — interpret in server-local time to match the admin UI's date picker
    const t = Date.parse(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s); // full ISO / RFC 2822 etc.
  return Number.isNaN(t) ? null : t;
}

function queryWinners(state, opts = {}) {
  const round = parseInt(opts.round, 10);
  const from = parseDateParam(opts.from, false);
  const to = parseDateParam(opts.to, true);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);

  let rows = state.winnerHistory;
  if (Number.isInteger(round) && round > 0) rows = rows.filter((w) => w.round === round);
  if (from != null) rows = rows.filter((w) => w.wonAt >= from);
  if (to != null) rows = rows.filter((w) => w.wonAt <= to);

  const out = rows.slice(-limit).reverse(); // newest first
  return { winners: out, total: rows.length, matched: out.length };
}

/** Push an activity event into the ring buffer and return it. */
function pushEvent(state, type, payload = {}) {
  const event = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, type, at: Date.now(), ...payload };
  state.events.push(event);
  if (state.events.length > EVENT_BUFFER_SIZE) state.events.splice(0, state.events.length - EVENT_BUFFER_SIZE);
  return event;
}

module.exports = {
  createGameState,
  parseSlotComment,
  tryClaim,
  releaseSlot,
  resetRound,
  claimedCount,
  claimedSlotNumbers,
  freeSlots,
  publicState,
  pushEvent,
  addWinner,
  queryWinners,
};
