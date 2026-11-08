'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import {
  RotateCcw,
  FlaskConical,
  Radio,
  ExternalLink,
  Copy,
  Lock,
  Unlock,
  Gift,
  Timer,
  Users,
  Zap,
  Server,
  MonitorSmartphone,
  Trophy,
  Megaphone,
} from 'lucide-react';

/* ── types ──────────────────────────────────────────────────────────── */
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
  lastWinner: LastWinner | null;
  slots: SlotEntry[];
  stats: { claims: number; rejectedTaken: number; rejectedDuplicate: number; gifts: number; resets: number; draws?: number };
  completedRounds: number;
};
type ServerInfo = {
  mode: 'LIVE' | 'SIMULATION';
  simulate: boolean;
  simulator: { enabled: boolean; active: boolean };
  tiktok: { username: string; status: string; configured: boolean; lastError: string | null };
  version: string;
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
  source?: string;
};
type WinnerRow = {
  round: number;
  slot: number;
  uniqueId: string;
  nickname?: string;
  profilePictureUrl?: string | null;
  wonAt: number;
  source?: string;
};

const GAME_PORT = 3003;
/* HTTP API calls go to same-origin Next.js proxy routes: they are forwarded
   to the game service server-side and auto-restart it if it ever dies — so
   admin actions like Reset can never hit an HTML error page again. */
const API = (path: string) => `/api/${path}`;

const EVENT_ICONS: Record<string, string> = {
  claim: '🔒', rejected: '⌛', duplicate: '🙃', invalid: '❓', gift: '🎁',
  join: '👋', released: '🔓', 'grid-full': '🔥', reset: '🔄', chat: '💬',
  'draw-started': '🎯', 'draw-result': '👑', busy: '⏳',
};

function describeEvent(ev: ActivityEvent): string {
  const u = `@${ev.user?.uniqueId || ev.user?.nickname || 'viewer'}`;
  switch (ev.type) {
    case 'claim': return `${u} locked slot #${ev.slot}`;
    case 'rejected': return `${u} was too late — #${ev.slot} already taken`;
    case 'duplicate': return `${u} already holds slot #${ev.slot}`;
    case 'invalid': return `${u} typed "${ev.comment || '?'}" — not a valid slot`;
    case 'gift': return `${u} sent ${ev.giftName || 'a gift'} ×${ev.repeatCount || 1}`;
    case 'join': return `${u} joined the stream`;
    case 'released': return `Slot #${ev.slot} was released`;
    case 'grid-full': return `Grid complete — the lucky number is coming up!`;
    case 'busy': return `${u} typed ${ev.comment ?? 'a number'} during the draw — round closed`;
    case 'draw-started': return `Keno draw started — ${(ev as { poolSize?: number }).poolSize ?? '?'} slots in the pool`;
    case 'draw-result': return `👑 @${(ev as { winner?: { uniqueId?: string } }).winner?.uniqueId || 'winner'} won slot #${ev.slot} — round ${ev.round} complete!`;
    case 'reset': return `Round ${ev.round} started — grid is open`;
    case 'chat': return `${u}: "${ev.comment || ''}"`;
    default: return ev.type;
  }
}

const BURST_NAMES = ['nova_rush', 'pixelpanda', 'moon_moth', 'turbo_-t', 'echo_fox', 'lil_comet', 'volt_vicky', 'dr_drip', 'kiwi_krush', 'astro_ace'];

/** 'YYYY-MM-DD' -> local epoch ms (start or end of day); '' when empty */
function dateToEpoch(value: string, endOfDay = false): string {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return '';
  return String(endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d, 0, 0, 0, 0).getTime());
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });
}

const fmtWinnerWhen = (ts: number) =>
  new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Home() {
  const { toast } = useToast();
  const socketRef = useRef<Socket | null>(null);

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [adminKey, setAdminKey] = useState('');
  const [simOn, setSimOn] = useState(false);
  const [injUser, setInjUser] = useState('');
  const [injNum, setInjNum] = useState('');
  const [injGift, setInjGift] = useState('Rose');
  const [injGiftCount, setInjGiftCount] = useState(1);
  const [busy, setBusy] = useState(false);

  /* ── winner history state ────────────────────────────────────────── */
  const [winners, setWinners] = useState<WinnerRow[]>([]);
  const [winTotal, setWinTotal] = useState<number | null>(null);
  const [winRound, setWinRound] = useState('');
  const [winFrom, setWinFrom] = useState('');
  const [winTo, setWinTo] = useState('');

  /* ── overlay ad state ────────────────────────────────────────────── */
  const [adFile, setAdFile] = useState<File | null>(null);
  const [adUrl, setAdUrl] = useState('');
  const [adDuration, setAdDuration] = useState(8);
  const [adCaption, setAdCaption] = useState('');
  const [adBusy, setAdBusy] = useState(false);
  const refreshWinnersRef = useRef<() => void>(() => {});

  /* admin key (persisted) */
  useEffect(() => {
    let k: string | null = null;
    try { k = localStorage.getItem('lgl_admin_key'); } catch { /* blocked */ }
    setAdminKey(k || 'sandbox-admin');
  }, []);
  const saveKey = (v: string) => {
    setAdminKey(v);
    try { localStorage.setItem('lgl_admin_key', v); } catch { /* blocked */ }
  };

  /* ── socket + polling ────────────────────────────────────────────── */
  useEffect(() => {
    /* same-origin socket.io polling proxy — no gateway query needed, works
       through Caddy, direct access and the standalone VPS alike */
    const socket = io({
      path: '/socket.io',
      transports: ['polling'],
      addTrailingSlash: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('state', (s: unknown) => setState(s as GameState));
    socket.on('server', (s: unknown) => {
      const info = s as ServerInfo;
      setServerInfo(info);
      setSimOn(Boolean(info.simulator?.enabled));
    });
    socket.on('activity', (ev: unknown) => {
      const e = ev as ActivityEvent;
      setEvents((prev) => [e, ...prev].slice(0, 80));
    });
    socket.on('activity:history', (evs: unknown) => {
      if (Array.isArray(evs)) setEvents(evs as ActivityEvent[]);
    });
    socket.on('draw-result', (d: { winner?: { uniqueId?: string; nickname?: string; slot?: number; round?: number } }) => {
      const w = d.winner;
      if (w?.uniqueId) {
        toast({ title: `👑 @${w.uniqueId} won!`, description: `Lucky number #${w.slot} — round ${w.round ?? ''} complete. New round starting…` });
      }
      refreshWinnersRef.current(); // keep the winner list current
    });

    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  /* if the socket can't connect (gateway hiccup, service restarting), fall
     back to polling the full state through the same-origin proxy every 2 s */
  useEffect(() => {
    if (connected) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(API('state'), { cache: 'no-store' });
        const j = await r.json();
        if (!alive || !j?.ok) return;
        setState(j.state as GameState);
        if (Array.isArray(j.state?.events)) setEvents(j.state.events as ActivityEvent[]);
      } catch { /* service restarting */ }
    };
    pull();
    const t = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [connected]);

  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(API('status'));
      const j = await r.json();
      setServerInfo(j as ServerInfo);
      setSimOn(Boolean(j.simulator?.enabled));
    } catch { /* server briefly down */ }
  }, []);
  useEffect(() => {
    pollStatus();
    const t = setInterval(pollStatus, 5000);
    return () => clearInterval(t);
  }, [pollStatus]);

  /* ── API helpers ─────────────────────────────────────────────────── */
  const apiCall = useCallback(
    async (path: string, body: Record<string, unknown>, needsKey = true) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (needsKey) headers['x-admin-key'] = adminKey;
      const r = await fetch(API(path), { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await r.text();
      let j: { ok?: boolean; message?: string; error?: string } & Record<string, unknown>;
      try {
        j = JSON.parse(text);
      } catch {
        // never leak raw HTML/parse errors like "Unexpected token '<'"
        throw new Error(`Game service error (HTTP ${r.status}) — it may be restarting, retry in a second`);
      }
      if (!r.ok || j.ok === false) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      return j;
    },
    [adminKey],
  );

  const resetRound = async () => {
    if (!window.confirm('Flush all locks and start a new round?')) return;
    setBusy(true);
    try {
      const j = await apiCall('reset', { source: 'control-center' });
      toast({ title: `Round ${j.round} started`, description: 'All slots unlocked, grid is open.' });
    } catch (e) {
      toast({ title: 'Reset failed', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const drawWinner = async () => {
    setBusy(true);
    try {
      const j = await apiCall('admin/draw', { source: 'control-center' });
      toast({ title: '🎯 Draw started', description: (j.message as string) || 'Rolling the lucky number…' });
    } catch (e) {
      toast({ title: 'Draw failed', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const toggleSim = async (enabled: boolean) => {
    setBusy(true);
    try {
      await apiCall('admin/sim', { enabled });
      setSimOn(enabled);
      toast({ title: enabled ? 'Simulator running' : 'Simulator stopped', description: enabled ? 'Fake viewers will claim slots every few seconds.' : undefined });
    } catch (e) {
      setSimOn(!enabled);
      toast({ title: 'Could not toggle simulator', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const injectClaim = async () => {
    const comment = injNum.trim();
    if (!comment) { toast({ title: 'Type a slot number first' }); return; }
    try {
      const j = await apiCall('simulate/chat', { username: injUser.trim() || undefined, comment }, false);
      toast({ title: `Claimed slot #${j.slot}`, description: `as @${String((j.entry as { uniqueId?: string })?.uniqueId ?? '')}` });
      setInjNum('');
    } catch (e) {
      toast({ title: 'Claim rejected', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    }
  };

  const injectGift = async () => {
    try {
      await apiCall('simulate/gift', {
        username: injUser.trim() || undefined,
        giftName: injGift.trim() || 'Rose',
        count: Math.max(1, Number(injGiftCount) || 1),
      }, false);
      toast({ title: `🎁 ${injGift} ×${injGiftCount} sent` });
    } catch (e) {
      toast({ title: 'Gift failed', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    }
  };

  const burstViewers = async () => {
    if (!state) return;
    const free = state.slots.filter((s) => !s.userId).map((s) => s.slot);
    const picks = free.sort(() => Math.random() - 0.5).slice(0, 5);
    if (!picks.length) { toast({ title: 'Grid is already full' }); return; }
    setBusy(true);
    for (let i = 0; i < picks.length; i++) {
      try {
        await apiCall('simulate/chat', { username: BURST_NAMES[(state.round + i) % BURST_NAMES.length], comment: String(picks[i]) }, false);
      } catch { /* keep going */ }
      await new Promise((r) => setTimeout(r, 350));
    }
    setBusy(false);
  };

  const releaseSlot = async (slot: number) => {
    if (!window.confirm(`Release slot #${slot}?`)) return;
    try {
      await apiCall('admin/release', { slot });
      toast({ title: `Slot #${slot} released` });
    } catch (e) {
      toast({ title: 'Release failed', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    }
  };

  const copyObsUrl = async () => {
    const url = `${window.location.origin}/overlay`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'OBS URL copied', description: url });
    } catch {
      toast({ title: 'Copy manually', description: url });
    }
  };

  /* ── winner history ──────────────────────────────────────────────── */
  const loadWinners = useCallback(async () => {
    try {
      const usp = new URLSearchParams();
      if (winRound.trim()) usp.set('round', winRound.trim());
      if (winFrom) usp.set('from', dateToEpoch(winFrom));
      if (winTo) usp.set('to', dateToEpoch(winTo, true));
      const r = await fetch(`/api/admin/winners?${usp.toString()}`, {
        headers: { 'x-admin-key': adminKey },
        cache: 'no-store',
      });
      const j = await r.json();
      if (j?.ok) {
        setWinners(Array.isArray(j.winners) ? j.winners : []);
        setWinTotal(typeof j.total === 'number' ? j.total : null);
      }
    } catch { /* service restarting */ }
  }, [adminKey, winFrom, winRound, winTo]);

  useEffect(() => {
    refreshWinnersRef.current = loadWinners;
  }, [loadWinners]);

  useEffect(() => {
    loadWinners();
  }, [loadWinners]);

  const applyQuickFilter = (kind: 'today' | '7d' | 'all') => {
    const now = new Date();
    setWinRound('');
    if (kind === 'today') {
      setWinFrom(isoDay(now));
      setWinTo(isoDay(now));
    } else if (kind === '7d') {
      setWinFrom(isoDay(new Date(now.getTime() - 6 * 24 * 3600 * 1000)));
      setWinTo(isoDay(now));
    } else {
      setWinFrom('');
      setWinTo('');
    }
  };

  /* ── overlay ad ──────────────────────────────────────────────────── */
  const submitAd = async () => {
    if (!adFile && !adUrl.trim()) {
      toast({ title: 'Pick a media first', description: 'Choose an image / GIF / short video file or paste a media URL.' });
      return;
    }
    if (adFile && adFile.size > 48 * 1024 * 1024) {
      toast({ title: 'File too large', description: 'Max 48 MB — use a shorter clip or host it by URL.', variant: 'destructive' });
      return;
    }
    setAdBusy(true);
    try {
      const body: Record<string, unknown> = {
        durationSec: Math.min(Math.max(Number(adDuration) || 8, 2), 300),
        caption: adCaption.trim(),
      };
      if (adFile) {
        body.dataUrl = await fileToDataUrl(adFile);
        if (adFile.type.startsWith('video/')) body.kind = 'video';
      } else {
        body.url = adUrl.trim();
        if (/\.(mp4|webm|mov|ogv)(\?|#|$)/i.test(adUrl.trim())) body.kind = 'video';
      }
      const j = await apiCall('admin/ad', body);
      toast({ title: '📣 Ad is live on the overlay', description: (j.message as string) || 'It dismisses itself automatically.' });
      setAdFile(null);
    } catch (e) {
      toast({ title: 'Ad failed', description: e instanceof Error ? e.message : 'unknown error', variant: 'destructive' });
    } finally {
      setAdBusy(false);
    }
  };

  const stopAd = async () => {
    try {
      await apiCall('admin/ad/stop', {});
      toast({ title: 'Ad dismissed' });
    } catch (e) {
      toast({ title: 'Could not stop the ad', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    }
  };

  /* ── scaled phone preview ────────────────────────────────────────── */
  const phoneRef = useRef<HTMLDivElement>(null);
  const [phoneScale, setPhoneScale] = useState(0.3);
  useEffect(() => {
    const el = phoneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPhoneScale(el.clientWidth / 1080));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── derived ─────────────────────────────────────────────────────── */
  const mode = serverInfo?.mode ?? '…';
  const claimed = state?.claimedCount ?? 0;
  const total = state?.totalSlots ?? 10;
  const elapsed = useMemo(() => {
    if (!state?.roundStartedAt) return '00:00';
    const s = Math.max(0, Math.floor((Date.now() - state.roundStartedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    // re-computed on state changes; good enough for the header chip
  }, [state]);

  return (
    <div className="min-h-screen flex flex-col bg-[#07070d] text-zinc-100"
      style={{ backgroundImage: 'radial-gradient(900px 480px at -10% -10%, rgba(37,244,238,0.10), transparent 60%), radial-gradient(900px 560px at 110% 110%, rgba(254,44,85,0.10), transparent 60%)' }}>

      {/* ── top bar ── */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#07070d]/85 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#25f4ee] to-[#fe2c55] grid place-items-center shrink-0">
              <Lock className="w-5 h-5 text-black" />
            </div>
            <div className="min-w-0">
              <h1 className="font-extrabold text-lg leading-tight truncate">Locked Grid Lottery</h1>
              <p className="text-xs text-zinc-400 -mt-0.5">TikTok LIVE interactive game · control center</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={connected ? 'border-emerald-500/50 text-emerald-400' : 'border-red-500/50 text-red-400'}>
              <span className={`w-2 h-2 rounded-full mr-1.5 ${connected ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
              {connected ? 'socket live' : 'offline'}
            </Badge>
            <Badge variant="outline" className={mode === 'LIVE' ? 'border-emerald-500/50 text-emerald-400' : 'border-amber-500/50 text-amber-400'}>
              <Radio className="w-3 h-3 mr-1" /> {mode === 'LIVE' ? 'LIVE on TikTok' : 'simulation'}
            </Badge>
            <Badge variant="outline" className="border-cyan-500/40 text-cyan-300">Round {state?.round ?? '—'}</Badge>
          </div>
        </div>
      </header>

      {/* ── main ── */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 grid lg:grid-cols-[380px_1fr] gap-6 items-start">

        {/* left: phone preview */}
        <section className="flex flex-col gap-4 lg:sticky lg:top-20">
          <div ref={phoneRef}
            className="relative mx-auto w-full max-w-[340px] rounded-[30px] border-[6px] border-zinc-800 bg-black overflow-hidden shadow-[0_0_60px_rgba(37,244,238,0.12)]"
            style={{ height: phoneScale ? undefined : 600 }}>
            <div style={{ width: 1080, height: 1920 * phoneScale, transform: `scale(${phoneScale})`, transformOrigin: 'top left' }}>
              <iframe
                src="/overlay"
                title="OBS overlay preview"
                className="border-0 bg-black"
                style={{ width: 1080, height: 1920 }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 max-w-[340px] mx-auto w-full">
            <Button asChild variant="outline" className="border-white/15 hover:bg-white/10">
              <a href="/overlay" target="_blank" rel="noreferrer">
                <ExternalLink className="w-4 h-4 mr-1.5" /> Overlay
              </a>
            </Button>
            <Button asChild variant="outline" className="border-white/15 hover:bg-white/10">
              <a href={`/admin.html?XTransformPort=${GAME_PORT}`} target="_blank" rel="noreferrer">
                <MonitorSmartphone className="w-4 h-4 mr-1.5" /> Admin
              </a>
            </Button>
            <Button variant="secondary" className="col-span-2 bg-gradient-to-r from-[#25f4ee] to-[#0fb9b3] text-black font-bold hover:opacity-90" onClick={copyObsUrl}>
              <Copy className="w-4 h-4 mr-1.5" /> Copy OBS Browser-Source URL
            </Button>
          </div>

          <p className="text-xs text-zinc-500 text-center max-w-[340px] mx-auto leading-relaxed">
            The phone above renders the real 1080×1920 overlay, scaled down. What you see is exactly what OBS captures.
          </p>
        </section>

        {/* right: controls */}
        <section className="flex flex-col gap-6 min-w-0">

          {/* round controls */}
          <Card className="bg-white/[0.04] border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Timer className="w-4 h-4 text-[#25f4ee]" /> Round controls
              </CardTitle>
              <CardDescription className="text-zinc-400">
                Round {state?.round ?? '—'} · {claimed}/{total} slots claimed · elapsed {elapsed}
                {state?.completedRounds ? ` · ${state.completedRounds} completed` : ''}
                {state?.lastWinner ? ` · 👑 last winner @${state.lastWinner.uniqueId} (#${state.lastWinner.slot})` : ''}
                {state?.phase && state.phase !== 'open' ? ` · ${state.phase === 'drawing' ? '🎯 drawing…' : '🎉 celebrating…'}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* slot mirror */}
              <div className="grid grid-cols-10 gap-1.5">
                {(state?.slots ?? Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, locked: false }))).map((s) => (
                  s.userId ? (
                    <button key={s.slot} onClick={() => releaseSlot(s.slot)}
                      title={`@${s.uniqueId} — click to release`}
                      className="rounded-lg py-1.5 text-xs font-extrabold bg-[#fe2c55]/20 border border-[#fe2c55]/60 text-[#ff9db1] hover:bg-[#fe2c55]/30 transition-colors">
                      {(s.nickname || s.uniqueId || '?').charAt(0).toUpperCase()}
                    </button>
                  ) : (
                    <div key={s.slot} title="open"
                      className="rounded-lg py-1.5 text-xs font-extrabold text-center border border-cyan-400/30 text-cyan-300 bg-cyan-400/5">
                      {s.slot}
                    </div>
                  )
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={drawWinner} disabled={busy || !state || state.phase !== 'open' || claimed === 0}
                  className="bg-[#ffc53d] text-[#241a00] font-bold hover:bg-[#f0b32e] disabled:opacity-50">
                  🎯 {state?.phase === 'drawing'
                    ? 'Rolling…'
                    : state?.phase === 'celebrating'
                      ? `@${state.lastWinner?.uniqueId ?? '…'} won!`
                      : claimed === total
                        ? 'Draw winner — grid full!'
                        : 'Draw winner'}
                </Button>
                <Button variant="destructive" onClick={resetRound} disabled={busy} className="bg-[#fe2c55] hover:bg-[#e02048] font-bold">
                  <RotateCcw className="w-4 h-4 mr-1.5" /> Reset round
                </Button>
                <div className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5">
                  <Zap className={`w-4 h-4 ${simOn ? 'text-amber-400' : 'text-zinc-500'}`} />
                  <span className="text-sm font-semibold text-zinc-300">auto-sim viewers</span>
                  <Switch checked={simOn} onCheckedChange={toggleSim} disabled={busy} />
                </div>
                <Button variant="outline" onClick={burstViewers} disabled={busy} className="border-white/15 hover:bg-white/10">
                  <Users className="w-4 h-4 mr-1.5" /> Burst: 5 fake viewers
                </Button>
              </div>

              {state && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                  {[
                    ['claims', state.stats.claims],
                    ['slot-taken', state.stats.rejectedTaken],
                    ['dupes', state.stats.rejectedDuplicate],
                    ['gifts', state.stats.gifts],
                    ['draws', state.stats.draws ?? 0],
                  ].map(([label, v]) => (
                    <div key={label as string} className="rounded-lg bg-white/[0.04] border border-white/10 py-2">
                      <div className="text-lg font-extrabold text-cyan-300">{v as number}</div>
                      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label as string}</div>
                    </div>
                  ))}
                </div>
              )}

              <Separator className="bg-white/10" />
              <div className="flex items-center gap-2 flex-wrap">
                <Server className="w-4 h-4 text-zinc-500" />
                <span className="text-xs text-zinc-500">admin key</span>
                <Input value={adminKey} onChange={(e) => saveKey(e.target.value)} type="password"
                  className="h-8 w-40 bg-white/5 border-white/10 text-xs" />
                <span className="text-xs text-zinc-600">sent as <code className="text-zinc-400">x-admin-key</code></span>
              </div>
            </CardContent>
          </Card>

          {/* test console */}
          <Card className="bg-white/[0.04] border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="w-4 h-4 text-[#fe2c55]" /> Test console
              </CardTitle>
              <CardDescription className="text-zinc-400">
                Injects synthetic chat &amp; gift events through the same pipeline TikTok messages use.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Input value={injUser} onChange={(e) => setInjUser(e.target.value)} placeholder="viewer username (optional)"
                  className="flex-1 min-w-[140px] bg-white/5 border-white/10" />
                <Input value={injNum} onChange={(e) => setInjNum(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && injectClaim()}
                  placeholder="slot # (e.g. 7)" inputMode="numeric" className="w-32 bg-white/5 border-white/10" />
                <Button onClick={injectClaim} className="bg-[#25f4ee] text-black font-bold hover:bg-[#1fd9d3]">Claim</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input value={injGift} onChange={(e) => setInjGift(e.target.value)} placeholder="gift name"
                  className="flex-1 min-w-[140px] bg-white/5 border-white/10" />
                <Input type="number" min={1} value={injGiftCount} onChange={(e) => setInjGiftCount(Number(e.target.value))}
                  className="w-24 bg-white/5 border-white/10" />
                <Button onClick={injectGift} variant="outline" className="border-amber-400/40 text-amber-300 hover:bg-amber-400/10">
                  <Gift className="w-4 h-4 mr-1.5" /> Send gift
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* overlay ad composer */}
          <Card className="bg-white/[0.04] border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Megaphone className="w-4 h-4 text-[#25f4ee]" /> Overlay ad
              </CardTitle>
              <CardDescription className="text-zinc-400">
                Push an image, animated GIF or short video to every overlay. It pops up fullscreen and dismisses itself after the set seconds — videos also close when they finish.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Input type="file" accept="image/*,video/mp4,video/webm,video/quicktime,.gif,.mp4,.webm,.mov"
                  onChange={(e) => setAdFile(e.target.files?.[0] ?? null)}
                  className="flex-1 min-w-[220px] bg-white/5 border-white/10 file:mr-3 file:rounded-md file:border-0 file:bg-cyan-400/15 file:px-3 file:py-1 file:text-cyan-300 file:font-semibold" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Input value={adUrl} onChange={(e) => setAdUrl(e.target.value)} placeholder="…or paste a media URL (https://…/ad.mp4)"
                  className="flex-1 min-w-[220px] bg-white/5 border-white/10" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Input type="number" min={2} max={300} value={adDuration} onChange={(e) => setAdDuration(Number(e.target.value))}
                  title="Seconds on screen" className="w-24 bg-white/5 border-white/10" />
                <Input value={adCaption} onChange={(e) => setAdCaption(e.target.value)} placeholder="Caption (optional)"
                  className="flex-1 min-w-[180px] bg-white/5 border-white/10" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={submitAd} disabled={adBusy} className="bg-[#25f4ee] text-black font-bold hover:bg-[#1fd9d3]">
                  ▶ Show ad on overlay
                </Button>
                <Button variant="outline" onClick={stopAd} className="border-[#fe2c55]/50 text-[#ff8fa6] hover:bg-[#fe2c55]/10">
                  ■ Stop ad
                </Button>
              </div>
              <p className="text-xs text-zinc-500">Uploads up to 48 MB. Hosted URLs can be any mp4/webm/mov/gif/png/jpg link.</p>
            </CardContent>
          </Card>

          {/* winner history */}
          <Card className="bg-white/[0.04] border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="w-4 h-4 text-[#ffc53d]" /> Winner history
                {winTotal !== null && (
                  <Badge variant="outline" className="ml-auto border-white/15 text-zinc-400">{winTotal} total</Badge>
                )}
              </CardTitle>
              <CardDescription className="text-zinc-400">
                Every crowned winner, persisted across restarts. Filter by round number and/or date range.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={winRound} onChange={(e) => setWinRound(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadWinners()}
                  placeholder="Round #" inputMode="numeric" className="w-28 bg-white/5 border-white/10" />
                <Input type="date" value={winFrom} onChange={(e) => setWinFrom(e.target.value)}
                  style={{ colorScheme: 'dark' }} title="From date" className="w-40 bg-white/5 border-white/10" />
                <span className="text-xs text-zinc-500">to</span>
                <Input type="date" value={winTo} onChange={(e) => setWinTo(e.target.value)}
                  style={{ colorScheme: 'dark' }} title="To date" className="w-40 bg-white/5 border-white/10" />
                <Button variant="outline" onClick={loadWinners} className="border-white/15 hover:bg-white/10">Apply</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => applyQuickFilter('today')} className="h-7 border border-white/10 hover:bg-white/10 text-xs">Today</Button>
                <Button size="sm" variant="ghost" onClick={() => applyQuickFilter('7d')} className="h-7 border border-white/10 hover:bg-white/10 text-xs">Last 7 days</Button>
                <Button size="sm" variant="ghost" onClick={() => applyQuickFilter('all')} className="h-7 border border-white/10 hover:bg-white/10 text-xs">All time</Button>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#14141f] text-zinc-400">
                    <tr className="text-left text-[11px] uppercase tracking-wider">
                      <th className="px-3 py-2 font-bold">Round</th>
                      <th className="px-3 py-2 font-bold">#</th>
                      <th className="px-3 py-2 font-bold">Winner</th>
                      <th className="px-3 py-2 font-bold">When</th>
                      <th className="px-3 py-2 font-bold">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {winners.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-zinc-500">
                          No winners match this filter — run a draw first.
                        </td>
                      </tr>
                    ) : (
                      winners.map((w, i) => (
                        <tr key={`${w.round}-${w.wonAt}-${i}`} className="border-t border-white/5 hover:bg-white/[0.03]">
                          <td className="px-3 py-2 font-extrabold text-cyan-300">#{w.round}</td>
                          <td className="px-3 py-2 font-extrabold text-[#ffc53d]">{w.slot}</td>
                          <td className="px-3 py-2 font-bold text-[#ff9db1] max-w-[180px] truncate" title={`@${w.uniqueId}`}>
                            👑 @{w.uniqueId || w.nickname || 'winner'}
                          </td>
                          <td className="px-3 py-2 text-zinc-400 font-mono text-xs">{fmtWinnerWhen(w.wonAt)}</td>
                          <td className="px-3 py-2 text-zinc-500 text-xs uppercase tracking-wide">{w.source || 'draw'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* event log */}
          <Card className="bg-white/[0.04] border-white/10">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Radio className="w-4 h-4 text-cyan-300" /> Live event log
                <Badge variant="outline" className="ml-auto border-white/15 text-zinc-400">{events.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-64 pr-3">
                {events.length === 0 ? (
                  <p className="text-sm text-zinc-500 py-8 text-center">Waiting for activity… turn on auto-sim or send a test claim.</p>
                ) : (
                  <div className="space-y-1.5">
                    {events.map((ev) => (
                      <div key={ev.id} className="flex items-start gap-2.5 rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">
                        <span className="text-sm leading-5">{EVENT_ICONS[ev.type] ?? '•'}</span>
                        <span className="text-[13px] leading-5 text-zinc-300 flex-1">{describeEvent(ev)}</span>
                        <span className="text-[11px] text-zinc-600 font-mono pt-0.5">
                          {new Date(ev.at).toLocaleTimeString('en-GB', { hour12: false })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </section>
      </main>

      {/* ── setup guide ── */}
      <section className="w-full max-w-6xl mx-auto px-4 pb-8">
        <Card className="bg-white/[0.04] border-white/10">
          <CardHeader>
            <CardTitle className="text-base">🚀 Deployment guide</CardTitle>
            <CardDescription className="text-zinc-400">
              The whole game lives in the <code className="text-zinc-300">locked-grid-lottery/</code> folder — a self-contained Node.js project you can drop onto any VPS.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="vps" className="border-white/10">
                <AccordionTrigger className="text-sm font-semibold">1 · Run the server on your VPS</AccordionTrigger>
                <AccordionContent className="text-sm text-zinc-300 space-y-2">
                  <pre className="rounded-lg bg-black/60 border border-white/10 p-3 text-xs overflow-x-auto leading-6">
{`# on the VPS (Node 18+)
cd locked-grid-lottery
npm install
cp .env.example .env      # edit: PORT, ADMIN_KEY, TIKTOK_USERNAME…
node server.js            # production: pm2 start server.js --name lottery

# overlay  ->  http://YOUR_VPS_IP:3000/
# admin    ->  http://YOUR_VPS_IP:3000/admin.html`}
                  </pre>
                  <p className="text-zinc-400">Open <b>3000/tcp</b> in your Oracle Cloud security list / firewall, or put Nginx/Caddy in front with TLS.</p>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="tiktok" className="border-white/10">
                <AccordionTrigger className="text-sm font-semibold">2 · Connect TikTok LIVE chat</AccordionTrigger>
                <AccordionContent className="text-sm text-zinc-300 space-y-2">
                  <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                    <li>Set <code className="text-zinc-300">TIKTOK_USERNAME</code> (without @) to the account that is <b>currently live</b>, then restart the server.</li>
                    <li>Set <code className="text-zinc-300">SIMULATE=0</code> to disable demo endpoints in production, and change <code className="text-zinc-300">ADMIN_KEY</code>.</li>
                    <li>The connector uses TikTok&apos;s unofficial WebSocket API — if the stream is offline or TikTok changes its protocol the server retries with backoff and logs the reason. Rehearse with <code className="text-zinc-300">SIMULATE=1</code>.</li>
                    <li>Every comment is parsed with <code className="text-zinc-300">{'^#?\\d{1,3}$'}</code> — only bare numbers claim slots, everything else is ignored.</li>
                  </ul>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="obs" className="border-white/10">
                <AccordionTrigger className="text-sm font-semibold">3 · Add the overlay to OBS</AccordionTrigger>
                <AccordionContent className="text-sm text-zinc-300 space-y-2">
                  <ul className="list-disc pl-5 space-y-1.5 text-zinc-400">
                    <li>Sources → <b>Browser</b> → URL <code className="text-zinc-300">http://YOUR_VPS_IP:3000/</code></li>
                    <li>Width <b>1080</b>, Height <b>1920</b> (matches the canvas — the preview here is the same page scaled down).</li>
                    <li>Untick &quot;Shutdown source when not visible&quot; and &quot;Refresh browser when scene becomes active&quot;.</li>
                    <li>Sound: the 🔊 toggle on the overlay plays a chime on every new lock (persisted per browser). Add <code className="text-zinc-300">?sound=1</code> to force it on.</li>
                    <li>Host hotkey: focus the overlay browser source and press <b>Shift+R</b> to reset the round (loads the key from <code className="text-zinc-300">?key=…</code> or localStorage).</li>
                  </ul>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="api" className="border-white/10">
                <AccordionTrigger className="text-sm font-semibold">4 · HTTP API &amp; realtime events</AccordionTrigger>
                <AccordionContent className="text-sm text-zinc-300 space-y-2">
                  <pre className="rounded-lg bg-black/60 border border-white/10 p-3 text-xs overflow-x-auto leading-6">
{`GET  /api/status              health + mode + tiktok/simulator info
GET  /api/state               full game-state snapshot
GET  /api/admin/winners       [x-admin-key] winner history ?round=&from=&to=
POST /api/reset               [x-admin-key] flush locks, next round
POST /api/admin/claim         [x-admin-key] { slot, username }
POST /api/admin/release       [x-admin-key] { slot }
POST /api/admin/sim           [x-admin-key] { enabled }
POST /api/admin/ad            [x-admin-key] { url|dataUrl, durationSec, caption }
POST /api/admin/ad/stop       [x-admin-key] dismiss the overlay ad
POST /api/simulate/chat       { username, comment }   (SIMULATE=1 only)
POST /api/simulate/gift       { username, giftName, count }

socket.io:  state · slot-locked · round-reset · draw-result · ad:show · ad:hide · activity`}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </section>

      {/* ── footer ── */}
      <footer className="mt-auto border-t border-white/10 bg-black/40">
        <div className="max-w-6xl mx-auto px-4 py-5 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
          <span>🔒 Locked Grid Lottery v1.0 — Node.js · Express · socket.io · tiktok-live-connector</span>
          <span className="font-mono">locked-grid-lottery/ → server.js · src/{'{config,gameState,tiktok,simulator}'}.js · public/overlay</span>
        </div>
      </footer>
    </div>
  );
}
