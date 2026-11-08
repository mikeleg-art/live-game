/**
 * Locked Grid Lottery — fake-viewer simulator
 * -------------------------------------------
 * Feeds synthetic chat comments / gifts through the exact same ingest
 * pipeline as real TikTok events, so the whole system (validation,
 * broadcast, overlay) can be tested without a live connection.
 */
const config = require('./config');

const FAKE_VIEWERS = [
  ['sim_nova', 'Neon Nova'], ['sim_pix3l', 'Pix3lPirate'], ['sim_zara', 'ZaraZaps'],
  ['sim_mojo', 'MojoM4ster'], ['sim_kiki', 'KikiKaboom'], ['sim_rex', 'RexRiot'],
  ['sim_lulu', 'LuluLive'], ['sim_ghost', 'GlitchGhost'], ['sim_byte', 'ByteBunny'],
  ['sim_vex', 'VexVolt'], ['sim_mira', 'MiraMyth'], ['sim_jax', 'JaxJolt'],
  ['sim_nyx', 'NyxNight'], ['sim_otto', 'OttoOverdrive'], ['sim_pip', 'PipPixel'],
  ['sim_rune', 'RuneRush'], ['sim_suki', 'SukiStorm'], ['sim_taz', 'TazTurbine'],
];

const FAKE_GIFTS = [
  ['Rose', 1, 1], ['Rose', 5, 1], ['TikTok', 1, 1], ['Finger Heart', 3, 1],
  ['GG', 1, 1], ['Ice Cream Cone', 10, 1], ['Perfume', 1, 20], ['Galaxy', 1, 1000],
];

const AVATAR_HUES = [4, 26, 48, 96, 152, 174, 202, 262, 300, 330];

function makeFakeUser(i) {
  const [uniqueId, nickname] = FAKE_VIEWERS[i % FAKE_VIEWERS.length];
  const hue = AVATAR_HUES[i % AVATAR_HUES.length];
  return {
    userId: `${uniqueId}#${i}`,
    uniqueId: `${uniqueId}_${Math.floor(i / FAKE_VIEWERS.length) + 1}`,
    nickname,
    profilePictureUrl: null,
    _hue: hue, // client-side avatar fallback color
  };
}

class Simulator {
  constructor({ onChat, onGift }) {
    this.onChat = onChat;
    this.onGift = onGift;
    this.enabled = false;
    this.timer = null;
    this.userIndex = 0;
    this.giftIndex = 0;
    this.autoReset = config.SIM_AUTO_RESET;
  }

  get publicInfo() {
    return { enabled: this.enabled, autoReset: this.autoReset, active: Boolean(this.timer) };
  }

  /** Emit one synthetic chat comment (used by auto-sim and the admin "inject" console). */
  chat(comment, overrides = {}) {
    const user = { ...makeFakeUser(this.userIndex++), ...overrides };
    this.onChat(user, comment, 'simulator');
    return user;
  }

  gift(giftName, count, overrides = {}) {
    const user = { ...makeFakeUser(this.userIndex++), ...overrides };
    const picked = giftName
      ? FAKE_GIFTS.find(([g]) => g.toLowerCase() === String(giftName).toLowerCase()) || [giftName, 1, 1]
      : FAKE_GIFTS[this.giftIndex++ % FAKE_GIFTS.length];
    this.onGift(
      {
        ...user,
        giftName: picked[0],
        repeatCount: count || picked[1],
        diamondCount: picked[2] * (count || picked[1]),
      },
      'simulator',
    );
    return user;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.loop();
  }

  stop() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  loop() {
    if (!this.enabled) return;
    const delay = 1800 + Math.random() * 2600;
    this.timer = setTimeout(() => {
      try {
        this.tick();
      } finally {
        if (this.enabled) this.loop();
      }
    }, delay);
  }

  tick() {
    // Occasionally a gift flies by
    if (Math.random() < 0.18) {
      this.gift();
      return;
    }
    const user = this.chat(String(1 + Math.floor(Math.random() * config.TOTAL_SLOTS)));
    void user;
  }
}

module.exports = { Simulator, FAKE_VIEWERS };
