/**
 * Locked Grid Lottery — TikTok LIVE bridge (lazy-loader edition)
 * -------------------------------------------------------------
 * Wraps `tiktok-live-connector` and normalizes v1 / v2 library APIs so the
 * game server only deals with a single event shape.
 *
 *   chat  -> { user:{userId, uniqueId, nickname, profilePictureUrl}, comment }
 *   gift  -> { user:{...}, giftName, giftId, repeatCount, diamondCount, streakable }
 *
 * The connector is loaded LAZILY (inside connect()), so the service boots
 * fine in simulation/demo environments where the package is not installed.
 * Install it only when you want to go live:  bun add tiktok-live-connector
 */
const EventModule = require('events');
const config = require('./config');

/** Feature-detect the connection class (v2: TikTokLiveConnection, v1: WebcastPushConnection) */
function loadLib() {
  try {
    return require('tiktok-live-connector');
  } catch {
    return null;
  }
}

/** Normalize a v1/v2 user payload into one canonical shape. */
function normalizeUser(data) {
  const u = data.user || data;
  const picture =
    data.userDetails?.profilePictureUrls?.find(Boolean) ||
    u.profilePictureUrl ||
    data.profilePictureUrl ||
    null;
  return {
    userId: String(u.userId || u.uniqueId || `anon-${Math.random().toString(36).slice(2, 8)}`),
    uniqueId: u.uniqueId || u.nickname || 'viewer',
    nickname: u.nickname || u.uniqueId || 'Viewer',
    profilePictureUrl: picture,
  };
}

class TikTokBridge extends EventModule.EventEmitter {
  constructor() {
    super();
    this.username = config.TIKTOK_USERNAME;
    this.connection = null;
    this.status = 'idle'; // idle | connecting | connected | disconnected | error
    this.roomInfo = null;
    this.lastError = null;
    this.retries = 0;
    this.manualStop = false;
  }

  get publicInfo() {
    return {
      username: this.username,
      status: this.status,
      configured: Boolean(this.username),
      roomInfo: this.roomInfo
        ? { roomId: this.roomInfo.roomId, viewerCount: this.roomInfo.viewerCount ?? this.roomInfo.user?.viewerCount ?? null }
        : null,
      lastError: this.lastError,
      retries: this.retries,
    };
  }

  async connect() {
    if (!this.username) {
      this.status = 'idle';
      return false;
    }

    const lib = loadLib();
    if (!lib) {
      this.status = 'error';
      this.lastError = 'tiktok-live-connector is not installed — run: bun add tiktok-live-connector';
      this.emit('status', this.publicInfo);
      this.emit('log', this.lastError);
      return false;
    }

    const ConnectionCtor = lib.TikTokLiveConnection || lib.WebcastPushConnection;
    const EVT = {
      CHAT: (lib.WebcastEvent && lib.WebcastEvent.CHAT) || 'chat',
      GIFT: (lib.WebcastEvent && lib.WebcastEvent.GIFT) || 'gift',
      CONNECTED: (lib.WebcastEvent && lib.WebcastEvent.CONNECTED) || 'connected',
      DISCONNECTED: (lib.WebcastEvent && lib.WebcastEvent.DISCONNECTED) || 'disconnected',
      ERROR: (lib.WebcastEvent && lib.WebcastEvent.ERROR) || 'error',
      STREAM_END: (lib.WebcastEvent && lib.WebcastEvent.STREAM_END) || 'streamEnd',
      MEMBER: (lib.WebcastEvent && lib.WebcastEvent.MEMBER) || 'member',
    };

    if (!ConnectionCtor) {
      this.lastError = 'tiktok-live-connector: no connection class found';
      this.status = 'error';
      return false;
    }

    this.manualStop = false;
    this.status = 'connecting';
    this.emit('status', this.publicInfo);

    try {
      this.connection = new ConnectionCtor(this.username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
      });

      this.connection.on(EVT.CONNECTED, (state) => {
        this.status = 'connected';
        this.retries = 0;
        this.roomInfo = state?.roomInfo || null;
        this.emit('status', this.publicInfo);
        this.emit('log', `Connected to TikTok LIVE for @${this.username}`);
      });

      this.connection.on(EVT.DISCONNECTED, () => {
        this.status = 'disconnected';
        this.emit('status', this.publicInfo);
        this.emit('log', 'TikTok LIVE disconnected');
        if (!this.manualStop) this.scheduleRetry();
      });

      this.connection.on(EVT.ERROR, (err) => {
        this.lastError = err?.message || String(err);
        this.emit('log', `TikTok error: ${this.lastError}`);
      });

      if (EVT.STREAM_END !== EVT.ERROR) {
        this.connection.on(EVT.STREAM_END, () => {
          this.status = 'disconnected';
          this.emit('status', this.publicInfo);
          this.emit('log', 'TikTok stream ended');
          if (!this.manualStop) this.scheduleRetry();
        });
      }

      this.connection.on(EVT.CHAT, (data) => {
        this.emit('chat', { user: normalizeUser(data), comment: data.comment, raw: undefined });
      });

      this.connection.on(EVT.GIFT, (data) => {
        const streakable = data.giftType === 1;
        // For streakable gifts TikTok emits events during the streak; the final
        // event carries the total repeatCount. We broadcast every event with the
        // running count — the overlay ticker de-duplicates visually anyway.
        this.emit('gift', {
          user: normalizeUser(data),
          giftName: data.giftName || data.extendedGift?.name || 'Gift',
          giftId: data.giftId,
          repeatCount: data.repeatCount || 1,
          diamondCount: (data.diamondCount || data.extendedGift?.diamond_count || 0) * (data.repeatCount || 1),
          streakable,
          streakEnded: streakable ? Boolean(data.giftType === 1 && data.repeatEnd) : true,
        });
      });

      this.connection.on(EVT.MEMBER, (data) => {
        this.emit('join', { user: normalizeUser(data) });
      });

      await this.connection.connect();
      return true;
    } catch (err) {
      this.status = 'error';
      this.lastError = err?.message || String(err);
      this.emit('status', this.publicInfo);
      this.emit('log', `TikTok connect failed: ${this.lastError}`);
      this.scheduleRetry();
      return false;
    }
  }

  scheduleRetry() {
    if (this.manualStop || !this.username) return;
    if (this.retries >= config.TIKTOK_MAX_RETRIES) {
      this.emit('log', `Gave up reconnecting after ${this.retries} attempts. Will not retry automatically.`);
      return;
    }
    this.retries += 1;
    const wait = config.TIKTOK_RETRY_BASE_MS * this.retries;
    this.emit('log', `Reconnecting to TikTok in ${Math.round(wait / 1000)}s (attempt ${this.retries}/${config.TIKTOK_MAX_RETRIES})`);
    setTimeout(() => {
      if (!this.manualStop) this.connect();
    }, wait);
  }

  disconnect() {
    this.manualStop = true;
    try {
      this.connection?.disconnect?.();
    } catch { /* noop */ }
    this.status = 'disconnected';
    this.emit('status', this.publicInfo);
  }
}

module.exports = { TikTokBridge, normalizeUser };
