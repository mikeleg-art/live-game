/* Locked Grid Lottery — plain-Node smoke test of the standalone package.
 * Simulates exactly what a user runs: npm install + node server.js on Windows.
 * Flow: health → 10 claims → admin draw → socket ticks → result → auto new round
 *       → winner history (round + date filters) → ad push (static file) → ad stop.
 */
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3999';
const KEY = 'changeme';
const { io } = require(path.join(process.env.PKG_DIR || '/tmp/lgl-test', 'node_modules', 'socket.io-client'));

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};

const api = async (method, p, body, auth = false) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-admin-key': KEY } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nSmoke-testing ${BASE}\n`);
  const socket = io(BASE, { transports: ['websocket'] });
  const seen = { started: null, ticks: [], result: null, reset: null, adShow: null };
  socket.on('draw-started', (e) => { seen.started = e; });
  socket.on('draw-tick', (e) => { seen.ticks.push(e.number); });
  socket.on('draw-result', (e) => { seen.result = e; });
  socket.on('round-reset', (e) => { seen.reset = e; });
  socket.on('ad:show', (e) => { seen.adShow = e; });

  await new Promise((r) => socket.on('connect', r));

  // 1. health + initial state
  const health = await api('GET', '/api/health');
  check('GET /api/health', health.json?.ok === true);

  const st0 = await api('GET', '/api/state');
  check('state phase=open', st0.json?.state?.phase === 'open');
  check('state has 10 slots', st0.json?.state?.totalSlots === 10, `totalSlots=${st0.json?.state?.totalSlots}`);
  const round0 = st0.json?.state?.round; // next round after the draw — state-agnostic

  // 2. claim all 10 slots
  let claimsOk = 0;
  for (let i = 1; i <= 10; i++) {
    const r = await api('POST', '/api/simulate/chat', { username: `viewer${i}`, comment: String(i) });
    if (r.json?.ok) claimsOk++;
  }
  check('10/10 claims accepted', claimsOk === 10, `${claimsOk}/10`);

  // duplicates still rejected
  const dup = await api('POST', '/api/simulate/chat', { username: 'viewer1', comment: '2' });
  check('duplicate user rejected', dup.status === 409 || dup.json?.ok === false);

  // 3. admin draw
  const draw = await api('POST', '/api/admin/draw', { source: 'smoke-test' }, true);
  check('POST /api/admin/draw ok', draw.json?.ok === true && draw.json?.pool?.length === 10, `pool=${draw.json?.pool?.length}`);

  // 4. keno roll + result
  const preDelay = 600, roll = 1900, celebrate = 2700;
  await sleep(preDelay + roll + 1200);
  check('draw-started received', !!seen.started && seen.started.pool?.length === 10);
  check('keno ticks streamed', seen.ticks.length >= 5, `${seen.ticks.length} ticks`);
  check('draw-result received with winner', !!seen.result?.winner?.uniqueId, `winner=${seen.result?.winner?.uniqueId} slot=${seen.result?.slot}`);
  check('winner uniqueId is NOT a placeholder (?/undefined)', !!seen.result?.winner?.uniqueId && !['?', 'undefined', 'null'].includes(String(seen.result.winner.uniqueId)));

  // 5. celebration → auto new round
  const st1 = await api('GET', '/api/state');
  check('phase=celebrating after result', st1.json?.state?.phase === 'celebrating', `phase=${st1.json?.state?.phase}`);
  check('lastWinner pinned', st1.json?.state?.lastWinner?.uniqueId === seen.result?.winner?.uniqueId);
  await sleep(celebrate + 800);
  const st2 = await api('GET', '/api/state');
  check('auto new round open', st2.json?.state?.phase === 'open' && st2.json?.state?.round === round0 + 1, `round=${st2.json?.state?.round}`);
  check('round-reset broadcast', !!seen.reset && seen.reset.round === round0 + 1);
  check('grid empty after reset', (st2.json?.state?.slots || []).every((s) => !s.locked), `locked=${(st2.json?.state?.slots || []).filter((s) => s.locked).length}`);

  // 6. winner history + filters
  const wAll = await api('GET', '/api/admin/winners?limit=50', null, true);
  check('GET /api/admin/winners', wAll.json?.ok === true && (wAll.json?.winners || []).length >= 1, `total=${wAll.json?.total}`);
  const wR2 = await api('GET', `/api/admin/winners?round=${round0 + 1}`, null, true);
  check('filter by round', wR2.json?.ok === true && (wR2.json?.winners || []).length === 0, `round=${round0 + 1} → 0 (winner was round ${round0})`);
  const from = new Date(Date.now() - 3600e3).toISOString();
  const wDate = await api('GET', `/api/admin/winners?from=${encodeURIComponent(from)}`, null, true);
  check('filter by date (last hour)', wDate.json?.ok === true && (wDate.json?.winners || []).length >= 1, `total=${wDate.json?.total}`);
  const wOld = await api('GET', '/api/admin/winners?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z', null, true);
  check('date range excludes future winners', (wOld.json?.winners || []).length === 0, `got ${(wOld.json?.winners || []).length}`);
  // calendar-day form (what the admin panel's date picker sends) — must actually filter
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const wToday = await api('GET', `/api/admin/winners?from=${ymd}&to=${ymd}`, null, true);
  check('YYYY-MM-DD day filter (admin panel format)', wToday.json?.ok === true && (wToday.json?.winners || []).length >= 1, `total=${wToday.json?.total}`);
  const wOldYmd = await api('GET', '/api/admin/winners?from=2020-01-01&to=2020-01-01', null, true);
  check('YYYY-MM-DD excludes future winners', (wOldYmd.json?.winners || []).length === 0, `got ${(wOldYmd.json?.winners || []).length}`);

  // 7. ad push (image dataUrl) + static serving + stop
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ad = await api('POST', '/api/admin/ad', { dataUrl: TINY_PNG, kind: 'image', durationSec: 3, caption: 'Smoke test ad' }, true);
  check('POST /api/admin/ad ok', ad.json?.ok === true, `url=${ad.json?.url}`);
  if (ad.json?.url) {
    const img = await fetch(BASE + ad.json.url);
    check('uploaded ad file served', img.status === 200, `status=${img.status}`);
  }
  await sleep(300);
  check('ad:show broadcast', !!seen.adShow && seen.adShow.durationMs === 3000, `durationMs=${seen.adShow?.durationMs}`);
  const adStop = await api('POST', '/api/admin/ad/stop', {}, true);
  check('POST /api/admin/ad/stop ok', adStop.json?.ok === true);

  // 8. reset via admin
  const rs = await api('POST', '/api/reset', { source: 'smoke-test' }, true);
  check('POST /api/reset ok', rs.json?.ok === true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✅ ALL PASS' : '❌ FAILURES: ' + failed.length} (${results.length} checks)\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
