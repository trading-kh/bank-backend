// Real-time sticky-note channel ("/note-ws").
// Admin browser tabs and the desktop app keep one socket open; every saved
// note is broadcast to the other sockets of the same admin instantly.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const rooms = new Map(); // adminId -> Set<ws>
let beat = null;

function join(adminId, ws) {
  if (!rooms.has(adminId)) rooms.set(adminId, new Set());
  rooms.get(adminId).add(ws);
}

function leave(adminId, ws) {
  const set = rooms.get(adminId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) rooms.delete(adminId);
}

function broadcast(adminId, note) {
  const set = rooms.get(adminId);
  if (!set || !set.size) return 0;
  const msg = JSON.stringify({ type: 'note', note });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(msg); sent++; } catch (_) {}
  }
  return sent;
}

function parseUrl(req) {
  try { return new URL(req.url, 'http://localhost'); } catch { return null; }
}

function attach(server, SECRET) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req);
    if (!url || url.pathname !== '/note-ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const url = parseUrl(req);
    let adminId = null;
    try {
      const p = jwt.verify(url.searchParams.get('token') || '', SECRET);
      if (p.typ !== 'admin' || !p.id) throw new Error('scope');
      adminId = p.id;
    } catch (_) {
      ws.close(4001, 'auth');
      return;
    }

    join(adminId, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      try {
        if (JSON.parse(raw.toString()).type === 'ping') ws.send('{"type":"pong"}');
      } catch (_) {}
    });
    const drop = () => leave(adminId, ws);
    ws.on('close', drop);
    ws.on('error', drop);
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  if (!beat) {
    beat = setInterval(() => {
      for (const set of rooms.values()) {
        for (const ws of set) {
          if (!ws.isAlive) { ws.terminate(); continue; }
          ws.isAlive = false;
          try { ws.ping(); } catch (_) {}
        }
      }
    }, 25000);
    if (beat.unref) beat.unref();
  }

  return wss;
}

module.exports = { attach, broadcast };
