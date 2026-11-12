// ============================================================================
//  DEVICE CONTROL — WebSocket + Remote Command System
//  Backend គ្រប់គ្រង Location/Phone/SMS របស់ទូរសព្ទអ្នកប្រើពីចម្ងាយ
// ============================================================================

const { WebSocketServer } = require('ws');

// In-memory map: userId → Set<ws>
const connections = new Map();

function setupWebSocket(server, db, ok, fail, ApiError, handle) {
  // noServer: other upgrades (e.g. /note-ws) share this HTTP server, so a
  // path-filtered server would abort them before their owner sees them
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { return; }
    if (pathname !== '/device-ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // ── AUTH: App ផ្ញើ token ដើម្បីភ្ជាប់ ──
        if (msg.type === 'auth') {
          const jwt = require('jsonwebtoken');
          const SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
          try {
            const decoded = jwt.verify(msg.token, SECRET);
            userId = decoded.id || decoded.userId;
            if (!userId) throw new Error('no user id');

            if (!connections.has(userId)) connections.set(userId, new Set());
            connections.get(userId).add(ws);

            ws.send(JSON.stringify({ type: 'auth_ok', userId }));

            // ផ្ញើ pending commands ដែលមិនទាន់ប្រតិបត្តិ
            const pending = await db.prepare(
              `SELECT * FROM device_commands 
               WHERE user_id = ? AND status = ? 
               ORDER BY created_at ASC`
            ).all(userId, 'pending');

            for (const cmd of pending) {
              ws.send(JSON.stringify({ type: 'command', command: cmd }));
              await db.prepare(
                `UPDATE device_commands SET status = ?, sent_at = now() WHERE id = ?`
              ).run('sent', cmd.id);
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'auth_fail', error: e.message }));
            ws.close();
          }
          return;
        }

        // ── RESULT: App ផ្ញើលទ្ធផល command ──
        if (msg.type === 'result' && userId) {
          const { commandId, success, data, error } = msg;
          await db.prepare(
            `UPDATE device_commands 
             SET status = ?, result_data = ?, result_error = ?, completed_at = now()
             WHERE id = ? AND user_id = ?`
          ).run(
            success ? 'completed' : 'failed',
            data ? JSON.stringify(data) : null,
            error || null,
            commandId,
            userId
          );
          return;
        }

        // ── LOCATION UPDATE: App ផ្ញើទីតាំងជាប្រចាំ ──
        if (msg.type === 'location_update' && userId) {
          await db.prepare(
            `INSERT INTO device_locations (user_id, lat, lng, accuracy, address, recorded_at)
             VALUES (?, ?, ?, ?, ?, now())`
          ).run(userId, msg.lat, msg.lng, msg.accuracy || null, msg.address || null);
          return;
        }

      } catch (e) {
        console.error('WebSocket message error:', e);
      }
    });

    ws.on('close', () => {
      if (userId && connections.has(userId)) {
        connections.get(userId).delete(ws);
        if (connections.get(userId).size === 0) connections.delete(userId);
      }
    });
  });

  return wss;
}

// ── ផ្ញើ command ទៅអ្នកប្រើ ──
async function sendDeviceCommand(db, userId, commandType, payload = {}) {
  const result = await db.prepare(
    `INSERT INTO device_commands (user_id, command_type, payload, status, created_at)
     VALUES (?, ?, ?, 'pending', now())`
  ).run(userId, commandType, JSON.stringify(payload));

  const cmdId = result.lastInsertRowid;
  const cmd = await db.prepare('SELECT * FROM device_commands WHERE id = ?').get(cmdId);

  const wsSet = connections.get(userId);
  if (wsSet && wsSet.size > 0) {
    for (const ws of wsSet) {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify({ type: 'command', command: cmd }));
      }
    }
    await db.prepare(
      `UPDATE device_commands SET status = 'sent', sent_at = now() WHERE id = ?`
    ).run(cmdId);
    cmd.status = 'sent';
  }

  return cmd;
}

// ── ពិនិត្យថាតើអ្នកប្រើកំពុង online ឬអត់ ──
function isDeviceOnline(userId) {
  const wsSet = connections.get(userId);
  return wsSet ? wsSet.size > 0 : false;
}

// ── ចំនួនអ្នកប្រើ online ──
function deviceOnlineCount() {
  return connections.size;
}

module.exports = {
  setupWebSocket,
  sendDeviceCommand,
  isDeviceOnline,
  deviceOnlineCount,
  connections,
};
