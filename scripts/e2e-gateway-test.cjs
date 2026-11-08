// E2E gateway test: connect like the overlay would, then trigger a claim via HTTP and expect slot-locked event
const { io } = require('socket.io-client');

const socket = io('http://localhost:81/?XTransformPort=3003', {
  transports: ['websocket', 'polling'],
  forceNew: true,
  timeout: 8000,
});

let gotState = false;
let gotLock = false;

socket.on('connect', () => console.log('✓ socket connected through gateway, id =', socket.id));
socket.on('state', (s) => {
  gotState = true;
  console.log(`✓ state received: round=${s.round} claimed=${s.claimedCount}/${s.totalSlots}`);
});
socket.on('slot-locked', (d) => {
  gotLock = true;
  console.log(`✓ slot-locked event: slot=${d.slot} user=${d.entry.uniqueId}`);
  finish();
});
socket.on('activity:history', (ev) => console.log(`✓ activity history: ${ev.length} events`));
socket.on('connect_error', (e) => { console.log('✗ connect_error:', e.message); process.exit(1); });

setTimeout(async () => {
  if (!gotState) { console.log('✗ no state within 6s'); process.exit(1); }
  console.log('→ triggering claim via HTTP API (through gateway)…');
  const res = await fetch('http://localhost:81/api/simulate/chat?XTransformPort=3003', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'e2e_probe', comment: '9' }),
  });
  const j = await res.json();
  console.log('→ claim response:', JSON.stringify(j));
  setTimeout(() => {
    if (!gotLock) { console.log('✗ slot-locked event NOT received'); process.exit(1); }
  }, 3000);
}, 4000);

function finish() {
  console.log('\n★ E2E GATEWAY TEST PASSED ★');
  // cleanup: release probe slot
  fetch('http://localhost:81/api/admin/release?XTransformPort=3003', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'sandbox-admin' },
    body: JSON.stringify({ slot: 9 }),
  }).then(() => process.exit(0));
}
