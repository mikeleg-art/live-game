// Client-side test: io('/?XTransformPort=3999') through the Caddy gateway on :81
const { io } = require('socket.io-client');

const URI = process.argv[2] || '/?XTransformPort=3999';
const EXTRA = process.argv[3] ? JSON.parse(process.argv[3]) : {};

// Resolve relative URI against gateway origin
const origin = 'http://localhost:81';
const socket = io(origin + URI, {
  transports: ['websocket', 'polling'],
  forceNew: true,
  reconnectionAttempts: 2,
  timeout: 6000,
  ...EXTRA,
});

socket.on('connect', () => {
  console.log(`[client ${URI} ${JSON.stringify(EXTRA)}] CONNECTED, id=${socket.id}`);
  socket.emit('ping-back', { from: URI, extra: EXTRA });
  setTimeout(() => { socket.disconnect(); process.exit(0); }, 1500);
});
socket.on('hello', (d) => console.log('[client] hello event:', JSON.stringify(d)));
socket.on('connect_error', (e) => console.log(`[client ${URI} ${JSON.stringify(EXTRA)}] CONNECT_ERROR: ${e.message}`));
socket.io.on('reconnect_failed', () => { console.log('[client] reconnect failed'); process.exit(1); });

setTimeout(() => { console.log('[client] TIMEOUT'); process.exit(1); }, 9000);
