/**
 * Locked Grid Lottery — configuration loader
 * All values come from environment variables (.env or process env).
 */
require('dotenv').config();

const parseBool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v));

const config = {
  /** HTTP port for the Express + socket.io server */
  PORT: parseInt(process.env.PORT, 10) || 3003,
  /** Bind address (0.0.0.0 = reachable from outside) */
  HOST: process.env.HOST || '0.0.0.0',

  /** TikTok username of the LIVE streamer (without @). Empty => simulation only. */
  TIKTOK_USERNAME: (process.env.TIKTOK_USERNAME || '').replace(/^@/, '').trim(),

  /** Shared secret for /api/reset and all /api/admin/* routes (x-admin-key header or ?key=) */
  ADMIN_KEY: process.env.ADMIN_KEY || 'changeme',

  /** Enable the fake-viewer simulator (dev/demo). Auto-enabled when no username is set. */
  SIMULATE: parseBool(process.env.SIMULATE, false),

  /** When simulating: start the auto-claim loop immediately */
  AUTO_SIM: parseBool(process.env.AUTO_SIM, false),

  /** When simulating: auto-reset the round a few seconds after the grid fills up */
  SIM_AUTO_RESET: parseBool(process.env.SIM_AUTO_RESET, true),

  /** Grid size (spec fixes 10; configurable for other game variants) */
  TOTAL_SLOTS: Math.min(Math.max(parseInt(process.env.TOTAL_SLOTS, 10) || 10, 1), 100),

  /* ── winner-draw (keno) flow ────────────────────────────────────────── */
  /** When the grid fills up, automatically start the keno draw after a short pause */
  AUTO_DRAW: parseBool(process.env.AUTO_DRAW, true),
  /** Pause after the grid fills / admin triggers before the numbers start rolling (ms) */
  DRAW_PRE_DELAY_MS: Math.max(500, parseInt(process.env.DRAW_PRE_DELAY_MS, 10) || 2600),
  /** How long the keno roll lasts (ms) */
  DRAW_ROLL_MS: Math.max(1500, parseInt(process.env.DRAW_ROLL_MS, 10) || 5000),
  /** Interval between rolling numbers (ms) */
  DRAW_TICK_MS: Math.max(60, parseInt(process.env.DRAW_TICK_MS, 10) || 130),
  /** Winner celebration time before the next round starts automatically (ms) */
  CELEBRATE_MS: Math.max(2500, parseInt(process.env.CELEBRATE_MS, 10) || 6500),

  /** TikTok reconnection: max attempts and backoff base (ms) */
  TIKTOK_MAX_RETRIES: parseInt(process.env.TIKTOK_MAX_RETRIES, 10) || 5,
  TIKTOK_RETRY_BASE_MS: parseInt(process.env.TIKTOK_RETRY_BASE_MS, 10) || 5000,

  /** How many recent activity events are kept for late-joining clients */
  EVENT_BUFFER_SIZE: 50,

  /** Max winners kept in memory / winners.json (admin winner list) */
  WINNER_HISTORY_SIZE: Math.max(50, parseInt(process.env.WINNER_HISTORY_SIZE, 10) || 1000),
  /** Max uploaded ad file size in MB (image / gif / short video) */
  AD_MAX_UPLOAD_MB: Math.max(1, parseInt(process.env.AD_MAX_UPLOAD_MB, 10) || 48),
};

/** Simulation is forced on when no TikTok username is configured. */
config.SIMULATE = config.SIMULATE || config.TIKTOK_USERNAME === '';

module.exports = config;
