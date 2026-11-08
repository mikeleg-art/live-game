// Empirical test: which socket.io server path + client URI combo works through the Caddy gateway
const { createServer } = require('http');
const { Server } = require('socket.io');

const MODE = process.argv[2] || 'default'; // 'default' | 'root'
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, url: req.url }));
});

const pathOpt = MODE === 'root' ? '/' : '/socket.io';
const io = new Server(httpServer, { path: pathOpt, cors: { origin: '*' } });
io.on('connection', (s) => {
  console.log(`[server ${MODE}] client connected: ${s.id}`);
  s.emit('hello', { mode: MODE, path: pathOpt });
  s.on('ping-back', (d) => console.log(`[server ${MODE}] ping-back`, JSON.stringify(d)));
});

httpServer.listen(3999, () => console.log(`[server ${MODE}] listening on 3999 with path ${pathOpt}`));
