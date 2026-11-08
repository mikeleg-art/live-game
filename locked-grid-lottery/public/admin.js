/* ═══════════════════════════════════════════════════════════════════════
   LOCKED GRID LOTTERY — admin panel client
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const gatewayPort = params.get('XTransformPort');
  const Q = gatewayPort ? `?XTransformPort=${gatewayPort}` : '';
  const socket = gatewayPort
    ? io(`/?XTransformPort=${gatewayPort}`, { transports: ['websocket', 'polling'], reconnection: true, timeout: 10000 })
    : io({ reconnection: true, timeout: 10000 });

  const $ = (id) => document.getElementById(id);
  const els = {
    connDot: $('conn-dot'), connLabel: $('conn-label'),
    stMode: $('st-mode'), stModeHint: $('st-mode-hint'),
    stTiktok: $('st-tiktok'), stTiktokHint: $('st-tiktok-hint'),
    stRound: $('st-round'), stRoundHint: $('st-round-hint'),
    stSim: $('st-sim'),
    grid: $('grid'), log: $('log'),
    adminKey: $('admin-key'),
    btnReset: $('btn-reset'), btnDraw: $('btn-draw'),
    awardSlot: $('award-slot'), awardUser: $('award-user'), btnAward: $('btn-award'),
    simToggle: $('sim-toggle'),
    injUser: $('inj-user'), injComment: $('inj-comment'), btnInjChat: $('btn-inj-chat'),
    injGiftUser: $('inj-gift-user'), injGift: $('inj-gift'), injGiftCount: $('inj-gift-count'), btnInjGift: $('btn-inj-gift'),
    footMode: $('foot-mode'),
    /* winner history */
    winRound: $('win-round'), winFrom: $('win-from'), winTo: $('win-to'),
    btnWinRefresh: $('btn-win-refresh'), winnersBody: $('winners-body'), winTotal: $('win-total'),
    /* overlay ad */
    adFile: $('ad-file'), adUrl: $('ad-url'), adDuration: $('ad-duration'), adCaption: $('ad-caption'),
    btnAdShow: $('btn-ad-show'), btnAdStop: $('btn-ad-stop'),
  };

  let totalSlots = 10;
  let lastState = null;

  /* ── admin key (persisted; ?key= wins) ────────────────────────────────── */
  const storedKey = (() => { try { return localStorage.getItem('lgl_admin_key'); } catch { return null; } })();
  els.adminKey.value = params.get('key') || storedKey || '';
  els.adminKey.addEventListener('change', () => {
    try { localStorage.setItem('lgl_admin_key', els.adminKey.value); } catch { /* noop */ }
    loadWinners(); // the table may have failed before the key was entered
  });
  const adminKey = () => els.adminKey.value;

  /* ── API helper ───────────────────────────────────────────────────────── */
  async function api(path, body, needsKey = true) {
    const headers = { 'content-type': 'application/json' };
    if (needsKey) headers['x-admin-key'] = adminKey();
    const res = await fetch(`/api/${path}${Q}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!res.ok || json.ok === false) {
      log('system', `⚠ ${json.error || res.statusText || 'request failed'}`);
      throw new Error(json.error || res.statusText);
    }
    return json;
  }

  /** GET variant (winner history) — key via header, never the URL */
  async function apiGet(path, params = {}, needsKey = true) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') usp.set(k, v);
    const headers = {};
    if (needsKey) headers['x-admin-key'] = adminKey();
    const res = await fetch(`/api/${path}${usp.toString() ? `?${usp}${Q ? `&${Q.slice(1)}` : ''}` : Q}`, { headers });
    const json = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!res.ok || json.ok === false) throw new Error(json.error || res.statusText);
    return json;
  }

  /* ── log ──────────────────────────────────────────────────────────────── */
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function log(kind, html) {
    const line = document.createElement('div');
    line.className = `log-line ${kind}`;
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    line.innerHTML = `<span class="t">${t}</span><span class="m">${html}</span>`;
    els.log.prepend(line);
    while (els.log.children.length > 120) els.log.lastChild.remove();
  }

  /* ── status rendering ─────────────────────────────────────────────────── */
  function renderServer(srv) {
    if (!srv) return;
    els.stMode.textContent = srv.mode;
    els.stMode.className = `v ${srv.mode === 'LIVE' ? 'live' : 'warn'}`;
    els.stModeHint.textContent = srv.tiktok?.username ? `@${srv.tiktok.username}` : 'no TIKTOK_USERNAME set';

    const t = srv.tiktok || {};
    els.stTiktok.textContent = t.configured ? t.status.toUpperCase() : 'NOT SET';
    els.stTiktok.className = `v ${t.status === 'connected' ? 'live' : t.configured ? 'warn' : 'off'}`;
    els.stTiktokHint.textContent = t.lastError || (t.roomInfo?.viewerCount != null ? `${t.roomInfo.viewerCount} viewers` : 'unofficial live API');

    els.stSim.textContent = srv.simulator?.enabled ? 'RUNNING' : srv.simulate ? 'READY' : 'OFF';
    els.stSim.className = `v ${srv.simulator?.enabled ? 'live' : srv.simulate ? 'warn' : 'off'}`;
    els.simToggle.checked = Boolean(srv.simulator?.enabled);
    els.footMode.textContent = `mode: ${srv.mode} • port ${window.location.port || '—'}`;
  }

  function renderState(s) {
    if (!s) return;
    lastState = s;
    totalSlots = s.totalSlots;
    els.stRound.textContent = `#${s.round}`;
    els.stRound.className = 'v';
    els.stRoundHint.textContent = `${s.claimedCount}/${s.totalSlots} claimed • ${s.stats.claims} total claims`;

    // draw button state: needs ≥1 claim, only while the round is open
    const full = s.claimedCount >= s.totalSlots;
    if (s.phase === 'drawing') {
      els.btnDraw.disabled = true;
      els.btnDraw.textContent = '🎯 Rolling…';
    } else if (s.phase === 'celebrating') {
      els.btnDraw.disabled = true;
      els.btnDraw.textContent = s.lastWinner ? `👑 @${s.lastWinner.uniqueId} won!` : '👑 Celebrating…';
    } else {
      els.btnDraw.disabled = s.claimedCount < 1;
      els.btnDraw.textContent = full ? '🎯 Draw winner — grid full!' : '🎯 Draw winner';
    }

    els.grid.innerHTML = '';
    for (let n = 1; n <= s.totalSlots; n++) {
      const entry = s.slots[n - 1];
      const div = document.createElement('div');
      if (entry && entry.userId) {
        div.className = 'mini taken';
        div.title = 'Click to release this slot';
        div.innerHTML = `<div class="n">${entry.nickname || entry.uniqueId}</div><div class="u">#${n} • tap to free</div>`;
        div.addEventListener('click', () => releaseSlot(n));
      } else {
        div.className = 'mini';
        div.innerHTML = `<div class="n">${n}</div><div class="u">open</div>`;
      }
      els.grid.appendChild(div);
    }
  }

  /* ── winner history ──────────────────────────────────────────────────── */
  const fmtWhen = (ts) => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  function dateRange(which) {
    const el = which === 'from' ? els.winFrom : els.winTo;
    if (!el.value) return '';
    const [y, m, d] = el.value.split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = which === 'from' ? new Date(y, m - 1, d, 0, 0, 0, 0) : new Date(y, m - 1, d, 23, 59, 59, 999);
    return String(dt.getTime());
  }

  function renderWinners(rows, total) {
    els.winnersBody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty';
      tr.innerHTML = '<td colspan="5">No winners match this filter.</td>';
      els.winnersBody.appendChild(tr);
    } else {
      rows.forEach((w) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="c-round">#${w.round}</td>
          <td class="c-slot">${w.slot}</td>
          <td class="c-winner" title="@${escapeHtml(w.uniqueId)}">👑 @${escapeHtml(w.uniqueId || w.nickname || 'winner')}</td>
          <td class="c-when">${fmtWhen(w.wonAt)}</td>
          <td class="c-by">${escapeHtml(w.source || 'draw')}</td>`;
        els.winnersBody.appendChild(tr);
      });
    }
    els.winTotal.textContent = total != null ? `${total} winner${total === 1 ? '' : 's'}` : '';
  }

  async function loadWinners() {
    try {
      const j = await apiGet('admin/winners', {
        round: els.winRound.value,
        from: dateRange('from'),
        to: dateRange('to'),
      });
      renderWinners(j.winners || [], j.total);
    } catch (err) {
      renderWinners([], null);
      els.winTotal.textContent = err.message === 'Invalid or missing admin key (x-admin-key header)' ? 'enter admin key' : '';
    }
  }

  function applyQuickFilter(kind) {
    els.winRound.value = '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (kind === 'today') {
      els.winFrom.value = iso(now);
      els.winTo.value = iso(now);
    } else if (kind === '7d') {
      const weekAgo = new Date(now.getTime() - 6 * 24 * 3600 * 1000);
      els.winFrom.value = iso(weekAgo);
      els.winTo.value = iso(now);
    } else {
      els.winFrom.value = '';
      els.winTo.value = '';
    }
    loadWinners();
  }

  els.btnWinRefresh.addEventListener('click', loadWinners);
  els.winRound.addEventListener('keydown', (e) => e.key === 'Enter' && loadWinners());
  [els.winFrom, els.winTo].forEach((el) => el.addEventListener('change', loadWinners));
  document.querySelectorAll('.quick-row [data-quick]').forEach((b) => b.addEventListener('click', () => applyQuickFilter(b.dataset.quick)));

  /* ── overlay ad ───────────────────────────────────────────────────────── */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('could not read file'));
      r.readAsDataURL(file);
    });
  }

  async function showAd() {
    const file = els.adFile.files && els.adFile.files[0];
    const url = els.adUrl.value.trim();
    if (!file && !url) return alert('Pick a media file (image / GIF / video) or paste a media URL first.');
    if (file && file.size > 48 * 1024 * 1024) return alert('File is larger than 48 MB — use a shorter clip or host it by URL.');
    const durationSec = Math.min(Math.max(parseFloat(els.adDuration.value) || 8, 2), 300);
    const body = {
      durationSec,
      caption: els.adCaption.value.trim(),
    };
    if (file) {
      body.dataUrl = await fileToDataUrl(file);
      if (file.type.startsWith('video/')) body.kind = 'video';
    } else {
      body.url = url;
      if (/\.(mp4|webm|mov|ogv)(\?|#|$)/i.test(url)) body.kind = 'video';
    }
    els.btnAdShow.disabled = true;
    try {
      const j = await api('admin/ad', body);
      log('system', `📣 Ad live on overlay — ${escapeHtml(j.kind)} for ${durationSec}s`);
      els.adFile.value = '';
    } catch { /* logged */ } finally {
      els.btnAdShow.disabled = false;
    }
  }

  async function stopAd() {
    try {
      await api('admin/ad/stop', {});
      log('system', '📣 Overlay ad dismissed');
    } catch { /* logged */ }
  }

  els.btnAdShow.addEventListener('click', showAd);
  els.btnAdStop.addEventListener('click', stopAd);

  /* ── actions ──────────────────────────────────────────────────────────── */
  async function resetRound() {
    try {
      const j = await api('reset', { source: 'admin-panel' });
      log('system', `🔄 ${escapeHtml(j.message)}`);
    } catch { /* logged */ }
  }

  async function drawWinner() {
    try {
      const j = await api('admin/draw', { source: 'admin-panel' });
      log('system', `🎯 ${escapeHtml(j.message || 'Draw started')}`);
    } catch { /* logged */ }
  }

  async function releaseSlot(slot) {
    if (!confirm(`Release slot #${slot}?`)) return;
    try {
      await api('admin/release', { slot });
      log('system', `🔓 Slot #${slot} released`);
    } catch { /* logged */ }
  }

  async function award() {
    const slot = parseInt(els.awardSlot.value, 10);
    const username = els.awardUser.value.trim().replace(/^@/, '');
    if (!slot || !username) return alert('Enter a slot number and a username.');
    try {
      const j = await api('admin/claim', { slot, username });
      log('system', `🎁 Awarded slot #${j.slot} to @${escapeHtml(username)}`);
      els.awardSlot.value = ''; els.awardUser.value = '';
    } catch { /* logged */ }
  }

  async function injectChat() {
    const comment = els.injComment.value.trim();
    if (!comment) return;
    try {
      await api('simulate/chat', { username: els.injUser.value.trim() || undefined, comment }, false);
      els.injComment.value = '';
    } catch { /* logged */ }
  }

  async function injectGift() {
    try {
      await api('simulate/gift', {
        username: els.injGiftUser.value.trim() || undefined,
        giftName: els.injGift.value.trim() || 'Rose',
        count: parseInt(els.injGiftCount.value, 10) || 1,
      }, false);
    } catch { /* logged */ }
  }

  els.btnReset.addEventListener('click', resetRound);
  els.btnDraw.addEventListener('click', drawWinner);
  els.btnAward.addEventListener('click', award);
  els.btnInjChat.addEventListener('click', injectChat);
  els.btnInjGift.addEventListener('click', injectGift);
  els.simToggle.addEventListener('change', async () => {
    try {
      await api('admin/sim', { enabled: els.simToggle.checked });
      log('system', `🤖 Simulator ${els.simToggle.checked ? 'started' : 'stopped'}`);
    } catch { els.simToggle.checked = !els.simToggle.checked; }
  });
  [els.injComment, els.injUser].forEach((el) => el.addEventListener('keydown', (e) => e.key === 'Enter' && injectChat()));

  /* ── socket events ────────────────────────────────────────────────────── */
  socket.on('connect', () => {
    els.connDot.className = 'dot ok';
    els.connLabel.textContent = 'live';
  });
  socket.on('disconnect', () => {
    els.connDot.className = 'dot bad';
    els.connLabel.textContent = 'disconnected';
  });

  socket.on('state', (s) => { renderState(s); });
  socket.on('server', renderServer);
  socket.on('activity', (ev) => {
    const u = `@${escapeHtml(ev.user?.uniqueId || 'viewer')}`;
    switch (ev.type) {
      case 'claim': log('claim', `🔒 <b>${u}</b> locked <b>#${ev.slot}</b> <span style="color:var(--muted)">(${escapeHtml(ev.source)})</span>`); break;
      case 'rejected': log('rejected', `⌛ ${u} late for #${ev.slot}`); break;
      case 'duplicate': log('duplicate', `🙃 ${u} already owns #${ev.slot}`); break;
      case 'invalid': log('rejected', `❓ ${u} → "${escapeHtml(ev.comment || '')}" is not a slot`); break;
      case 'gift': log('gift', `🎁 <b>${u}</b> sent <b>${escapeHtml(ev.giftName)}</b> ×${ev.repeatCount}`); break;
      case 'join': log('system', `👋 ${u} joined`); break;
      case 'released': log('system', `🔓 Slot #${ev.slot} released`); break;
      case 'grid-full': log('system', `🔥 Grid complete — lucky number coming up!`); break;
      case 'busy': log('rejected', `⏳ ${u} typed during the draw — round closed`); break;
      case 'draw-started': log('system', `🎯 Keno draw started — ${ev.poolSize ?? '?'} slots in the pool`); break;
      case 'draw-result': log('claim', `👑 <b>@${escapeHtml(ev.winner?.uniqueId || 'winner')}</b> WON slot <b>#${ev.slot}</b>!`); break;
      case 'ad': log('system', `📣 Overlay ad — ${escapeHtml(ev.kind || 'media')} for ${Math.round((ev.durationMs || 0) / 1000)}s`); break;
      case 'reset': log('system', `🔄 New round #${ev.round} started`); break;
      default: break;
    }
  });

  /* keep the winner table current after every completed draw */
  socket.on('draw-result', () => { setTimeout(loadWinners, 400); });

  /* initial status fetch (in case 'server' event came before binding) */
  fetch(`/api/status${Q}`).then((r) => r.json()).then(renderServer).catch(() => {});
  loadWinners();
})();
