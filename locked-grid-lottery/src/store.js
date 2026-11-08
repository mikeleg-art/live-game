/**
 * Locked Grid Lottery — tiny JSON persistence
 * -------------------------------------------
 * Keeps the winner history (and any future small state) alive across
 * restarts. Writes are atomic-ish: temp file + rename, so a crash mid-write
 * can never corrupt the previous snapshot. No dependencies.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WINNERS_FILE = path.join(DATA_DIR, 'winners.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
}

/** Load the persisted winner list (returns [] when missing/corrupt). */
function loadWinners() {
  try {
    const raw = fs.readFileSync(WINNERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.winners) ? parsed.winners : [];
  } catch {
    return [];
  }
}

/** Persist the winner list (newest last). Safe to call on every draw. */
function saveWinners(winners) {
  ensureDataDir();
  const tmp = `${WINNERS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), winners }, null, 1));
    fs.renameSync(tmp, WINNERS_FILE);
    return true;
  } catch (err) {
    console.warn(`  [store] could not save winners.json: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
    return false;
  }
}

/** Save an uploaded ad buffer into data/uploads (or public/uploads). Returns the public URL path. */
function saveAdFile(buffer, ext, { publicDir }) {
  const dir = path.join(publicDir, 'uploads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const name = `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${safeExt}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  // opportunistic cleanup: remove ad files older than 7 days
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('ad-')) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* noop */ }
    }
  } catch { /* noop */ }
  return `/uploads/${name}`;
}

module.exports = { loadWinners, saveWinners, saveAdFile, DATA_DIR, WINNERS_FILE };
