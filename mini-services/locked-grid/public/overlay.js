/* ═══════════════════════════════════════════════════════════════════════
   LOCKED GRID LOTTERY — overlay client
   Renders the 1080x1920 overlay and syncs with the game server via socket.io.
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── connection setup ──────────────────────────────────────────────────
     Standalone (VPS / OBS direct): io()  ->  same origin, default path.
     Sandbox gateway: page URL contains ?XTransformPort=<port>  ->
     socket.io must carry the same query so the gateway routes it.        */
  const params = new URLSearchParams(location.search);
  const gatewayPort = params.get('XTransformPort');
  const socket = gatewayPort
    ? io(`/?XTransformPort=${gatewayPort}`, { transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 })
    : io({ reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });

  const $ = (id) => document.getElementById(id);
  const stateEls = {
    roundNum: $('round-num'),
    timer: $('round-timer'),
    slotsLeft: $('slots-left'),
    slotsLeftLabel: $('slots-left-label'),
    claimedCount: $('claimed-count'),
    grid: $('grid'),
    feed: $('feed'),
    tickerText: $('ticker-text'),
    toasts: $('toasts'),
    banner: $('reconnect-banner'),
    flash: $('round-flash'),
    flashNum: $('round-flash-num'),
    soundBtn: $('sound-toggle'),
    drawStage: $('draw-stage'),
    drawLabel: $('draw-label'),
    drawNum: $('draw-num'),
    drawPool: $('draw-pool'),
    drawSub: $('draw-sub'),
    drawWinner: $('draw-winner'),
    drawUsername: $('draw-username'),
    confetti: $('confetti'),
    /* overlay ad */
    adStage: $('ad-stage'),
    adCard: $('ad-card'),
    adImage: $('ad-image'),
    adVideo: $('ad-video'),
    adCaption: $('ad-caption'),
    adBar: $('ad-progress-bar'),
  };

  let latestState = null;
  const cards = [];   // slot -> card element
  const feedRows = [];

  /* ── build the 10 grid cards + feed rows once ───────────────────────── */
  function buildUI(totalSlots) {
    stateEls.grid.innerHTML = '';
    stateEls.feed.innerHTML = '';
    cards.length = 0;
    feedRows.length = 0;

    for (let n = 1; n <= totalSlots; n++) {
      const card = document.createElement('div');
      card.className = 'card open';
      card.id = `card-${n}`;
      card.innerHTML = `
        <div class="card-shine"></div>
        <div class="slot-badge">#${n}</div>
        <div class="winner-ribbon"></div>
        <div class="card-open-content">
          <div class="big-number">${n}</div>
          <div class="available-chip">AVAILABLE</div>
        </div>
        <div class="card-locked-content">
          <div class="avatar-ring">
            <img class="avatar" alt="" referrerpolicy="no-referrer" />
            <div class="avatar-fallback"></div>
          </div>
          <div class="locked-info">
            <div class="locked-name"></div>
            <div class="locked-meta">
              <span class="locked-pill">🔒 LOCKED</span>
              <span class="locked-time"></span>
            </div>
          </div>
        </div>`;
      stateEls.grid.appendChild(card);
      cards[n] = card;

      const row = document.createElement('div');
      row.className = 'feed-row';
      row.id = `feed-${n}`;
      row.innerHTML = `
        <div class="feed-slot">#${n}</div>
        <div class="feed-avatar-wrap"><img alt="" referrerpolicy="no-referrer" /><div class="feed-fallback"></div></div>
        <div class="feed-name">waiting…</div>
        <div class="feed-time"></div>`;
      stateEls.feed.appendChild(row);
      feedRows[n] = row;
    }
  }

  /* ── avatar helpers (profile pics often blocked/missing -> initials) ── */
  function hueFor(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function setAvatar(container, url, name, userId, size) {
    const img = container.querySelector('img');
    const fb = container.querySelector('.avatar-fallback, .feed-fallback');
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const hue = (userId && hueFor(userId)) || hueFor(name || 'x');
    fb.textContent = initial;
    fb.style.background = `linear-gradient(140deg, hsl(${hue}, 70%, 46%), hsl(${(hue + 60) % 360}, 70%, 34%))`;
    fb.style.fontSize = `${Math.round(size * 0.42)}px`;
    if (url) {
      img.src = url;
      img.style.display = 'block';
      fb.style.display = 'none';
      img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        fb.style.display = 'flex';
      };
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      fb.style.display = 'flex';
    }
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

  /* ── full state render ───────────────────────────────────────────────── */
  function renderState(s) {
    if (!s) return;
    if (!cards[1] || cards.length - 1 !== s.totalSlots) buildUI(s.totalSlots);
    latestState = s;

    stateEls.roundNum.textContent = s.round;
    const left = s.totalSlots - s.claimedCount;
    stateEls.slotsLeft.textContent = left;
    stateEls.slotsLeftLabel.textContent = left === 1 ? 'SLOT' : 'SLOTS';
    stateEls.claimedCount.textContent = `${s.claimedCount} / ${s.totalSlots}`;

    s.slots.forEach((entry) => {
      const n = entry.slot;
      const card = cards[n];
      const row = feedRows[n];
      if (entry.locked === false || !entry.userId) {
        card.className = 'card open';
        row.className = 'feed-row';
        row.querySelector('.feed-name').textContent = 'waiting…';
        row.querySelector('.feed-time').textContent = '';
        row.querySelector('img').removeAttribute('src');
        row.querySelector('img').style.display = 'none';
        const fb = row.querySelector('.feed-fallback');
        fb.style.display = 'none';
        fb.textContent = '';
      } else {
        card.className = 'card locked';
        card.querySelector('.locked-name').textContent = entry.nickname || entry.uniqueId || 'Viewer';
        card.querySelector('.locked-time').textContent = fmtTime(entry.lockedAt);
        setAvatar(card.querySelector('.avatar-ring'), entry.profilePictureUrl, entry.nickname || entry.uniqueId, entry.userId, 100);
        row.className = 'feed-row filled';
        row.querySelector('.feed-name').textContent = `@${entry.uniqueId || entry.nickname}`;
        row.querySelector('.feed-time').textContent = fmtTime(entry.lockedAt);
        setAvatar(row.querySelector('.feed-avatar-wrap'), entry.profilePictureUrl, entry.nickname || entry.uniqueId, entry.userId, 36);
      }
    });

    applyLastWinner(s.lastWinner);
    syncDrawPhase(s);
    startTimer(s.roundStartedAt);
  }

  /* ── last winner: 👑 username ribbon on top of the winning number ───── */
  function applyLastWinner(lw) {
    for (let n = 1; n < cards.length; n++) {
      const card = cards[n];
      if (!card) continue;
      const ribbon = card.querySelector('.winner-ribbon');
      const isWinner = lw && lw.slot === n;
      card.classList.toggle('last-winner', Boolean(isWinner));
      if (ribbon) {
        if (isWinner) {
          ribbon.textContent = `👑 @${lw.uniqueId || lw.nickname || 'winner'}`;
          ribbon.style.display = 'flex';
        } else {
          ribbon.style.display = 'none';
        }
      }
      const row = feedRows[n];
      if (row) row.classList.toggle('winner-row', Boolean(isWinner));
    }
  }

  /* ── round timer ─────────────────────────────────────────────────────── */
  let timerStart = Date.now();
  function startTimer(at) {
    timerStart = at || Date.now();
    tickTimer();
  }
  function tickTimer() {
    const s = Math.max(0, Math.floor((Date.now() - timerStart) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    stateEls.timer.textContent = `${mm}:${ss}`;
  }
  setInterval(tickTimer, 1000);

  /* ── toasts & ticker ─────────────────────────────────────────────────── */
  function toast(html, cls = '') {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.innerHTML = html;
    stateEls.toasts.appendChild(el);
    while (stateEls.toasts.children.length > 3) stateEls.toasts.firstChild.remove();
    setTimeout(() => el.remove(), 3600);
  }

  function avatarImg(url, name, userId, size) {
    if (!url) return '';
    return `<img class="t-avatar" src="${url}" style="width:${size}px;height:${size}px" referrerpolicy="no-referrer" onerror="this.remove()" />`;
  }

  function setTicker(html) {
    const t = stateEls.tickerText;
    t.innerHTML = html;
    t.classList.remove('flip');
    void t.offsetWidth;
    t.classList.add('flip');
  }

  const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ── sound engine (WebAudio, zero assets — offline-safe & OBS-friendly) ──
     Layered oscillator + filtered-noise SFX. Autoplay-policy compatible:
     the context is created/resumed lazily and on the first user gesture.   */
  let soundOn = false;
  let audioCtx = null;
  let masterGain = null;
  let noiseBuf = null;
  try {
    const forced = params.get('sound');
    if (forced === '1') soundOn = true;
    else if (forced !== '0') soundOn = localStorage.getItem('lgl_sound') === '1';
  } catch { /* storage blocked */ }

  function ac() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.9;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  /* browsers suspend AudioContext until a gesture — OBS allows autoplay,
     regular preview tabs unlock on the first click/keypress anywhere */
  const unlockAudio = () => { if (soundOn) ac(); };
  window.addEventListener('pointerdown', unlockAudio, { once: false });
  window.addEventListener('keydown', unlockAudio, { once: false });

  function updateSoundBtn() {
    stateEls.soundBtn.textContent = soundOn ? '🔊' : '🔇';
    stateEls.soundBtn.classList.toggle('on', soundOn);
  }
  stateEls.soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('lgl_sound', soundOn ? '1' : '0'); } catch { /* noop */ }
    updateSoundBtn();
    if (soundOn) sfxToggle();
  });
  updateSoundBtn();

  /* one shared white-noise buffer (cheap, reusable) */
  function noiseSrc() {
    const ctx = ac();
    if (!ctx) return null;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    return src;
  }

  /** oscillator tone with optional pitch slide + per-note gain envelope */
  function tone({ freq, t0 = 0, dur = 0.15, gain = 0.16, type = 'sine', slideTo = null, attack = 0.015 }) {
    const ctx = ac();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const at = ctx.currentTime + t0;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(masterGain);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** filtered noise burst (ticks, whooshes, shimmer) with optional sweep */
  function hiss({ t0 = 0, dur = 0.2, gain = 0.1, filter = 'highpass', freq = 1200, sweepTo = null, q = 0.8 }) {
    const ctx = ac();
    if (!ctx) return;
    const src = noiseSrc();
    if (!src) return;
    const bq = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const at = ctx.currentTime + t0;
    bq.type = filter;
    bq.frequency.setValueAtTime(freq, at);
    if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), at + dur);
    bq.Q.value = q;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bq).connect(g).connect(masterGain);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  const canPlay = () => soundOn && ac();
  const safe = (fn) => { try { if (canPlay()) fn(); } catch { /* audio blocked */ } };

  /* ── the SFX library ─────────────────────────────────────────────────── */
  const sfxToggle = () => safe(() => {
    tone({ freq: 880, dur: 0.09, gain: 0.12, type: 'triangle' });
    tone({ freq: 1174.7, t0: 0.08, dur: 0.12, gain: 0.12, type: 'triangle' });
  });

  /** slot locked — juicy "pop + click" */
  const sfxLock = () => safe(() => {
    tone({ freq: 420, slideTo: 940, dur: 0.1, gain: 0.22, type: 'triangle' });
    tone({ freq: 1300, t0: 0.06, dur: 0.07, gain: 0.08, type: 'sine' });
    hiss({ dur: 0.05, gain: 0.07, filter: 'highpass', freq: 3200 });
  });

  /** claim rejected — soft low thud */
  const sfxReject = () => safe(() => {
    tone({ freq: 196, slideTo: 130, dur: 0.16, gain: 0.12, type: 'square' });
    hiss({ dur: 0.08, gain: 0.04, filter: 'lowpass', freq: 500 });
  });

  /** gift received — sparkle arpeggio + shimmer */
  const sfxGift = () => safe(() => {
    [1318.5, 1760, 2349.3].forEach((f, i) => tone({ freq: f, t0: i * 0.07, dur: 0.14, gain: 0.13, type: 'sine' }));
    hiss({ t0: 0.02, dur: 0.3, gain: 0.05, filter: 'highpass', freq: 5200 });
  });

  /** keno roll tick — mechanical ball click; pitch varies with the number */
  const sfxTick = (n = 0) => safe(() => {
    hiss({ dur: 0.032, gain: 0.075, filter: 'bandpass', freq: 1700 + (n % 6) * 260, q: 2.4 });
    tone({ freq: 1500 + (n % 5) * 220, dur: 0.045, gain: 0.05, type: 'square' });
  });

  /** winner fanfare — big ascending sting */
  const sfxWinner = () => safe(() => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ freq: f, t0: i * 0.09, dur: 0.3, gain: 0.17, type: 'triangle' });
      tone({ freq: f * 2, t0: i * 0.09, dur: 0.22, gain: 0.05, type: 'sine' });
    });
    hiss({ dur: 0.55, gain: 0.06, filter: 'bandpass', freq: 900, sweepTo: 4200, q: 1.4 });
    [783.99, 1046.5, 1318.5, 1568].forEach((f, i) => tone({ freq: f, t0: 0.42 + i * 0.1, dur: 0.4, gain: 0.15, type: 'triangle' }));
  });

  /** new round — rising whoosh */
  const sfxReset = () => safe(() => {
    hiss({ dur: 0.42, gain: 0.1, filter: 'lowpass', freq: 420, sweepTo: 3800 });
    tone({ freq: 300, slideTo: 920, dur: 0.32, gain: 0.1, type: 'sine' });
    [523.25, 392, 523.25, 783.99].forEach((f, i) => tone({ freq: f, t0: 0.3 + i * 0.07, dur: 0.16, gain: 0.12, type: 'triangle' }));
  });

  /** overlay ad appears — attention swoosh */
  const sfxAd = () => safe(() => {
    hiss({ dur: 0.3, gain: 0.09, filter: 'bandpass', freq: 700, sweepTo: 3400, q: 1.2 });
    tone({ freq: 660, slideTo: 990, dur: 0.18, gain: 0.13, type: 'triangle' });
    tone({ freq: 1320, t0: 0.16, dur: 0.16, gain: 0.09, type: 'sine' });
  });

  /** join / small blips */
  const chime = (freqs, dur = 0.12) => safe(() => {
    freqs.forEach((f, i) => tone({ freq: f, t0: i * 0.09, dur, gain: 0.13, type: 'triangle' }));
  });

  /* ── winner draw (keno) UI ───────────────────────────────────────────── */
  let drawUI = null; // { mode: 'rolling' | 'winner', localTimer, tickCount, pool }

  function setDrawNum(n) {
    const el = stateEls.drawNum;
    el.textContent = String(n);
    // re-trigger the roll animation on every number swap
    el.classList.remove('roll');
    void el.offsetWidth;
    el.classList.add('roll');
  }

  function showDrawStage() {
    stateEls.drawStage.classList.remove('hidden');
    stateEls.drawStage.classList.remove('celebrate');
    stateEls.drawStage.classList.add('rolling');
    stateEls.drawWinner.classList.add('hidden');
    stateEls.drawLabel.textContent = '🎯 DRAWING A WINNER';
  }

  function hideDrawStage() {
    stateEls.drawStage.classList.add('hidden');
    stateEls.drawStage.classList.remove('rolling', 'celebrate');
    if (drawUI?.localTimer) { clearInterval(drawUI.localTimer); }
    drawUI = null;
  }

  function renderPool(pool) {
    stateEls.drawPool.innerHTML = '';
    pool.forEach((n) => {
      const b = document.createElement('span');
      b.className = 'pool-ball';
      b.textContent = String(n);
      b.dataset.n = String(n);
      stateEls.drawPool.appendChild(b);
    });
  }

  function hitBall(n) {
    const prev = stateEls.drawPool.querySelector('.pool-ball.hit');
    if (prev) prev.classList.remove('hit');
    const ball = stateEls.drawPool.querySelector(`.pool-ball[data-n="${n}"]`);
    if (ball) ball.classList.add('hit');
  }

  function spawnConfetti(count = 46) {
    const colors = ['#25f4ee', '#fe2c55', '#ffc53d', '#ff8a5c', '#7df9ff', '#ffffff', '#c084fc'];
    stateEls.confetti.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = `${2.4 + Math.random() * 2.6}s`;
      p.style.animationDelay = `${Math.random() * 1.8}s`;
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      p.style.width = `${10 + Math.random() * 8}px`;
      p.style.height = `${20 + Math.random() * 14}px`;
      stateEls.confetti.appendChild(p);
    }
  }

  function setWinnerAvatar(ring, url, name, userId) {
    const img = ring.querySelector('.draw-avatar');
    const fb = ring.querySelector('.draw-avatar-fallback');
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const hue = (userId && hueFor(userId)) || hueFor(name || 'x');
    fb.textContent = initial;
    fb.style.background = `linear-gradient(140deg, hsl(${hue}, 70%, 46%), hsl(${(hue + 60) % 360}, 70%, 34%))`;
    if (url) {
      img.src = url;
      img.style.display = 'block';
      fb.style.display = 'none';
      ring.classList.add('has-img');
      img.onerror = () => {
        img.removeAttribute('src');
        img.style.display = 'none';
        fb.style.display = 'flex';
        ring.classList.remove('has-img');
      };
    } else {
      img.removeAttribute('src');
      img.style.display = 'none';
      fb.style.display = 'flex';
      ring.classList.remove('has-img');
    }
  }

  function startRollUI(pool) {
    if (drawUI?.mode === 'winner') return; // celebration wins
    if (drawUI?.localTimer) clearInterval(drawUI.localTimer);
    const p = Array.isArray(pool) && pool.length ? pool : [1];
    drawUI = { mode: 'rolling', localTimer: null, tickCount: 0, pool: p };
    showDrawStage();
    renderPool(p);
    stateEls.drawSub.textContent = 'PICKING THE LUCKY NUMBER…';
    /* The keno roll runs ENTIRELY client-side: the ball starts spinning the
       moment the stage appears and can NEVER get stuck on a placeholder.
       'draw-result' is the only authoritative moment (same winner for all). */
    const spin = () => {
      const n = p[Math.floor(Math.random() * p.length)];
      setDrawNum(n);
      hitBall(n);
      drawUI.tickCount += 1;
      if (drawUI.tickCount % 6 === 0) sfxTick(n);
    };
    spin();
    drawUI.localTimer = setInterval(spin, 110);
  }

  function showWinnerUI(winner, celebrateMs) {
    if (drawUI?.localTimer) { clearInterval(drawUI.localTimer); }
    drawUI = { mode: 'winner', localTimer: null, tickCount: 0 };
    stateEls.drawStage.classList.remove('hidden', 'rolling');
    stateEls.drawStage.classList.add('celebrate');
    stateEls.drawLabel.textContent = `🎉 ROUND ${winner.round ?? latestState?.round ?? ''} WINNER`;
    stateEls.drawNum.classList.remove('roll');
    stateEls.drawNum.textContent = String(winner.slot);
    stateEls.drawWinner.classList.remove('hidden');
    stateEls.drawUsername.textContent = `@${winner.uniqueId || winner.nickname || 'winner'}`;
    setWinnerAvatar(stateEls.drawWinner.querySelector('.draw-avatar-ring'), winner.profilePictureUrl, winner.nickname || winner.uniqueId, winner.userId);
    stateEls.drawPool.innerHTML = '';
    stateEls.drawSub.textContent = celebrateMs ? 'NEW ROUND STARTING IN A FEW SECONDS…' : 'NEW ROUND STARTING SOON…';
    spawnConfetti();
    sfxWinner();
  }

  /** Late joiners: rebuild the current phase from the state snapshot alone. */
  function syncDrawPhase(s) {
    if (s.phase === 'drawing' && (!drawUI || drawUI.mode !== 'rolling')) {
      const pool = (s.slots || []).filter((e) => e && e.userId).map((e) => e.slot);
      startRollUI(pool); // rolls locally until 'draw-result' arrives
    } else if (s.phase === 'celebrating' && s.lastWinner && (!drawUI || drawUI.mode !== 'winner')) {
      showWinnerUI(s.lastWinner, null);
    } else if (s.phase === 'open' && drawUI) {
      hideDrawStage();
    }
  }

  /* ── overlay ad (image / gif / short video) ─────────────────────────── */
  let adTimer = null;

  function hideAd() {
    if (adTimer) { clearTimeout(adTimer); adTimer = null; }
    const stage = stateEls.adStage;
    if (stage.classList.contains('hidden')) return;
    stage.classList.add('closing');
    try { stateEls.adVideo.pause(); } catch { /* noop */ }
    setTimeout(() => {
      stage.classList.add('hidden');
      stage.classList.remove('closing');
      stateEls.adImage.classList.add('hidden');
      stateEls.adImage.removeAttribute('src');
      stateEls.adVideo.classList.add('hidden');
      stateEls.adVideo.removeAttribute('src');
      stateEls.adBar.classList.remove('running');
      stateEls.adBar.style.transition = 'none';
      stateEls.adBar.style.transform = 'scaleX(1)';
    }, 300);
  }

  function showAd({ url, kind, caption, durationMs } = {}) {
    if (!url) return;
    if (adTimer) { clearTimeout(adTimer); adTimer = null; }
    const stage = stateEls.adStage;
    stage.classList.remove('hidden', 'closing');
    // restart the pop-in animation
    stateEls.adCard.style.animation = 'none';
    void stateEls.adCard.offsetWidth;
    stateEls.adCard.style.animation = '';

    const dur = Math.max(2000, Number(durationMs) || 8000);
    if (kind === 'video') {
      stateEls.adImage.classList.add('hidden');
      const v = stateEls.adVideo;
      v.classList.remove('hidden');
      v.src = url;
      /* try with sound first (OBS allows autoplay); browsers without a
         gesture fall back to muted autoplay — the ad always plays */
      v.muted = false;
      v.volume = 1;
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { v.muted = true; v.play().catch(() => {}); });
      }
      v.onended = () => hideAd();
    } else {
      stateEls.adVideo.classList.add('hidden');
      try { stateEls.adVideo.pause(); } catch { /* noop */ }
      stateEls.adImage.src = url;
      stateEls.adImage.classList.remove('hidden');
    }
    if (caption) {
      stateEls.adCaption.textContent = String(caption);
      stateEls.adCaption.classList.remove('hidden');
    } else {
      stateEls.adCaption.classList.add('hidden');
    }
    /* progress drain */
    const bar = stateEls.adBar;
    bar.classList.remove('running');
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${dur}ms linear`;
    bar.style.transform = 'scaleX(0)';
    bar.classList.add('running');
    adTimer = setTimeout(hideAd, dur);
    sfxAd();
  }

  socket.on('ad:show', showAd);
  socket.on('ad:hide', hideAd);

  /* ── socket events ───────────────────────────────────────────────────── */
  socket.on('connect', () => stateEls.banner.classList.add('hidden'));
  socket.on('disconnect', () => stateEls.banner.classList.remove('hidden'));
  socket.on('state', renderState);

  socket.on('slot-locked', ({ slot, entry }) => {
    const card = cards[slot];
    if (card) {
      card.classList.remove('just-locked');
      void card.offsetWidth;
      card.classList.add('just-locked');
      setTimeout(() => card.classList.remove('just-locked'), 1600);
    }
    const row = feedRows[slot];
    if (row) {
      row.classList.remove('just-locked');
      void row.offsetWidth;
      row.classList.add('just-locked');
      setTimeout(() => row.classList.remove('just-locked'), 900);
    }
    sfxLock();
    toast(`${avatarImg(entry.profilePictureUrl, entry.nickname, entry.userId, 44)} <span>@${escapeHtml(entry.uniqueId || entry.nickname)} locked <b>#${slot}</b>!</span>`);
  });

  socket.on('round-reset', ({ round }) => {
    hideDrawStage();
    stateEls.flashNum.textContent = round;
    stateEls.flash.classList.remove('hidden');
    // restart CSS animations
    const inner = stateEls.flash.querySelector('.round-flash-inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';
    setTimeout(() => stateEls.flash.classList.add('hidden'), 2600);
    sfxReset();
  });

  socket.on('draw-started', ({ pool }) => {
    startRollUI(pool || []);
  });

  socket.on('draw-tick', () => {
    /* Rolling numbers are animated client-side, so a dropped tick stream can
       never freeze the ball on a placeholder. Server ticks are intentionally
       not rendered — 'draw-result' decides the actual winner. If the roll UI
       died somehow, this event revives it. */
    if (!drawUI || drawUI.mode !== 'rolling') {
      startRollUI(latestState ? latestState.slots.filter((e) => e && e.userId).map((e) => e.slot) : []);
    }
  });

  socket.on('draw-result', ({ winner, celebrateMs }) => {
    showWinnerUI(winner || {}, celebrateMs);
    if (winner?.uniqueId) {
      toast(`👑 <span><b>@${escapeHtml(winner.uniqueId)}</b> wins round ${winner.round ?? ''} — number <b>#${winner.slot}</b>!</span>`);
      setTicker(`👑 <b>@${escapeHtml(winner.uniqueId)}</b> won the draw — lucky number <b class="hl">#${winner.slot}</b>!`);
    }
  });

  socket.on('activity', (ev) => {
    switch (ev.type) {
      case 'claim':
        setTicker(`✅ <b>@${escapeHtml(ev.user?.uniqueId)}</b> locked slot <b class="hl">#${ev.slot}</b>`);
        break;
      case 'rejected':
        setTicker(`⌛ <b>@${escapeHtml(ev.user?.uniqueId)}</b> was too late — slot <b>#${ev.slot}</b> already taken`);
        break;
      case 'duplicate':
        setTicker(`🙃 <b>@${escapeHtml(ev.user?.uniqueId)}</b> already holds slot <b>#${ev.slot}</b> — one per viewer!`);
        break;
      case 'invalid':
        setTicker(`❓ <b>@${escapeHtml(ev.user?.uniqueId)}</b> — pick a number between 1 and ${latestState?.totalSlots ?? 10}`);
        break;
      case 'gift':
        setTicker(`🎁 <b>@${escapeHtml(ev.user?.uniqueId)}</b> sent <b class="hl">${escapeHtml(ev.giftName)}</b> ×${ev.repeatCount}!`);
        toast(`🎁 <span><b>@${escapeHtml(ev.user?.uniqueId)}</b> sent ${escapeHtml(ev.giftName)} ×${ev.repeatCount}</span>`, 'gift');
        sfxGift();
        break;
      case 'rejected':
      case 'duplicate':
        sfxReject();
        break;
      case 'ad':
        setTicker(`📣 <b>AD</b> is live on the overlay — thanks for watching!`);
        break;
      case 'join':
        setTicker(`👋 <b>@${escapeHtml(ev.user?.uniqueId)}</b> joined the stream`);
        break;
      case 'released':
        setTicker(`🔓 Slot <b>#${ev.slot}</b> was released by the host`);
        break;
      case 'grid-full':
        setTicker(`🔥 GRID COMPLETE — picking the lucky number soon!`);
        break;
      case 'busy':
        setTicker(`⏳ <b>@${escapeHtml(ev.user?.uniqueId)}</b> — draw in progress, next round starts in a moment!`);
        break;
      case 'draw-started':
        setTicker(`🎯 Drawing the lucky number from <b>${ev.poolSize ?? '?'}</b> slots…`);
        break;
      case 'draw-result':
        setTicker(`👑 <b>@${escapeHtml(ev.winner?.uniqueId || 'winner')}</b> won — lucky number <b class="hl">#${ev.slot}</b>!`);
        break;
      case 'reset':
        setTicker(`🔄 Round <b>${ev.round}</b> — grid is open, pick a number!`);
        break;
      default:
        break;
    }
  });

  socket.on('activity:history', (events) => {
    const last = events && events[events.length - 1];
    if (last) {
      const map = {
        claim: `✅ <b>@${escapeHtml(last.user?.uniqueId)}</b> locked slot <b class="hl">#${last.slot}</b>`,
        gift: `🎁 <b>@${escapeHtml(last.user?.uniqueId)}</b> sent <b class="hl">${escapeHtml(last.giftName)}</b> ×${last.repeatCount}!`,
      };
      if (map[last.type]) setTicker(map[last.type]);
    }
  });

  /* ── admin keybinding: Shift+R resets the round (key from ?key= or localStorage) ── */
  window.addEventListener('keydown', (e) => {
    if (e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      const key = params.get('key') || (() => { try { return localStorage.getItem('lgl_admin_key'); } catch { return null; } })();
      if (!key) return;
      const base = gatewayPort ? `/?XTransformPort=${gatewayPort}` : '';
      fetch(`${base}/api/reset`, { method: 'POST', headers: { 'x-admin-key': key, 'content-type': 'application/json' }, body: '{}' })
        .then((r) => (r.ok ? console.log('[lgl] round reset') : console.warn('[lgl] reset failed', r.status)))
        .catch(() => {});
    }
  });

  /* ── resilient state polling fallback (if socket is blocked) ─────────── */
  setInterval(() => {
    if (socket.connected) return;
    const base = gatewayPort ? `/?XTransformPort=${gatewayPort}` : '';
    fetch(`${base}/api/state`)
      .then((r) => r.json())
      .then((j) => j.ok && renderState(j.state))
      .catch(() => {});
  }, 5000);
})();
