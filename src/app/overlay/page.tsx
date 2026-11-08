'use client';

/* ═══════════════════════════════════════════════════════════════════════
   LOCKED GRID LOTTERY — OBS overlay (fixed 1080 × 1920 canvas)
   Same-origin page: works through the preview gateway, direct access and
   the standalone VPS deployment alike. Real-time via socket.io polling
   proxied at /socket.io, plus an HTTP state-polling safety net.
   ═══════════════════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import './overlay.css';

type SlotEntry = {
  slot: number;
  locked?: boolean;
  userId?: string;
  uniqueId?: string;
  nickname?: string;
  profilePictureUrl?: string | null;
  lockedAt?: number;
};
type LastWinner = {
  round: number;
  slot: number;
  userId?: string | null;
  uniqueId: string;
  nickname?: string;
  profilePictureUrl?: string | null;
  wonAt: number;
};
type GameState = {
  round: number;
  roundStartedAt: number;
  totalSlots: number;
  claimedCount: number;
  phase: 'open' | 'drawing' | 'celebrating';
  phaseStartedAt?: number;
  lastWinner: LastWinner | null;
  slots: SlotEntry[];
  stats: { claims: number; rejectedTaken: number; rejectedDuplicate: number; gifts: number; resets: number };
  completedRounds: number;
};
type ActivityEvent = {
  id: string;
  type: string;
  at: number;
  slot?: number;
  user?: { uniqueId?: string; nickname?: string };
  giftName?: string;
  repeatCount?: number;
  comment?: string;
  round?: number;
};

const escapeHtml = (s: string | undefined) =>
  String(s ?? '').replace(/[&<>"']/g, (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });

function hueFor(str: string) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

/* avatar with graceful initials fallback (profile pics are often blocked) */
function Avatar({ url, name, userId, className, fontSize }: {
  url?: string | null; name: string; userId?: string; className: string; fontSize: number;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const hue = (userId && hueFor(userId)) || hueFor(name || 'x');
  const showImg = Boolean(url) && !failed;
  return (
    <>
      {showImg && (
        <img className={className} src={url as string} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      )}
      <span
        className={className === 'avatar' ? 'avatar-fallback' : 'feed-fallback'}
        style={{
          display: showImg ? 'none' : 'flex',
          background: `linear-gradient(140deg, hsl(${hue}, 70%, 46%), hsl(${(hue + 60) % 360}, 70%, 34%))`,
          fontSize: `${fontSize}px`,
        }}
      >
        {initial}
      </span>
    </>
  );
}

export default function OverlayPage() {
  const [state, setState] = useState<GameState | null>(null);
  const [tickerHtml, setTickerHtml] = useState('Waiting for chat activity…');
  const [toasts, setToasts] = useState<Array<{ key: number; html: string; cls: string }>>([]);
  const [flash, setFlash] = useState<{ round: number; key: number } | null>(null);
  const [banner, setBanner] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [pulses, setPulses] = useState<Record<number, number>>({}); // slot -> timestamp
  const [now, setNow] = useState(0);

  /* ── winner draw (keno) UI state ───────────────────────────────────── */
  const [drawMode, setDrawMode] = useState<'idle' | 'rolling' | 'winner'>('idle');
  const [drawNumber, setDrawNumber] = useState<string | number>('?');
  const [drawPool, setDrawPool] = useState<number[]>([]);
  const [winnerShow, setWinnerShow] = useState<LastWinner | null>(null);
  const [confettiKey, setConfettiKey] = useState(0);
  const drawModeRef = useRef<'idle' | 'rolling' | 'winner'>('idle');
  const localTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickCountRef = useRef(0);

  /* ── overlay ad (image / gif / short video) state ──────────────────── */
  type AdPayload = { url: string; kind: 'image' | 'video'; caption: string; durationMs: number; key: number };
  const [ad, setAd] = useState<AdPayload | null>(null);
  const [adClosing, setAdClosing] = useState(false);
  const adEndRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adBarRef = useRef<HTMLSpanElement | null>(null);
  const adVideoRef = useRef<HTMLVideoElement | null>(null);
  const adKeyRef = useRef(0);

  const setDrawModeSafe = (m: 'idle' | 'rolling' | 'winner') => {
    drawModeRef.current = m;
    setDrawMode(m);
  };
  const stopLocalTick = () => {
    if (localTickRef.current) { clearInterval(localTickRef.current); localTickRef.current = null; }
  };

  const socketRef = useRef<Socket | null>(null);
  const soundRef = useRef(false);
  const toastKey = useRef(0);
  const latestRef = useRef<GameState | null>(null);

  /* ── sound engine (WebAudio, zero assets — offline-safe & OBS-friendly) ─ */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const noiseBufRef = useRef<AudioBuffer | null>(null);

  const ac = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        const ctx = new Ctx();
        const g = ctx.createGain();
        g.gain.value = 0.9;
        g.connect(ctx.destination);
        audioCtxRef.current = ctx;
        masterGainRef.current = g;
      }
      if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const tone = useCallback((opts: { freq: number; t0?: number; dur?: number; gain?: number; type?: OscillatorType; slideTo?: number | null; attack?: number }) => {
    const ctx = ac();
    const master = masterGainRef.current;
    if (!ctx || !master) return;
    const { freq, t0 = 0, dur = 0.15, gain = 0.16, type = 'sine', slideTo = null, attack = 0.015 } = opts;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const at = ctx.currentTime + t0;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }, [ac]);

  const hiss = useCallback((opts: { t0?: number; dur?: number; gain?: number; filter?: BiquadFilterType; freq?: number; sweepTo?: number | null; q?: number }) => {
    const ctx = ac();
    const master = masterGainRef.current;
    if (!ctx || !master) return;
    if (!noiseBufRef.current) {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseBufRef.current = buf;
    }
    const { t0 = 0, dur = 0.2, gain = 0.1, filter = 'highpass', freq = 1200, sweepTo = null, q = 0.8 } = opts;
    const src = ctx.createBufferSource();
    src.buffer = noiseBufRef.current;
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
    src.connect(bq).connect(g).connect(master);
    src.start(at);
    src.stop(at + dur + 0.05);
  }, [ac]);

  const safeSfx = useCallback((fn: () => void) => {
    try { if (soundRef.current && ac()) fn(); } catch { /* audio blocked */ }
  }, [ac]);

  const sfxToggle = useCallback(() => safeSfx(() => {
    tone({ freq: 880, dur: 0.09, gain: 0.12, type: 'triangle' });
    tone({ freq: 1174.7, t0: 0.08, dur: 0.12, gain: 0.12, type: 'triangle' });
  }), [safeSfx, tone]);

  /** slot locked — juicy "pop + click" */
  const sfxLock = useCallback(() => safeSfx(() => {
    tone({ freq: 420, slideTo: 940, dur: 0.1, gain: 0.22, type: 'triangle' });
    tone({ freq: 1300, t0: 0.06, dur: 0.07, gain: 0.08, type: 'sine' });
    hiss({ dur: 0.05, gain: 0.07, filter: 'highpass', freq: 3200 });
  }), [safeSfx, tone, hiss]);

  /** claim rejected — soft low thud */
  const sfxReject = useCallback(() => safeSfx(() => {
    tone({ freq: 196, slideTo: 130, dur: 0.16, gain: 0.12, type: 'square' });
    hiss({ dur: 0.08, gain: 0.04, filter: 'lowpass', freq: 500 });
  }), [safeSfx, tone, hiss]);

  /** gift received — sparkle arpeggio + shimmer */
  const sfxGift = useCallback(() => safeSfx(() => {
    [1318.5, 1760, 2349.3].forEach((f, i) => tone({ freq: f, t0: i * 0.07, dur: 0.14, gain: 0.13, type: 'sine' }));
    hiss({ t0: 0.02, dur: 0.3, gain: 0.05, filter: 'highpass', freq: 5200 });
  }), [safeSfx, tone, hiss]);

  /** keno roll tick — mechanical ball click; pitch varies with the number */
  const sfxTick = useCallback((n = 0) => safeSfx(() => {
    hiss({ dur: 0.032, gain: 0.075, filter: 'bandpass', freq: 1700 + (n % 6) * 260, q: 2.4 });
    tone({ freq: 1500 + (n % 5) * 220, dur: 0.045, gain: 0.05, type: 'square' });
  }), [safeSfx, tone, hiss]);

  /** winner fanfare — big ascending sting */
  const sfxWinner = useCallback(() => safeSfx(() => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ freq: f, t0: i * 0.09, dur: 0.3, gain: 0.17, type: 'triangle' });
      tone({ freq: f * 2, t0: i * 0.09, dur: 0.22, gain: 0.05, type: 'sine' });
    });
    hiss({ dur: 0.55, gain: 0.06, filter: 'bandpass', freq: 900, sweepTo: 4200, q: 1.4 });
    [783.99, 1046.5, 1318.5, 1568].forEach((f, i) => tone({ freq: f, t0: 0.42 + i * 0.1, dur: 0.4, gain: 0.15, type: 'triangle' }));
  }), [safeSfx, tone, hiss]);

  /** new round — rising whoosh */
  const sfxReset = useCallback(() => safeSfx(() => {
    hiss({ dur: 0.42, gain: 0.1, filter: 'lowpass', freq: 420, sweepTo: 3800 });
    tone({ freq: 300, slideTo: 920, dur: 0.32, gain: 0.1, type: 'sine' });
    [523.25, 392, 523.25, 783.99].forEach((f, i) => tone({ freq: f, t0: 0.3 + i * 0.07, dur: 0.16, gain: 0.12, type: 'triangle' }));
  }), [safeSfx, tone, hiss]);

  /** overlay ad appears — attention swoosh */
  const sfxAd = useCallback(() => safeSfx(() => {
    hiss({ dur: 0.3, gain: 0.09, filter: 'bandpass', freq: 700, sweepTo: 3400, q: 1.2 });
    tone({ freq: 660, slideTo: 990, dur: 0.18, gain: 0.13, type: 'triangle' });
    tone({ freq: 1320, t0: 0.16, dur: 0.16, gain: 0.09, type: 'sine' });
  }), [safeSfx, tone, hiss]);

  /* unlock the AudioContext on the first gesture (autoplay-policy safe) */
  useEffect(() => {
    const unlock = () => { if (soundRef.current) ac(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [ac]);

  /* ── winner draw UI helpers (need sfx, so defined after the sound engine) ── */
  const startRollUI = useCallback((pool: number[]) => {
    if (drawModeRef.current === 'winner') return;
    stopLocalTick();
    const p = Array.isArray(pool) && pool.length ? pool : [1];
    tickCountRef.current = 0;
    drawModeRef.current = 'rolling';
    setDrawMode('rolling');
    setDrawPool(p);
    /* The keno roll runs ENTIRELY client-side: the ball starts spinning the
       moment the stage appears and can NEVER get stuck on a placeholder.
       'draw-result' is the only authoritative moment (same winner for all). */
    const spin = () => {
      const n = p[Math.floor(Math.random() * p.length)];
      setDrawNumber(n);
      tickCountRef.current += 1;
      if (tickCountRef.current % 6 === 0) sfxTick(n);
    };
    spin();
    localTickRef.current = setInterval(spin, 110);
  }, [sfxTick]);

  const showWinnerUI = useCallback((winner: LastWinner, _celebrateMs?: number | null) => {
    stopLocalTick();
    drawModeRef.current = 'winner';
    setDrawMode('winner');
    setWinnerShow(winner);
    setConfettiKey((k) => k + 1);
    sfxWinner();
  }, [sfxWinner]);

  /* ── overlay ad handlers ───────────────────────────────────────────── */
  const dismissAd = useCallback(() => {
    setAdClosing(true);
    if (adEndRef.current) clearTimeout(adEndRef.current);
    adEndRef.current = setTimeout(() => { setAd(null); setAdClosing(false); }, 300);
  }, []);

  const showAdUI = useCallback((p: { url?: string; kind?: string; caption?: string; durationMs?: number } | null) => {
    if (!p?.url) return;
    setAdClosing(false);
    setAd({
      url: p.url,
      kind: p.kind === 'video' ? 'video' : 'image',
      caption: String(p.caption || ''),
      durationMs: Math.max(2000, Number(p.durationMs) || 8000),
      key: ++adKeyRef.current,
    });
    sfxAd();
  }, [sfxAd]);

  /* auto-dismiss the ad after its duration */
  useEffect(() => {
    if (!ad) return;
    const t = setTimeout(() => dismissAd(), ad.durationMs);
    return () => clearTimeout(t);
  }, [ad, dismissAd]);

  /* video ads: try unmuted autoplay (OBS allows it), fall back to muted;
     close as soon as the clip ends */
  useEffect(() => {
    const v = adVideoRef.current;
    if (!ad || ad.kind !== 'video' || !v) return;
    v.muted = false;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { v.muted = true; v.play().catch(() => {}); });
    }
    const onEnded = () => dismissAd();
    v.addEventListener('ended', onEnded);
    return () => v.removeEventListener('ended', onEnded);
  }, [ad, dismissAd]);

  /* progress bar drain (reflow trick so the transition always restarts) */
  useEffect(() => {
    const bar = adBarRef.current;
    if (!ad || !bar) return;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${ad.durationMs}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }, [ad]);

  /* ── helpers ─────────────────────────────────────────────────────────── */
  const addToast = useCallback((html: string, cls = '') => {
    const key = ++toastKey.current;
    setToasts((prev) => [...prev.slice(-2), { key, html, cls }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), 3600);
  }, []);

  const pulseSlot = useCallback((slot: number) => {
    const at = Date.now();
    setPulses((p) => ({ ...p, [slot]: at }));
    setTimeout(() => setPulses((p) => (p[slot] === at ? { ...p, [slot]: 0 } : p)), 1600);
  }, []);

  const setTicker = useCallback((html: string) => setTickerHtml(html), []);

  /* ── initial sound preference ────────────────────────────────────────── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let on = false;
    try {
      const forced = params.get('sound');
      if (forced === '1') on = true;
      else if (forced !== '0') on = localStorage.getItem('lgl_sound') === '1';
    } catch { /* storage blocked */ }
    setSoundOn(on);
    soundRef.current = on;
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      soundRef.current = next;
      try { localStorage.setItem('lgl_sound', next ? '1' : '0'); } catch { /* noop */ }
      if (next) sfxToggle();
      return next;
    });
  }, [sfxToggle]);

  /* ── socket + polling fallback ───────────────────────────────────────── */
  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['polling'],
      addTrailingSlash: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setBanner(false));
    socket.on('disconnect', () => setBanner(true));
    socket.on('connect_error', () => setBanner(true));

    type ServerState = GameState & { server?: unknown };
    socket.on('state', (s: ServerState) => setState(s));

    socket.on('slot-locked', (d: { slot: number; entry: SlotEntry }) => {
      pulseSlot(d.slot);
      sfxLock();
      const who = escapeHtml(d.entry?.uniqueId || d.entry?.nickname || 'viewer');
      addToast(`<span>@${who} locked <b>#${d.slot}</b>!</span>`);
    });

    socket.on('round-reset', (d: { round: number }) => {
      setDrawModeSafe('idle');
      stopLocalTick();
      setWinnerShow(null);
      setFlash({ round: d.round, key: Date.now() });
      setTimeout(() => setFlash(null), 2600);
      sfxReset();
    });

    socket.on('draw-started', (d: { pool: number[] }) => {
      startRollUI(d.pool || []);
    });

    socket.on('draw-tick', () => {
      /* Rolling numbers are animated client-side, so a dropped tick stream can
         never freeze the ball on a placeholder. Server ticks are intentionally
         not rendered — 'draw-result' decides the actual winner. If the roll UI
         died somehow, this event revives it. */
      if (drawModeRef.current !== 'rolling') {
        startRollUI(latestRef.current?.slots?.filter((e) => e?.userId).map((e) => e.slot) || []);
      }
    });

    socket.on('draw-result', (d: { winner: LastWinner; celebrateMs?: number; slot?: number }) => {
      const w: LastWinner = d.winner ?? { round: 0, slot: d.slot ?? 0, uniqueId: 'winner', nickname: 'Winner', profilePictureUrl: null, wonAt: Date.now() };
      showWinnerUI(w, d.celebrateMs);
      addToast(`👑 <span><b>@${escapeHtml(w.uniqueId)}</b> wins round ${w.round ?? ''} — number <b>#${w.slot}</b>!</span>`);
      setTicker(`👑 <b>@${escapeHtml(w.uniqueId)}</b> won the draw — lucky number <b class="hl">#${w.slot}</b>!`);
    });

    socket.on('gift-received', (ev: ActivityEvent) => {
      sfxGift();
      addToast(`🎁 <span><b>@${escapeHtml(ev.user?.uniqueId)}</b> sent ${escapeHtml(ev.giftName)} ×${ev.repeatCount ?? 1}</span>`, 'gift');
    });

    socket.on('ad:show', (d: { url?: string; kind?: string; caption?: string; durationMs?: number } | null) => showAdUI(d));
    socket.on('ad:hide', () => dismissAd());

    socket.on('activity', (ev: ActivityEvent) => {
      const u = `@${escapeHtml(ev.user?.uniqueId || ev.user?.nickname || 'viewer')}`;
      switch (ev.type) {
        case 'claim': setTicker(`✅ <b>${u}</b> locked slot <b class="hl">#${ev.slot}</b>`); break;
        case 'rejected': setTicker(`⌛ <b>${u}</b> was too late — slot <b>#${ev.slot}</b> already taken`); break;
        case 'duplicate': setTicker(`🙃 <b>${u}</b> already holds slot <b>#${ev.slot}</b> — one per viewer!`); break;
        case 'invalid': setTicker(`❓ <b>${u}</b> — pick a number between 1 and ${latestRef.current?.totalSlots ?? 10}`); break;
        case 'gift': setTicker(`🎁 <b>${u}</b> sent <b class="hl">${escapeHtml(ev.giftName)}</b> ×${ev.repeatCount ?? 1}!`); sfxGift(); break;
        case 'rejected':
        case 'duplicate':
          sfxReject();
          break;
        case 'ad': setTicker(`📣 <b>AD</b> is live on the overlay — thanks for watching!`); break;
        case 'join': setTicker(`👋 <b>${u}</b> joined the stream`); break;
        case 'released': setTicker(`🔓 Slot <b>#${ev.slot}</b> was released by the host`); break;
        case 'grid-full': setTicker(`🔥 GRID COMPLETE — picking the lucky number soon!`); break;
        case 'busy': setTicker(`⏳ <b>${u}</b> — draw in progress, next round starts in a moment!`); break;
        case 'draw-started': setTicker(`🎯 Drawing the lucky number from <b>${(ev as { poolSize?: number }).poolSize ?? '?'}</b> slots…`); break;
        case 'draw-result': setTicker(`👑 <b>@${escapeHtml((ev as { winner?: { uniqueId?: string } }).winner?.uniqueId || 'winner')}</b> won — lucky number <b class="hl">#${ev.slot}</b>!`); break;
        case 'reset': setTicker(`🔄 Round <b>${ev.round}</b> — grid is open, pick a number!`); break;
        default: break;
      }
    });

    socket.on('activity:history', (events: ActivityEvent[]) => {
      const last = events && events[events.length - 1];
      if (!last) return;
      const u = `@${escapeHtml(last.user?.uniqueId || 'viewer')}`;
      if (last.type === 'claim') setTicker(`✅ <b>${u}</b> locked slot <b class="hl">#${last.slot}</b>`);
      else if (last.type === 'gift') setTicker(`🎁 <b>${u}</b> sent <b class="hl">${escapeHtml(last.giftName)}</b> ×${last.repeatCount ?? 1}!`);
    });

    /* HTTP state-polling safety net (if the socket is blocked entirely) */
    const fallback = setInterval(() => {
      if (socket.connected) return;
      fetch('/api/state', { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => { if (j?.ok) setState(j.state); })
        .catch(() => {});
    }, 5000);

    return () => {
      clearInterval(fallback);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [addToast, dismissAd, pulseSlot, setTicker, showAdUI, showWinnerUI, sfxGift, sfxLock, sfxReject, sfxReset, startRollUI]);

  /* ── 1 Hz timer tick ─────────────────────────────────────────────────── */
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { latestRef.current = state; }, [state]);

  /* ── late-joiner / polling-fallback phase sync ─────────────────────── */
  useEffect(() => {
    if (!state) return;
    if (state.phase === 'drawing' && drawModeRef.current === 'idle') {
      const pool = (state.slots || []).filter((e) => e?.userId).map((e) => e.slot);
      startRollUI(pool); // rolls locally until 'draw-result' arrives
    } else if (state.phase === 'celebrating' && drawModeRef.current !== 'winner' && state.lastWinner) {
      showWinnerUI(state.lastWinner, null);
    }
  }, [state, startRollUI, showWinnerUI]);

  /* ── host hotkey: Shift+R resets the round ───────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || (e.key !== 'R' && e.key !== 'r')) return;
      let key: string | null = null;
      const params = new URLSearchParams(window.location.search);
      try { key = params.get('key') || localStorage.getItem('lgl_admin_key'); } catch { /* blocked */ }
      if (!key) return;
      fetch('/api/reset', {
        method: 'POST',
        headers: { 'x-admin-key': key, 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── render ──────────────────────────────────────────────────────────── */
  const s = state;
  const total = s?.totalSlots ?? 10;
  const left = s ? total - s.claimedCount : total;
  const claimed = s?.claimedCount ?? 0;

  const elapsed = (() => {
    if (!s?.roundStartedAt || !now) return '00:00';
    const sec = Math.max(0, Math.floor((now - s.roundStartedAt) / 1000));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  })();

  return (
    <div id="stage">
      {/* reconnect banner */}
      <div id="reconnect-banner" className={banner ? '' : 'hidden'}>⚠ CONNECTION LOST — RECONNECTING…</div>

      {/* round reset flash */}
      <div id="round-flash" className={flash ? '' : 'hidden'}>
        <div className="round-flash-inner" key={flash?.key ?? 'idle'}>
          <div className="round-flash-label">NEW ROUND</div>
          <div className="round-flash-num">{flash?.round ?? ''}</div>
          <div className="round-flash-sub">TYPE A NUMBER TO CLAIM YOUR SLOT!</div>
        </div>
      </div>

      {/* ══ OVERLAY AD (image / gif / short video) ══ */}
      <div id="ad-stage" className={ad ? (adClosing ? 'closing' : '') : 'hidden'}>
        <div className="ad-backdrop" />
        <div className="ad-card">
          <div className="ad-badge">📣 AD</div>
          <div className="ad-media-wrap">
            {ad?.kind === 'image' && (
              <img id="ad-image" src={ad.url} alt="" referrerPolicy="no-referrer" />
            )}
            {ad?.kind === 'video' && (
              <video id="ad-video" ref={adVideoRef} src={ad.url} autoPlay playsInline />
            )}
          </div>
          {ad?.caption ? <div className="ad-caption">{ad.caption}</div> : null}
          <div className="ad-progress"><span id="ad-progress-bar" ref={adBarRef} /></div>
        </div>
      </div>

      {/* toast stack */}
      <div id="toasts">
        {toasts.map((t) => (
          <div key={t.key} className={`toast ${t.cls}`} dangerouslySetInnerHTML={{ __html: t.html }} />
        ))}
      </div>

      {/* ══ WINNER DRAW (keno) STAGE ══ */}
      <div id="draw-stage" className={drawMode === 'idle' ? 'hidden' : drawMode === 'rolling' ? 'rolling' : 'celebrate'}>
        <div id="confetti" key={confettiKey}>
          {drawMode === 'winner' && Array.from({ length: 46 }, (_, i) => {
            const colors = ['#25f4ee', '#fe2c55', '#ffc53d', '#ff8a5c', '#7df9ff', '#ffffff', '#c084fc'];
            return (
              <i key={i} style={{
                left: `${(i * 97) % 100}%`,
                background: colors[i % colors.length],
                animationDuration: `${2.4 + ((i * 13) % 26) / 10}s`,
                animationDelay: `${((i * 7) % 18) / 10}s`,
                width: `${10 + (i % 8)}px`,
                height: `${20 + (i % 14)}px`,
              }} />
            );
          })}
        </div>
        <div className="draw-inner">
          <div className="draw-label">
            {drawMode === 'winner' ? `🎉 ROUND ${winnerShow?.round ?? s?.round ?? ''} WINNER` : '🎯 DRAWING A WINNER'}
          </div>
          <div className="keno-ball">
            <div className="ball-face">
              {/* key remount restarts the roll animation on every number swap */}
              <div
                className={`ball-number ${drawMode === 'rolling' ? 'roll' : ''}`}
                key={drawMode === 'rolling' ? String(drawNumber) : 'final'}
              >
                {drawMode === 'winner' ? winnerShow?.slot : drawNumber}
              </div>
            </div>
          </div>
          <div className={`draw-winner ${drawMode === 'winner' ? '' : 'hidden'}`}>
            <div className="draw-avatar-ring">
              {winnerShow?.profilePictureUrl && (
                <img className="draw-avatar" src={winnerShow.profilePictureUrl} alt="" referrerPolicy="no-referrer" />
              )}
              <span
                className="draw-avatar-fallback"
                style={{
                  display: winnerShow?.profilePictureUrl ? 'none' : 'flex',
                  background: `linear-gradient(140deg, hsl(${winnerShow ? hueFor(winnerShow.userId || winnerShow.uniqueId || 'x') : 0}, 70%, 46%), hsl(${winnerShow ? (hueFor(winnerShow.userId || winnerShow.uniqueId || 'x') + 60) % 360 : 60}, 70%, 34%))`,
                }}
              >
                {(winnerShow?.nickname || winnerShow?.uniqueId || '?').trim().charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="draw-username">@{winnerShow?.uniqueId || 'winner'}</div>
          </div>
          <div className="draw-pool">
            {drawMode === 'rolling' && drawPool.map((n) => (
              <span key={n} className={`pool-ball ${String(n) === String(drawNumber) ? 'hit' : ''}`}>{n}</span>
            ))}
          </div>
          <div className="draw-sub">
            {drawMode === 'winner' ? 'NEW ROUND STARTING IN A FEW SECONDS…' : 'PICKING THE LUCKY NUMBER…'}
          </div>
        </div>
      </div>

      {/* ══ HEADER ══ */}
      <header id="header">
        <div className="header-top">
          <div className="live-pill"><span className="live-dot" />LIVE</div>
          <div className="round-chip">ROUND <b>{s?.round ?? 1}</b></div>
          <div className="stat-chip">⏱ <b>{elapsed}</b></div>
          <div className="stat-chip accent"><b>{left}</b> <span>{left === 1 ? 'SLOT' : 'SLOTS'}</span> LEFT</div>
          <button id="sound-toggle" title="Toggle claim sound" className={soundOn ? 'on' : ''} onClick={toggleSound}>
            {soundOn ? '🔊' : '🔇'}
          </button>
        </div>
        <h1 className="title">PICK A NUMBER <span className="gradient">1-{total}</span><span className="bang">!</span></h1>
        <p className="subtitle">
          <span className="sub-chip">💬 TYPE A NUMBER IN CHAT</span>
          <span className="sub-chip">FIRST COME, FIRST SERVED</span>
          <span className="sub-chip">ONE SLOT PER VIEWER</span>
        </p>
      </header>

      {/* ══ MAIN GRID ══ */}
      <main id="grid">
        {Array.from({ length: total }, (_, i) => {
          const n = i + 1;
          const entry = s?.slots?.[i];
          const locked = Boolean(entry && entry.userId);
          const name = entry?.nickname || entry?.uniqueId || 'Viewer';
          const pulsing = (pulses[n] ?? 0) > Date.now() - 1600;
          const lw = s?.lastWinner ?? null;
          const isWinnerCard = Boolean(lw && lw.slot === n);
          return (
            <div key={n} id={`card-${n}`} className={`card ${locked ? 'locked' : 'open'} ${pulsing ? 'just-locked' : ''} ${isWinnerCard ? 'last-winner' : ''}`}>
              <div className="card-shine" />
              <div className="slot-badge">#{n}</div>
              <div className="winner-ribbon" style={{ display: isWinnerCard ? 'flex' : 'none' }}>
                👑 @{lw?.uniqueId || 'winner'}
              </div>
              {locked ? (
                <div className="card-locked-content">
                  <div className="avatar-ring">
                    <Avatar url={entry?.profilePictureUrl} name={name} userId={entry?.userId} className="avatar" fontSize={42} />
                  </div>
                  <div className="locked-info">
                    <div className="locked-name">{name}</div>
                    <div className="locked-meta">
                      <span className="locked-pill">🔒 LOCKED</span>
                      <span className="locked-time">{entry?.lockedAt ? fmtTime(entry.lockedAt) : ''}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="card-open-content">
                  <div className="big-number">{n}</div>
                  <div className="available-chip">AVAILABLE</div>
                </div>
              )}
            </div>
          );
        })}
      </main>

      {/* ══ ACTIVITY TICKER ══ */}
      <div id="ticker">
        <span className="ticker-label">📡</span>
        <span id="ticker-text" className="ticker-text flip" dangerouslySetInnerHTML={{ __html: tickerHtml }} />
      </div>

      {/* ══ CLAIMED SLOTS FEED ══ */}
      <section id="claimed">
        <div className="claimed-header">
          <span className="claimed-title">🏆 CLAIMED SLOTS</span>
          <span className="claimed-count">{claimed} / {total}</span>
        </div>
        <div id="feed">
          {Array.from({ length: total }, (_, i) => {
            const n = i + 1;
            const entry = s?.slots?.[i];
            const locked = Boolean(entry && entry.userId);
            const name = entry?.nickname || entry?.uniqueId || 'Viewer';
            const pulsing = (pulses[n] ?? 0) > Date.now() - 900;
            const isWinnerRow = Boolean(s?.lastWinner && s.lastWinner.slot === n);
            return (
              <div key={n} id={`feed-${n}`} className={`feed-row ${locked ? 'filled' : ''} ${pulsing ? 'just-locked' : ''} ${isWinnerRow ? 'winner-row' : ''}`}>
                <div className="feed-slot">{isWinnerRow ? '👑' : `#${n}`}</div>
                <div className="feed-avatar-wrap">
                  {locked ? (
                    <Avatar url={entry?.profilePictureUrl} name={name} userId={entry?.userId} className="feed-avatar" fontSize={15} />
                  ) : null}
                </div>
                <div className="feed-name">{locked ? `@${entry?.uniqueId || name}` : 'waiting…'}</div>
                <div className="feed-time">{locked && entry?.lockedAt ? fmtTime(entry.lockedAt) : ''}</div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
