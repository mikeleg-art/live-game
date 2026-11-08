# 🔒 Locked Grid Lottery

An **interactive TikTok LIVE grid game** for streamers. Viewers claim numbered slots (1–10) by typing the number in the stream chat — **first come, first served**, enforced atomically. A real-time OBS overlay (1080×1920 vertical) shows the grid, each winner's avatar + nickname, a claimed-slots feed, gift shout-outs and activity ticker.

When the grid fills up, the game runs a **keno-style winner draw**: the numbers roll on screen, a lucky number is picked among the claimed slots, the winner celebrates with confetti — and a few seconds later the next round starts automatically, with the last winner's username shown on top of their winning number (👑).

```
   ┌───────────────────────────────┐        ┌──────────────────────────────┐
   │  TikTok LIVE (WebSocket API)  │        │  OBS Browser Source 1080×1920│
   │  chat comments • gift events  │        │  http://YOUR_VPS:3000/       │
   └───────────────┬───────────────┘        └───────────────▲──────────────┘
                   │ tiktok-live-connector                  │ socket.io
           ┌───────▼────────────────────────────────────────┴───────┐
           │              Node.js server (Express + socket.io)      │
           │  • atomic slot locking (1 slot / user, 1..10)          │
           │  • admin API (/api/reset, release, manual award)       │
           │  • built-in simulator for rehearsals (SIMULATE=1)      │
           └────────────────────────────────────────────────────────┘
```

## Features

- ⚛️ **Atomic first-come locking** — range check → slot-free check → one-slot-per-user check, executed as a synchronous critical section on Node's single-threaded event loop (no race conditions, no double claims).
- 🎯 **Keno winner draw** — when the grid completes (or the host fires `Draw winner`), the server rolls the claimed numbers live (identical tick stream to every viewer), crowns a winner, celebrates with confetti + fanfare, then auto-starts the next round. The 👑 last winner stays pinned on top of their winning number.
- 🏆 **Winner history** — every crowned winner is persisted to `data/winners.json` and listed on the admin panel / control center, filterable **by round and by date range** (Today / Last 7 days / All time). The table refreshes itself after each draw.
- 🔊 **Rich WebAudio sound pack** — asset-free layered SFX (lock pop, reject thud, gift sparkle, keno roll ticks, winner fanfare, round whoosh, ad swoosh) that work offline in OBS, Chrome, Safari and Firefox; toggle + `?sound=1` supported.
- 📣 **Overlay ads** — push an image, animated GIF or short video (mp4/webm/mov) to every overlay from the admin panel / control center (file upload ≤48 MB or hosted URL). The ad pops up fullscreen with caption + countdown bar and dismisses itself after 2–300 s — videos also close when they finish. Autoplay-safe: unmuted where allowed, auto-muted fallback everywhere else.
- 🎨 **1080×1920 OBS overlay** — neon TikTok-style grid, open/locked card states, circular avatar frames (auto initials fallback), pulse animation + optional WebAudio chime on every new lock, NEW-ROUND flash, gift toasts, activity ticker.
- 🏆 **Claimed Slots feed** — ordered 1→10 with avatar, @username and lock time; the winning row wears a crown.
- 🛠 **Host controls** — authenticated reset route, admin panel (`/admin.html`) with grid mirror (click a slot to free it), manual award, slot release, **Draw winner** button, simulator toggle and live event log. `Shift+R` hotkey on the overlay resets when a key is configured.
- 🤖 **Simulator** — fake viewers chat, claim, get rejected and send gifts through the *same pipeline* as real TikTok events, so you can rehearse everything offline.
- 🔌 **tiktok-live-connector v2** (with v1 fallback detection), auto-reconnect with backoff, graceful degradation.

## Quick start

### Windows — double-click (easiest)

1. **Extract the ZIP** (right-click → *Extract All…*). You get a `locked-grid-lottery` folder.
2. Open that folder and **double-click `START-WINDOWS.bat`**.
3. First run installs everything automatically (~1 minute), then the game starts and the admin panel opens in your browser: `http://localhost:3000/admin.html`.

> Keep the black console window open while you play. Close it (or Ctrl+C) to stop the game.

### macOS / Linux / VPS

```bash
cd locked-grid-lottery
./start.sh              # installs deps on first run, then starts the server
```

### Manual (any OS)

```bash
cd locked-grid-lottery   # ⚠ run commands INSIDE this folder — server.js lives here
npm install
cp .env.example .env    # then edit values (see below)
node server.js          # dev: npm run dev (auto-restart)

# Overlay (add to OBS):  http://localhost:3000/
# Admin panel:           http://localhost:3000/admin.html
```

Open the overlay URL, enable the simulator (admin panel → Simulation → auto-sim) and watch fake viewers fill the grid.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Error: Cannot find module '...\server.js'` | You are in the wrong folder. The ZIP extracts into a **nested** `locked-grid-lottery` folder — `cd` into **that** folder (the one that actually contains `server.js`), then `node server.js`. Or simply double-click `START-WINDOWS.bat`. Also make sure you extracted the **latest** ZIP. |
| `node` / `'node' is not recognized` | Install Node.js LTS from <https://nodejs.org>, reopen the terminal, try again. |
| `npm install` fails / hangs | Check your internet/proxy. Try `npm config set registry https://registry.npmjs.org/`, delete the `node_modules` folder and retry. |
| Port 3000 already in use | Set `PORT=3001` in `.env` and use `http://localhost:3001/` in OBS. |
| Admin panel says "invalid admin key" | The key is in `.env` (`ADMIN_KEY`, default `changeme`). Type it in the admin panel's key field. |
| TikTok chat not coming through | The account must be **LIVE** when you set `TIKTOK_USERNAME`; the bridge retries automatically. Rehearse first with the simulator (`SIMULATE=1`). |

## Configuration (`.env`)

| Variable            | Default    | Description                                                                     |
| ------------------- | ---------- | ------------------------------------------------------------------------------- |
| `PORT`              | `3000`     | HTTP port for overlay + API                                                     |
| `HOST`              | `0.0.0.0`  | Bind address                                                                    |
| `TIKTOK_USERNAME`   | *(empty)*  | TikTok username to connect to (no `@`). **Must be live** for chat events.        |
| `ADMIN_KEY`         | `changeme` | Secret for `/api/reset` & admin routes (`x-admin-key` header). **Change it!**    |
| `SIMULATE`          | auto       | `1` = enable simulator + open simulate endpoints. Auto-on if no username set.   |
| `AUTO_SIM`          | `0`        | `1` = start the auto-claim loop at boot (demo mode).                             |
| `AUTO_DRAW`         | `1`        | `1` = auto-run the keno winner draw a moment after the grid fills.               |
| `DRAW_PRE_DELAY_MS` | `2600`     | Pause after the grid fills / admin triggers before the numbers start rolling.    |
| `DRAW_ROLL_MS`      | `5000`     | How long the keno roll lasts.                                                    |
| `DRAW_TICK_MS`      | `130`      | Interval between rolling numbers.                                                |
| `CELEBRATE_MS`      | `6500`     | Winner celebration time before the next round starts automatically.              |
| `SIM_AUTO_RESET`    | `1`        | Legacy: auto-reset instead of a draw when `AUTO_DRAW=0` (demo loop).             |
| `TOTAL_SLOTS`       | `10`       | Grid size (spec: 10).                                                            |
| `TIKTOK_MAX_RETRIES`| `5`        | Reconnect attempts before giving up.                                             |

## Going live on TikTok

1. Set `TIKTOK_USERNAME=<your handle>` and `SIMULATE=0`, pick a strong `ADMIN_KEY`, restart.
2. Start your TikTok LIVE. The server connects via the unofficial WebSocket API (`tiktok-live-connector`) and shows the status in the admin panel. If the stream is offline the bridge retries with backoff.
3. Viewers type a bare number (`7` or `#7`) in chat → first valid comment for a free slot wins it. Non-numbers, taken slots and duplicate users are ignored politely in the ticker.
4. Fresh grid: automatic — after every completed draw the next round starts by itself. You can also force it: admin panel → **Reset round**, `POST /api/reset`, or the overlay `Shift+R` hotkey. Fire the draw early with **Draw winner** (`POST /api/admin/draw`).

> TikTok's live API is unofficial; protocol changes or sign-service hiccups can interrupt chat. The overlay keeps working and the bridge auto-reconnects. Always rehearse with `SIMULATE=1`.

## OBS Browser Source setup

1. Sources → **+** → **Browser**.
2. URL: `http://YOUR_VPS_IP:3000/` — Width **1080**, Height **1920**.
3. Untick *Shutdown source when not visible* and *Refresh browser when scene becomes active*.
4. Optional URL flags: `?sound=1` (force chime on), `?key=<ADMIN_KEY>` (enables `Shift+R` reset hotkey).
5. The 🔊 button on the overlay toggles the claim chime (saved per browser profile).

## HTTP API

All admin routes expect the key as `x-admin-key` header (or `?key=`).

| Method | Route                | Auth            | Body                              | Description                     |
| ------ | -------------------- | --------------- | --------------------------------- | ------------------------------- |
| GET    | `/api/status`        | —               | —                                 | health, mode, TikTok/sim status |
| GET    | `/api/state`         | —               | —                                 | full game-state snapshot        |
| GET    | `/api/health`        | —               | —                                 | liveness probe                  |
| GET    | `/api/admin/winners` | admin key       | `?round=&from=&to=&limit=`        | winner history (epoch-ms dates) |
| POST   | `/api/reset`         | admin key       | —                                 | flush locks, start next round   |
| POST   | `/api/admin/claim`   | admin key       | `{ slot, username }`              | manually award a slot           |
| POST   | `/api/admin/release` | admin key       | `{ slot }`                        | free a single slot              |
| POST   | `/api/admin/sim`     | admin key       | `{ enabled }`                     | toggle simulator (SIMULATE=1)   |
| POST   | `/api/admin/draw`    | admin key       | —                                 | start the keno winner draw now  |
| POST   | `/api/admin/ad`      | admin key       | `{ url\|dataUrl, kind?, durationSec?, caption? }` | push an image/GIF/video ad to the overlay (2–300 s, ≤48 MB upload) |
| POST   | `/api/admin/ad/stop` | admin key       | —                                 | dismiss the overlay ad now      |
| POST   | `/api/simulate/chat` | admin or SIM=1  | `{ username, comment }`           | inject a chat comment           |
| POST   | `/api/simulate/gift` | admin or SIM=1  | `{ username, giftName, count }`   | inject a gift                   |

**socket.io events** — `state` (full snapshot), `slot-locked`, `slot-released`, `round-reset`, `draw-started`, `draw-tick`, `draw-result`, `ad:show`, `ad:hide`, `gift-received`, `activity`, `server`.

**Winner history** is persisted to `data/winners.json` (survives restarts) and listed in the admin panel / control center with **round** and **date-range** filters (Today / Last 7 days / All time shortcuts). Uploaded ad media lands in `public/uploads/` and is served same-origin; files older than 7 days are cleaned up automatically.

## How the atomic lock works (spec §3)

```js
function tryClaim(state, slotNumber, user) {
  // 1. range check            -> OUT_OF_RANGE
  // 2. if (state.slots[slot]) -> SLOT_TAKEN
  // 3. if (userToSlot.has(userId)) -> USER_HAS_SLOT
  // 4. state.slots[slot] = entry; userToSlot.set(userId, slot);   // atomic claim
}
```

Validation and mutation run synchronously inside one event-loop tick — two comments arriving in the same millisecond can never both lock the same slot. (src/gameState.js)

## Project layout

```
locked-grid-lottery/
├── server.js              # Express + socket.io wiring, ingest pipeline, admin API
├── START-WINDOWS.bat      # Windows one-click launcher (double-click me)
├── start.sh               # Linux / macOS / VPS one-command launcher
├── src/
│   ├── config.js          # env config loader
│   ├── gameState.js       # state + atomic locking + round reset + event buffer
│   ├── store.js           # winners.json persistence + ad upload storage
│   ├── tiktok.js          # tiktok-live-connector bridge (v2/v1 feature detection)
│   └── simulator.js       # fake viewers (chat + gifts) for testing
├── public/
│   ├── index.html         # OBS overlay (1080×1920)  → served at /
│   ├── overlay.css / overlay.js
│   ├── admin.html         # host control panel       → /admin.html
│   └── admin.css / admin.js
├── data/                  # winners.json (created at runtime)
├── public/uploads/        # uploaded ad media (created at runtime)
├── .env.example
└── package.json
```

## Production notes

- Run under a process manager: `pm2 start server.js --name lottery`.
- Put Nginx/Caddy with TLS in front (socket.io works through proxied WebSockets out of the box).
- Keep `SIMULATE=0` in production so the inject endpoints require the admin key.
- The server keeps state in memory; a restart starts a fresh round (intentional for a per-stream game).
