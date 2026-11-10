// ============================================================
// ADMIN DASHBOARD API
// គ្រប់គ្រងទិន្នន័យទាំងអស់: អ្នកប្រើ, កាត, ប្រតិបត្តិការ, កម្ចី, សេចក្តីសារ, គោលបំណង...
// ចូលដោយគណនីធម្មតា (អ៊ីមែល + PIN) ប៉ុន្តែត្រូវមាន is_admin = 1
// ត្រូវ mount នៅ server.js:  app.use('/admin/api', require('./admin')(ctx))
// ============================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const createLoanAdminRouter = require('./loan-admin');
const { sendDeviceCommand, isDeviceOnline, deviceOnlineCount } = require('./device-control');

module.exports = function createAdminRouter(ctx) {
  const { db, ok, fail, ApiError, handle, SECRET, sendPushNotification, notifyUser, seedNewUser } = ctx;
  const router = express.Router();

  const ADMIN_TTL = '12h';
  const SALT = 10;
  // អ្នកប្រើ "Live" បើចុងសកម្មតាមមួយនៅក្នុង N នាទីមកចម្លង
  const ONLINE_MINUTES = Math.max(parseInt(process.env.ADMIN_ONLINE_MINUTES, 10) || 5, 1);
  const isOnline = (lastSeen) => !!lastSeen &&
    (Date.now() - new Date(lastSeen).getTime()) < ONLINE_MINUTES * 60 * 1000;
  // ការព្យាយាមចូល admin ច្រើនពេក → បិទខ្លាំងមួយរយៈពេល
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 10 * 60 * 1000;
  const loginFails = new Map();

  // ---------- helpers ----------
  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
    return Number.isFinite(n) ? n : null;
  };
  const int = (v, def = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const like = (s) => `%${String(s).toLowerCase().replace(/[%_]/g, '')}%`;
  const money = (v) => Math.round(Number(v) * 100) / 100;
  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  async function audit(req, action, targetType, targetId, detail) {
    try {
      await db.prepare(`INSERT INTO admin_audit_log
        (admin_email, action, target_type, target_id, detail)
        VALUES (?, ?, ?, ?, ?)`)
        .run(req.admin?.email || 'unknown', action, targetType,
          targetId === undefined || targetId === null ? null : String(targetId),
          detail ? String(detail).slice(0, 500) : null);
    } catch (e) {
      console.error('❌ audit log:', e.message);
    }
  }

  // បន្ថែម data_version → app ទូរសែព្យដឹងថាទិន្នន័យត្រូវ refresh ភ្លាម
  async function bumpVersion(userId) {
    if (!userId) return;
    await db.prepare('UPDATE users SET data_version = data_version + 1 WHERE id = ?').run(userId);
  }

  // ---------- admin auth ----------
  function adminAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'No token' });
    try {
      const p = jwt.verify(token, SECRET);
      if (p.typ !== 'admin') throw new Error('wrong scope');
      req.admin = { id: p.id, email: p.email, role: p.role || 'operations' };
      next();
    } catch {
      res.status(401).json({ success: false, error: 'Invalid admin token' });
    }
  }

  // Role-based access control middleware
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.admin || !roles.includes(req.admin.role)) {
        return res.status(403).json({ 
          success: false, 
          error: 'មិនមានសិទ្ធិចូលដំណើរការ',
          code: 'INSUFFICIENT_ROLE'
        });
      }
      next();
    };
  }

// ចូល admin — អាចប្រើពាក្យសម្ងាត់ (Password) ឬ PIN 4 ខ្ទង់ (គណនី Aura Bank ធម្មតា)
  // ការព្យាយាមចូលបរាជ័យ/ចុលត្រូវរាប់ ដើម្បីការពារមិនឱ្យប្រយោគប្រយោគចូល
  router.post('/login', handle(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const secret = String(req.body.password ?? req.body.pin ?? '').trim();
    if (!email || !secret) {
      throw new ApiError('សូមបញ្ចូលអ៊ីមែល និងពាក្យសម្ងាត់', 400, 'BAD_INPUT');
    }
    const key = `${email.toLowerCase()}|${req.ip || ''}`;
    const fails = loginFails.get(key);
    if (fails && fails.n >= LOGIN_MAX_FAILS && fails.until > Date.now()) {
      throw new ApiError('ការព្យាយាមចូលច្រើនពេក សូមរង់ចាំខ្លាំងមុន', 429, 'TOO_MANY_ATTEMPTS');
    }

    const u = await db.prepare(
      `SELECT id, name, email, pin_hash, password_hash, is_admin, role, locked_until
       FROM users WHERE lower(email) = lower(?)`
    ).get(email);
    if (!u) throw new ApiError('រកមិនឃើញគណនី', 404, 'NOT_FOUND');

    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new ApiError('គណនីត្រូវបានចាក់សោ', 423, 'PIN_LOCKED');
    }

    let valid = false;
    if (u.password_hash) {
      try { valid = await bcrypt.compare(secret, u.password_hash); } catch { valid = false; }
    }
    if (!valid && /^\d{4}$/.test(secret)) {
      try { valid = await bcrypt.compare(secret, u.pin_hash); } catch { valid = false; }
    }
    if (!valid) {
      if (loginFails.size > 500) loginFails.clear();
      loginFails.set(key, { n: (fails ? fails.n : 0) + 1, until: Date.now() + LOGIN_LOCK_MS });
      throw new ApiError('ពាក្យសម្ងាត់មិនត្រឹមត្រូវ', 401, 'WRONG_PIN');
    }
    loginFails.delete(key);

    // អនុញ្ញាតមូលនេះ (ADMIN_EMAILS) → ផ្តល់សិទ្ធិ admin ភ្លាម
    const allow = String(process.env.ADMIN_EMAILS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    let isAdmin = !!u.is_admin;
    if (!isAdmin && allow.includes(String(u.email).toLowerCase())) {
      await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
      isAdmin = true;
      await audit({ admin: { email: u.email } }, 'promote', 'users', u.id, 'auto តាម ADMIN_EMAILS');
    }
    if (!isAdmin) throw new ApiError('គណនីនេះមិនមានសិទ្ធិគ្រប់គ្រង', 403, 'FORBIDDEN');

    const token = jwt.sign(
      { id: u.id, email: u.email, name: u.name, role: u.role || 'operations', typ: 'admin' },
      SECRET, { expiresIn: ADMIN_TTL }
    );
    ok(res, { token, admin: { id: u.id, name: u.name, email: u.email, role: u.role || 'operations' } });
  }));

  router.get('/me', adminAuth, handle(async (req, res) => {
    const u = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.admin.id);
    ok(res, u || { ...req.admin, role: req.admin.role || 'operations' });
  }));

  // ============================================================
  // DASHBOARD STATS
  // ============================================================
  router.get('/stats', adminAuth, handle(async (req, res) => {
    const totals = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '7 days') AS new_users_7d,
        (SELECT COUNT(*) FROM cards) AS cards,
        (SELECT COALESCE(SUM(balance), 0) FROM cards) AS total_balance,
        (SELECT COUNT(*) FROM transactions) AS transactions,
        (SELECT COUNT(*) FROM transactions WHERE created_at >= now() - interval '24 hours') AS tx_24h,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions
           WHERE is_expense = 1 AND created_at >= now() - interval '30 days') AS spend_30d,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions
           WHERE is_expense = 0 AND created_at >= now() - interval '30 days') AS income_30d,
        (SELECT COUNT(*) FROM loans WHERE active = 1) AS active_loans,
        (SELECT COALESCE(SUM(principal - paid), 0) FROM loans WHERE active = 1) AS loan_outstanding,
        (SELECT COUNT(*) FROM goals) AS goals,
        (SELECT COUNT(*) FROM notifications) AS notifications,
        (SELECT COUNT(*) FROM external_transfers) AS external_transfers,
        (SELECT COUNT(*) FROM users WHERE is_locked = 1) AS locked_users,
        (SELECT COUNT(*) FROM users
          WHERE last_seen_at IS NOT NULL
            AND last_seen_at > now() - (${ONLINE_MINUTES} || ' minutes')::interval) AS online_users
    `).get();

    const daily = await db.prepare(`
      SELECT (created_at AT TIME ZONE 'Asia/Phnom_Penh')::date AS day,
             COUNT(*) AS tx,
             COALESCE(SUM(CASE WHEN is_expense = 1 THEN amount ELSE 0 END), 0) AS spent,
             COALESCE(SUM(CASE WHEN is_expense = 0 THEN amount ELSE 0 END), 0) AS income
      FROM transactions
      WHERE created_at >= now() - interval '14 days'
      GROUP BY 1 ORDER BY 1
    `).all();

    const categories = await db.prepare(`
      SELECT category, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
      FROM transactions WHERE is_expense = 1
      GROUP BY category ORDER BY total DESC LIMIT 8
    `).all();

    const topUsers = await db.prepare(`
      SELECT u.id, u.name, u.email, u.avatar_thumb,
             COALESCE(SUM(c.balance), 0) AS balance,
             (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count
      FROM users u LEFT JOIN cards c ON c.user_id = u.id
      GROUP BY u.id ORDER BY balance DESC LIMIT 8
    `).all();

    const recentUsers = await db.prepare(`
      SELECT id, name, email, phone, created_at, avatar_thumb, last_seen_at FROM users
      ORDER BY created_at DESC LIMIT 6
    `).all();

    const liveUsers = await db.prepare(`
      SELECT id, name, email, avatar_thumb, last_seen_at FROM users
      WHERE last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${ONLINE_MINUTES} || ' minutes')::interval
      ORDER BY last_seen_at DESC LIMIT 20
    `).all();

    const recentTx = await db.prepare(`
      SELECT t.id, t.title, t.category, t.amount, t.is_expense, t.created_at,
             u.id AS user_id, u.name AS user_name
      FROM transactions t JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC LIMIT 8
    `).all();

    ok(res, { totals, daily, categories, topUsers, recentUsers, liveUsers, recentTx,
      online_minutes: ONLINE_MINUTES });
  }));

  // ============================================================
  // USERS
  // ============================================================
  router.get('/users', adminAuth, handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(int(req.query.limit, 25), 1), 1000);
    const offset = Math.max(int(req.query.offset, 0), 0);
    const sortKey = {
      id: 'u.id', name: 'lower(u.name)', balance: 'balance', tx: 'tx_count',
      created: 'u.created_at', seen: 'u.last_seen_at',
    }[String(req.query.sort || 'created')] || 'u.id';
    const dir = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const rows = await db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.auth_provider, u.is_admin, u.is_locked, u.role,
             u.pin_attempts, u.locked_until, u.created_at, u.last_seen_at, u.avatar_thumb,
             (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id) AS card_count,
             (SELECT COALESCE(SUM(c.balance), 0) FROM cards c WHERE c.user_id = u.id) AS balance,
             (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count,
             (SELECT MAX(t.created_at) FROM transactions t WHERE t.user_id = u.id) AS last_tx
      FROM users u
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR u.phone LIKE ?)
      ORDER BY ${sortKey} ${dir}, u.id DESC LIMIT ? OFFSET ?
    `).all(q, like(q), like(q), like(q), limit, offset);
    const total = (await db.prepare(`
      SELECT COUNT(*) AS n FROM users u
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR u.phone LIKE ?)
    `).get(q, like(q), like(q), like(q))).n;
    ok(res, {
      rows: rows.map((r) => ({ ...r, online: isOnline(r.last_seen_at) })),
      total, limit, offset, online_minutes: ONLINE_MINUTES,
    });
  }));

  router.get('/users/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const user = await db.prepare(`
      SELECT id, name, email, phone, auth_provider, is_admin, is_locked, role, pin_attempts,
             locked_until, created_at, avatar_thumb, last_seen_at
      FROM users WHERE id = ?`).get(id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');

    const [cards, transactions, loans, goals, budgets, notifications, referrals] = await Promise.all([
      db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(id),
      db.prepare(`SELECT * FROM transactions WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 50`).all(id),
      db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC').all(id),
      db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id').all(id),
      db.prepare('SELECT * FROM budgets WHERE user_id = ? ORDER BY id').all(id),
      db.prepare(`SELECT * FROM notifications WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 30`).all(id),
      db.prepare('SELECT * FROM referrals WHERE user_id = ?').all(id),
    ]);
    ok(res, {
      user: { ...user, online: isOnline(user.last_seen_at) },
      cards, transactions, loans, goals, budgets, notifications, referrals,
    });
  }));

  router.patch('/users/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');

    const fields = [];
    const values = [];
    const push = (col, val) => { fields.push(`${col} = ?`); values.push(val); };

    if (req.body.name !== undefined) push('name', String(req.body.name).trim().slice(0, 80));
    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim().toLowerCase();
      if (!email.includes('@')) throw new ApiError('អ៊ីមែលមិនត្រឹមត្រូវ', 400, 'BAD_EMAIL');
      const dup = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?')
        .get(email, id);
      if (dup) throw new ApiError('អ៊ីមែលនេះមានរួចហើយ', 409, 'DUPLICATE');
      push('email', email);
    }
    if (req.body.phone !== undefined) push('phone', String(req.body.phone).trim().slice(0, 30));
    if (req.body.is_admin !== undefined) {
      const isAdmin = req.body.is_admin === true || req.body.is_admin === 1 || req.body.is_admin === '1';
      if (id === req.admin.id && !isAdmin) {
        throw new ApiError('មិនអាចដកសិទ្ធិ admin ពីខ្លួនឯង', 400, 'SELF_DEMOTE');
      }
      push('is_admin', isAdmin ? 1 : 0);
    }
    if (req.body.is_locked !== undefined) {
      const locked = req.body.is_locked === true || req.body.is_locked === 1 || req.body.is_locked === '1';
      if (id === req.admin.id && locked) {
        throw new ApiError('មិនអាចផ្អាកគណនីខ្លួនឯង', 400, 'SELF_LOCK');
      }
      push('is_locked', locked ? 1 : 0);
    }
    if (req.body.role !== undefined) {
      const validRoles = ['management', 'administration', 'operations'];
      const role = String(req.body.role).toLowerCase();
      if (!validRoles.includes(role)) {
        throw new ApiError('Role មិនត្រឹមត្រូវ', 400, 'INVALID_ROLE');
      }
      if (id === req.admin.id && role !== 'management') {
        throw new ApiError('មិនអាចបន្ថយ role ខ្លួនឯងពី management', 400, 'SELF_DEMOTE_ROLE');
      }
      push('role', role);
    }
    if (req.body.unlock === true) {
      push('pin_attempts', 0);
      push('locked_until', null);
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');

    values.push(id);
    await db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    await bumpVersion(id);
    await audit(req, 'update_user', 'users', id,
      fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, await db.prepare('SELECT id, name, email, phone, is_admin, created_at FROM users WHERE id = ?').get(id));
  }));

  router.post('/users/:id/pin', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const pin = String(req.body.pin || '');
    if (!/^\d{4}$/.test(pin)) throw new ApiError('PIN ត្រូវមាន 4 ខ្ទង់', 400, 'BAD_PIN');
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');
    const hash = await bcrypt.hash(pin, SALT);
    await db.prepare('UPDATE users SET pin_hash = ?, pin_attempts = 0, locked_until = NULL WHERE id = ?')
      .run(hash, id);
    await bumpVersion(id);
    await audit(req, 'reset_pin', 'users', id);
    ok(res, { id, message: 'បានកំណត់ PIN ថ្មី' });
  }));

  // Reset — លុបទិន្នន័យទាំងអស់របស់អ្នកប្រើ ហើយបង្កើតឡើងវិញ (កាត + គោលបំណង)
  router.post('/users/:id/reset', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const user = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');

    const keepAvatar = req.body.keep_avatar === true;
    const reseed = req.body.reseed !== false;
    const newPin = req.body.pin ? String(req.body.pin) : null;
    if (newPin && !/^\d{4}$/.test(newPin)) {
      throw new ApiError('PIN ត្រូវមាន 4 ខ្ទង់', 400, 'BAD_PIN');
    }

    const WIPE = [
      'external_transfers', 'transactions', 'cards', 'loans', 'goals', 'budgets',
      'reminders', 'recurring', 'splits', 'virtual_cards', 'cashback',
      'notifications', 'streaks', 'achievements', 'referrals', 'fcm_tokens',
      'idempotency_keys',
    ];
    const removed = {};
    await db.transaction(async () => {
      for (const t of WIPE) {
        const r = await db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
        removed[t] = r.changes;
      }
      if (!keepAvatar) {
        await db.prepare('UPDATE users SET avatar = NULL, avatar_thumb = NULL WHERE id = ?').run(id);
      }
      await db.prepare(
        'UPDATE users SET pin_attempts = 0, locked_until = NULL WHERE id = ?'
      ).run(id);
      if (newPin) {
        const hash = await bcrypt.hash(newPin, SALT);
        await db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hash, id);
      }
    });

    if (reseed && seedNewUser) await seedNewUser(id);

    await bumpVersion(id);
    await audit(req, 'reset_user', 'users', id,
      `wipe:${WIPE.filter((t) => removed[t]).join(',')}`);
    ok(res, { id, removed, reseeded: reseed, message: 'បានកំណត់ឡើងវិញ' });
  }));

  // ---------- Reset all balances to 0 ----------
  router.post('/reset-all-balances', adminAuth, handle(async (req, res) => {
    await db.transaction(async () => {
      await db.prepare('UPDATE cards SET balance = 0').run();
      await db.prepare('UPDATE goals SET saved = 0').run();
    });
    
    const cards = await db.prepare('SELECT COUNT(*) as count FROM cards').get();
    await audit(req, 'reset_all_balances', 'cards', 0, `reset ${cards.count} cards to 0`);
    ok(res, { 
      message: 'បានកំណត់សមតុល្យទាំងអស់ទៅ 0',
      cards_reset: cards.count 
    });
  }));

  router.delete('/users/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    if (id === req.admin.id) throw new ApiError('មិនអាចលុបគណនីខ្លួនឯង', 400, 'SELF_DELETE');
    const user = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    await audit(req, 'delete_user', 'users', id, user.name);
    ok(res, { id, message: 'បានលុបគណនី' });
  }));

  // ============================================================
  // CARDS
  // ============================================================
  router.get('/cards', adminAuth, handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 300);
    const offset = Math.max(int(req.query.offset, 0), 0);
    const rows = await db.prepare(`
      SELECT c.*, u.name AS user_name, u.email AS user_email, u.avatar_thumb
      FROM cards c JOIN users u ON u.id = c.user_id
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(c.name) LIKE ?)
      ORDER BY c.id DESC LIMIT ? OFFSET ?
    `).all(q, like(q), like(q), like(q), limit, offset);
    const total = (await db.prepare(`
      SELECT COUNT(*) AS n FROM cards c JOIN users u ON u.id = c.user_id
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(c.name) LIKE ?)
    `).get(q, like(q), like(q), like(q))).n;
    ok(res, { rows, total, limit, offset });
  }));

  router.patch('/cards/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const card = await db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    if (!card) throw new ApiError('រកមិនឃើញកាត', 404, 'NOT_FOUND');

    const fields = [];
    const values = [];
    const push = (col, val) => { fields.push(`${col} = ?`); values.push(val); };

    if (req.body.name !== undefined) push('name', String(req.body.name).slice(0, 60));
    if (req.body.balance !== undefined) {
      const b = num(req.body.balance);
      if (b === null || b < 0) throw new ApiError('សម្រាប់ត្រូវ ≥ 0', 400, 'BAD_BALANCE');
      push('balance', money(b));
    }
    if (req.body.frozen !== undefined) push('frozen', req.body.frozen ? 1 : 0);
    if (req.body.online !== undefined) push('online', req.body.online ? 1 : 0);
    if (req.body.daily_limit !== undefined) {
      const l = num(req.body.daily_limit);
      if (l === null || l < 0) throw new ApiError('ដីហទិតត្រូវ ≥ 0', 400, 'BAD_LIMIT');
      push('daily_limit', money(l));
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');

    values.push(id);
    await db.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    await bumpVersion(card.user_id);
    const after = await db.prepare('SELECT balance FROM cards WHERE id = ?').get(id);
    const delta = money(Number(after.balance)) - money(Number(card.balance));
    if (delta !== 0 && sendPushNotification) {
      sendPushNotification(card.user_id,
        delta > 0 ? 'ប្រាក់បានបញ្ចូលចូលគណនីរបស់អ្នក' : 'ប្រាក់ត្រូវបានកាត់ចេញ',
        `កាត ${card.name} · ${delta > 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)} · សមារាល្ថបន្តិដោយអ្នកគ្រប់គ្រង`,
        { type: 'admin', bank_code: 'AURA' });
    }
    await audit(req, 'update_card', 'cards', id, fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, await db.prepare('SELECT * FROM cards WHERE id = ?').get(id));
  }));

  router.post('/users/:id/cards', adminAuth, handle(async (req, res) => {
    const userId = int(req.params.id);
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');
    const name = String(req.body.name || 'កាត').slice(0, 60);
    const number = String(req.body.number || '').replace(/\s/g, '');
    const expiry = String(req.body.expiry || '12/28');
    const cvv = String(req.body.cvv || '123');
    const balance = money(Math.max(num(req.body.balance) || 0, 0));
    const color1 = int(req.body.color1, 0xFF0052D4);
    const color2 = int(req.body.color2, 0xFF4364F7);
    const info = await db.prepare(`INSERT INTO cards
      (user_id, name, number, expiry, cvv, balance, color1, color2)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, name, number, expiry, cvv, balance, color1, color2);
    await bumpVersion(userId);
    await audit(req, 'create_card', 'cards', info.lastInsertRowid, `user ${userId}`);
    ok(res, await db.prepare('SELECT * FROM cards WHERE id = ?').get(info.lastInsertRowid));
  }));

  router.delete('/cards/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const card = await db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    if (!card) throw new ApiError('រកមិនឃើញកាត', 404, 'NOT_FOUND');
    await db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    await bumpVersion(card.user_id);
    await audit(req, 'delete_card', 'cards', id, card.name);
    ok(res, { id, message: 'បានលុបកាត' });
  }));

  // ============================================================
  // TRANSACTIONS
  // ============================================================
  router.get('/transactions', adminAuth, handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const userId = req.query.user_id ? int(req.query.user_id) : null;
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 300);
    const offset = Math.max(int(req.query.offset, 0), 0);

    const rows = await db.prepare(`
      SELECT t.*, u.name AS user_name, u.email AS user_email, u.avatar_thumb, c.name AS card_name
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN cards c ON c.id = t.card_id
      WHERE (?::text = '' OR lower(t.title) LIKE ? OR lower(t.category) LIKE ?
                   OR lower(u.name) LIKE ? OR lower(u.email) LIKE ?)
        AND (?::text = '' OR t.user_id = ?::int)
        AND (?::text = '' OR (t.created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
              >= COALESCE(NULLIF(?::text, '')::date, DATE '2000-01-01'))
        AND (?::text = '' OR (t.created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
              <= COALESCE(NULLIF(?::text, '')::date, DATE '2999-12-31'))
      ORDER BY t.created_at DESC LIMIT ? OFFSET ?
    `).all(q, like(q), like(q), like(q), like(q),
      userId === null ? '' : String(userId), userId === null ? 0 : userId,
      from, from, to, to, limit, offset);

    const agg = await db.prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(CASE WHEN t.is_expense = 1 THEN t.amount ELSE 0 END), 0) AS spent,
             COALESCE(SUM(CASE WHEN t.is_expense = 0 THEN t.amount ELSE 0 END), 0) AS income
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE (?::text = '' OR lower(t.title) LIKE ? OR lower(t.category) LIKE ?
                   OR lower(u.name) LIKE ? OR lower(u.email) LIKE ?)
        AND (?::text = '' OR t.user_id = ?::int)
        AND (?::text = '' OR (t.created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
              >= COALESCE(NULLIF(?::text, '')::date, DATE '2000-01-01'))
        AND (?::text = '' OR (t.created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
              <= COALESCE(NULLIF(?::text, '')::date, DATE '2999-12-31'))
    `).get(q, like(q), like(q), like(q), like(q),
      userId === null ? '' : String(userId), userId === null ? 0 : userId,
      from, from, to, to);

    ok(res, { rows, total: agg.n, spent: agg.spent, income: agg.income, limit, offset });
  }));

  // បញ្ចូល/កែប្រតិបត្តិការដោយដៃ (កែសម្រាប់កាតក្នុងដំណើរថ្មីភ្លាម)
  router.post('/transactions', adminAuth, handle(async (req, res) => {
    const userId = int(req.body.user_id);
    const cardId = int(req.body.card_id);
    const title = String(req.body.title || '').trim().slice(0, 100);
    const category = String(req.body.category || 'ផ្សេងៗ').trim().slice(0, 50);
    const amount = money(num(req.body.amount) || 0);
    const isExpense = req.body.is_expense === true || req.body.is_expense === 1 || req.body.is_expense === '1';
    if (!title) throw new ApiError('សូមបញ្ចូលចំណងជើង', 400, 'BAD_INPUT');
    if (!(amount > 0)) throw new ApiError('ចំនួនលុយត្រូវ > 0', 400, 'BAD_AMOUNT');

    const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId);
    if (!card) throw new ApiError('រកមិនឃើញកាត', 404, 'NOT_FOUND');

    const id = await db.transaction(async () => {
      const delta = isExpense ? -amount : amount;
      const upd = await db.prepare(`UPDATE cards SET balance = ROUND(balance + ?, 2)
        WHERE id = ? AND balance + ? >= 0`).run(delta, card.id, delta);
      if (upd.changes !== 1) throw new ApiError('សម្រាប្រាសម្ដ្នាន់', 400, 'INSUFFICIENT_FUNDS');
      const info = await db.prepare(`INSERT INTO transactions
        (user_id, card_id, title, category, amount, is_expense, icon_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, card.id, title, category, amount, isExpense ? 1 : 0, 0);
      await db.prepare(`INSERT INTO notifications (user_id, title, body, icon_code)
        VALUES (?, ?, ?, 0)`)
        .run(userId, isExpense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
          `${title} ${isExpense ? '-' : '+'}$${amount.toFixed(2)}`);
      return info.lastInsertRowid;
    });
    await audit(req, 'create_transaction', 'transactions', id, `${title} ${amount}`);
    await bumpVersion(userId);
    if (sendPushNotification) {
      sendPushNotification(userId,
        isExpense ? 'មានប្រតិបត្តិការចំណាយលើគណនីរបស់អ្នក' : 'មានប្រតិបត្តិការបញ្ចូលលុយចូលគណនីរបស់អ្នក',
        `${title} · ${isExpense ? '-' : '+'}$${amount.toFixed(2)} · សមារាល្ថបន្តិដោយអ្នកគ្រប់គ្រង`,
        { type: 'admin', bank_code: 'AURA' });
    }
    ok(res, { id, new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id)).balance });
  }));

  router.delete('/transactions/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const tx = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) throw new ApiError('រកមិនឃើញប្រតិបត្តិការ', 404, 'NOT_FOUND');
    await db.transaction(async () => {
      const delta = tx.is_expense ? tx.amount : -tx.amount;
      await db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?')
        .run(delta, tx.card_id);
      await db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      // លុបប្រតិបត្តិការដែលកំពុងរង់ចាំ → បោះបង់ការអនុម័ត (ប្រាក់បានបង្វិលខាងលើហើយ)
      if (tx.transfer_ref) {
        await db.prepare(`UPDATE transfer_approvals
          SET status = 'rejected', decided_by = 'admin', decided_at = now(),
              response = ?
          WHERE transfer_ref = ? AND status IN ('pending', 'holding')`).run(
          JSON.stringify({ rejected: true, deleted: true,
            reason: 'deleted_by_admin', refunded: true }),
          tx.transfer_ref);
      }
    });
    await bumpVersion(tx.user_id);
    if (notifyUser) {
      await notifyUser(tx.user_id,
        'មានប្រតិបត្តិការត្រូវបានលុប',
        `${tx.title} · ${tx.is_expense ? '-' : '+'}$${Number(tx.amount).toFixed(2)} · សមារាល្ថបន្តិដោយអ្នកគ្រប់គ្រង`,
        { type: 'admin' });
    }
    await audit(req, 'delete_transaction', 'transactions', id, tx.title);
    ok(res, { id, message: 'បានលុបប្រតិបត្តិការ' });
  }));

  // ============================================================
  // TRANSFER APPROVALS — Admin អនុម័តរាល់ប្រតិបត្តិការចេញ
  // (auto sweep នៅសល់សម្រាប់តែកំណត់ត្រាចាស់ដែល auto_approve = 1)
  // ============================================================
  const AUTO_APPROVE_DELAY_MS = 9000;   // ត្រូវនឹង animation ៣ ជំហានរបស់ app
  const AUTO_REJECT_DELAY_MS = 60 * 1000;
  let sweeping = false;

  async function applyApproval(id, decidedBy) {
    const out = await db.transaction(async () => {
      const a = await db.prepare('SELECT * FROM transfer_approvals WHERE id = ?').get(id);
      if (!a) throw new ApiError('រកមិនឃើញការផ្ទេរ', 404, 'NOT_FOUND');
      const upd = await db.prepare(`UPDATE transfer_approvals
        SET status = 'approved', decided_at = now(), decided_by = ?
        WHERE id = ? AND status IN ('pending', 'holding')`).run(decidedBy, id);
      if (upd.changes !== 1)
        throw new ApiError('ការផ្ទេរនេះត្រូវបានសម្រេចរួចហើយ', 409, 'ALREADY_DECIDED');

      const meta = a.meta ? JSON.parse(a.meta) : {};
      const sender = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.sender_id);
      const notes = [];
      let response;
      let inTxId = null;

      if (a.kind === 'p2p') {
        const recipient = await db.prepare('SELECT id, name FROM users WHERE id = ?')
          .get(a.recipient_id);
        const rc = await db.prepare(
          'SELECT id FROM cards WHERE user_id = ? AND frozen = 0 ORDER BY id LIMIT 1')
          .get(a.recipient_id);
        if (!recipient || !rc)
          throw new ApiError('គណនីអ្នកទទួលមិនអាចទទួលប្រាក់បាន', 400, 'RECIPIENT_UNAVAILABLE');

        await db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?')
          .run(a.amount, rc.id);
        const noteSuffix = a.note ? ` · ${a.note}` : '';
        inTxId = (await db.prepare(`INSERT INTO transactions
          (user_id, card_id, title, category, amount, is_expense, icon_code,
           counterparty_id, transfer_ref, status)
          VALUES (?, ?, ?, 'ផ្ទេរប្រាក់', ?, 0, 18, ?, ?, 'completed')`)
          .run(recipient.id, rc.id,
            `ទទួលពី ${sender.name}${noteSuffix}`.slice(0, 100),
            a.amount, sender.id, a.transfer_ref)).lastInsertRowid;
        await db.prepare(`UPDATE transactions SET status = 'completed' WHERE id = ?`)
          .run(a.out_tx_id);

        notes.push({
          user_id: a.sender_id, title: 'ផ្ទេរប្រាក់ជោគជ័យ',
          body: `ផ្ទេរ $${Number(a.amount).toFixed(2)} ទៅ ${recipient.name}`,
          bank_code: 'AURA', type: 'transfer_sent',
        });
        notes.push({
          user_id: recipient.id, title: 'បានទទួលប្រាក់',
          body: `លោកអ្នកបានទទួលប្រាក់ចំនួន $${Number(a.amount).toFixed(2)} ពីឈ្មោះ ${sender.name}`,
          bank_code: 'AURA', type: 'transfer_received',
        });

        response = {
          approved: true, transfer_ref: a.transfer_ref,
          id: a.out_tx_id, in_tx_id: inTxId,
          new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?')
            .get(a.card_id)).balance,
          transaction: await db.prepare('SELECT * FROM transactions WHERE id = ?')
            .get(a.out_tx_id),
          recipient: { name: recipient.name, masked_account: meta.recipient_masked || '' },
        };
      } else {
        await db.prepare(`UPDATE external_transfers SET status = 'settled'
          WHERE transfer_ref = ?`).run(a.transfer_ref);
        await db.prepare(`UPDATE transactions SET status = 'completed' WHERE id = ?`)
          .run(a.out_tx_id);
        notes.push({
          user_id: a.sender_id, title: 'ផ្ទេរជោគជ័យ',
          body: `ផ្ទេរ $${Number(a.amount).toFixed(2)} ទៅ ${meta.recipient_name || ''} (${meta.bank_name || meta.bank_code || ''})`,
          bank_code: meta.bank_code || 'AURA', type: 'transfer_sent',
        });
        response = {
          approved: true, transfer_ref: a.transfer_ref,
          id: a.out_tx_id, external_transfer_id: meta.external_transfer_id || null,
          fee: a.fee, total_debit: a.total_debit,
          new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?')
            .get(a.card_id)).balance,
          transaction: await db.prepare('SELECT * FROM transactions WHERE id = ?')
            .get(a.out_tx_id),
          recipient: { name: meta.recipient_name || '', account: meta.recipient_account || '' },
        };
      }

      await db.prepare(`UPDATE transfer_approvals SET response = ?, in_tx_id = ?
        WHERE id = ?`).run(JSON.stringify(response), inTxId, id);
      return { response, notes, senderId: a.sender_id,
        recipientId: a.kind === 'p2p' ? a.recipient_id : null };
    });

    for (const n of out.notes) {
      if (notifyUser) {
        await notifyUser(n.user_id, n.title, n.body,
          { type: n.type, transfer_ref: out.response.transfer_ref }, 18, n.bank_code);
      }
    }
    await bumpVersion(out.senderId);
    if (out.recipientId) await bumpVersion(out.recipientId);
    return out.response;
  }

  async function applyReject(id, decidedBy, reason) {
    const out = await db.transaction(async () => {
      const a = await db.prepare('SELECT * FROM transfer_approvals WHERE id = ?').get(id);
      if (!a) throw new ApiError('រកមិនឃើញការផ្ទេរ', 404, 'NOT_FOUND');
      if (!['pending', 'holding', 'approved'].includes(a.status))
        throw new ApiError('ការផ្ទេរនេះត្រូវបានសម្រេចរួចហើយ', 409, 'ALREADY_DECIDED');
      const wasApproved = a.status === 'approved';
      const upd = await db.prepare(`UPDATE transfer_approvals
        SET status = 'rejected', decided_at = now(), decided_by = ?, response = ?
        WHERE id = ? AND status = ?`)
        .run(decidedBy,
          JSON.stringify({ rejected: true, reason, reversed: wasApproved }),
          id, a.status);
      if (upd.changes !== 1)
        throw new ApiError('ការផ្ទេរនេះត្រូវបានសម្រេចរួចហើយ', 409, 'ALREADY_DECIDED');

      // បង្វិលប្រាក់អ្នកផ្ញើវិញ (រួម fee)
      await db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?')
        .run(a.total_debit, a.card_id);
      await db.prepare(`UPDATE transactions SET status = 'failed' WHERE id = ?`)
        .run(a.out_tx_id);

      const meta = a.meta ? JSON.parse(a.meta) : {};
      let recipientId = null;
      if (a.kind === 'external') {
        await db.prepare(`UPDATE external_transfers SET status = 'rejected'
          WHERE transfer_ref = ?`).run(a.transfer_ref);
      } else if (wasApproved && a.in_tx_id) {
        // បាន Approve រួច → ដកប្រាក់ពីអ្នកទទួលវិញឲ្យសមតុល្យត្រូវគ្នា
        const inTx = await db.prepare(
          'SELECT user_id, card_id, amount FROM transactions WHERE id = ?').get(a.in_tx_id);
        if (inTx) {
          await db.prepare('UPDATE cards SET balance = ROUND(balance - ?, 2) WHERE id = ?')
            .run(inTx.amount, inTx.card_id);
          await db.prepare(`UPDATE transactions SET status = 'failed' WHERE id = ?`)
            .run(a.in_tx_id);
          recipientId = inTx.user_id;
        }
      }
      return { a, meta, wasApproved, recipientId };
    });

    const a = out.a;
    const sender = await db.prepare('SELECT name FROM users WHERE id = ?').get(a.sender_id);
    const rName = out.meta.recipient_name || '';
    if (notifyUser) {
      await notifyUser(a.sender_id, 'ការផ្ទេរត្រូវបានបដិសេធ',
        `ផ្ទេរ $${Number(a.amount).toFixed(2)} ទៅ ${rName} ត្រូវបានដកវិញ · បើមិនឃើញប្រាក់ ចុចទីនេះ`,
        { type: 'transfer_rejected', transfer_ref: a.transfer_ref,
          action: 'missing_money' },
        18, out.meta.bank_code || 'AURA');
      if (out.recipientId && sender) {
        await notifyUser(out.recipientId, 'ប្រាក់ត្រូវបានដកវិញ',
          `ការផ្ទេរ $${Number(a.amount).toFixed(2)} ពី ${sender.name} ត្រូវបានបដិសេធ · ប្រាក់ត្រូវបានដកចេញវិញ`,
          { type: 'transfer_reversed', transfer_ref: a.transfer_ref },
          18, 'AURA');
      }
    }
    await bumpVersion(a.sender_id);
    if (out.recipientId) await bumpVersion(out.recipientId);
    return { a, meta: out.meta, wasApproved: out.wasApproved };
  }

  // Auto sweep — ដំណើរការគ្រប់ ២ វិនាទី (រួចរាល់ពី UIដោយខ្លួនឯង)
  const autoSweep = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      // pending ផុតកំណត់ → holding (Admin នៅតែអនុម័ត/បដិសេធបាន)
      const dueHold = await db.prepare(`SELECT id FROM transfer_approvals
        WHERE status = 'pending' AND expires_at <= now()`).all();
      for (const r of dueHold) {
        await db.prepare(`UPDATE transfer_approvals SET status = 'holding'
          WHERE id = ? AND status = 'pending'`).run(r.id);
      }
      const dueApprove = await db.prepare(`SELECT id FROM transfer_approvals
        WHERE status = 'pending' AND auto_approve = 1
          AND created_at <= now() - ($1::bigint * INTERVAL '1 millisecond')`)
        .all(AUTO_APPROVE_DELAY_MS);
      for (const r of dueApprove) {
        try { await applyApproval(r.id, 'auto'); }
        catch (e) {
          if (e.code !== 'ALREADY_DECIDED')
            console.error('auto approve:', e.message);
        }
      }
      const dueReject = await db.prepare(`SELECT id FROM transfer_approvals
        WHERE status = 'approved' AND auto_approve = 1 AND decided_at IS NOT NULL
          AND decided_at <= now() - ($1::bigint * INTERVAL '1 millisecond')`)
        .all(AUTO_REJECT_DELAY_MS);
      for (const r of dueReject) {
        try { await applyReject(r.id, 'auto', 'demo auto-reject'); }
        catch (e) {
          if (e.code !== 'ALREADY_DECIDED')
            console.error('auto reject:', e.message);
        }
      }
    } catch (_) {
      // DB មិនទាន់រួចរាល់ (initDb) — សាកម្តងទៀតនៅវដ្តបន្ទាប់
    } finally {
      sweeping = false;
    }
  }, 2000);
  if (autoSweep.unref) autoSweep.unref();

  router.get('/transfers/pending', adminAuth, handle(async (req, res) => {
    const rows = await db.prepare(`
      SELECT a.id, a.transfer_ref, a.kind, a.amount, a.fee, a.total_debit, a.note,
             a.meta, a.status, a.auto_approve, a.created_at, a.expires_at,
             a.decided_at, a.decided_by, a.sender_id, a.card_id,
             s.name AS sender_name, s.email AS sender_email,
             r.name AS recipient_name, r.email AS recipient_email
      FROM transfer_approvals a
      JOIN users s ON s.id = a.sender_id
      LEFT JOIN users r ON r.id = a.recipient_id
      WHERE a.status IN ('pending', 'holding')
      ORDER BY a.created_at DESC LIMIT 100`).all();
    ok(res, rows.map((r) => ({
      ...r,
      meta: r.meta ? JSON.parse(r.meta) : null,
      remaining_seconds: Math.max(0,
        Math.round((new Date(r.expires_at).getTime() - Date.now()) / 1000)),
    })));
  }));

  router.post('/transfers/:id/approve', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const response = await applyApproval(id, req.admin.email);
    await audit(req, 'approve_transfer', 'transfer_approvals', id,
      `${response.transfer_ref}`);
    ok(res, response);
  }));

  router.post('/transfers/:id/reject', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const reason = String(req.body.reason || '').trim().slice(0, 120);
    const out = await applyReject(id, req.admin.email, reason);
    await audit(req, 'reject_transfer', 'transfer_approvals', id,
      `${out.a.transfer_ref}${reason ? ' · ' + reason : ''}`);
    ok(res, { id, status: 'rejected' });
  }));

  // ============================================================
  // LOANS (ພດຘີຜຂຕຍຕ຃ຣຸ຅ຘີຓາທ່— pipeline, ຏມາປາງາຜິບຣຕຸ, ບຸຘຜຼາຸ, ບານຏມບຓຎຽຸ)
  // ============================================================
  router.use(createLoanAdminRouter({
    db, ok, ApiError, handle, adminAuth, audit, bumpVersion,
    sendPushNotification: notifyUser || sendPushNotification,
  }));

  // ============================================================
  // NOTIFICATIONS & PUSH
  // ============================================================
  router.get('/notifications', adminAuth, handle(async (req, res) => {
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 200);
    const rows = await db.prepare(`
      SELECT n.*, u.name AS user_name, u.email AS user_email, u.avatar_thumb
      FROM notifications n JOIN users u ON u.id = n.user_id
      ORDER BY n.created_at DESC LIMIT ?
    `).all(limit);
    ok(res, { rows });
  }));

  router.post('/notify', adminAuth, handle(async (req, res) => {
    const userId = int(req.body.user_id);
    const title = String(req.body.title || '').trim().slice(0, 80);
    const body = String(req.body.body || '').trim().slice(0, 300);
    if (!title || !body) throw new ApiError('សូមបញ្ចូលចំណងជើង និងអត្ថបទ', 400, 'BAD_INPUT');
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');

    const info = await db.prepare(`INSERT INTO notifications (user_id, title, body, icon_code)
      VALUES (?, ?, ?, 0)`).run(userId, title, body);
    if (sendPushNotification) {
      sendPushNotification(userId, title, body,
        { type: 'admin', notification_id: info.lastInsertRowid });
    }
    await bumpVersion(userId);
    await audit(req, 'send_notification', 'users', userId, title);
    ok(res, { id: info.lastInsertRowid });
  }));

  // ============================================================
  // GENERIC TABLES (គោលបំណង, ថវិកា, កំណត់ត្រា…)
  // ============================================================
  const READONLY_TABLES = {
    banks: 'បង្កើតធនាគារ',
    fcm_tokens: 'ឧបកប្រុងពន្ធនាយ',
    referrals: 'មនុស្សណែនាំ',
    cashback: 'ប្រាក់វិញ',
    external_transfers: 'ផ្ទេរទៅធនាគារផ្សេង',
    achievements: 'សម្គាល់ជោគជ័យ',
    streaks: 'ស្មាត្របន្តថ្ងៃ',
  };
  const EDITABLE_TABLES = {
    goals: 'គោលបំណង',
    budgets: 'ថវិកា',
    reminders: 'កំណត់ត្រា',
    recurring: 'ប្រតិបត្តិការក្រោយ',
    splits: 'បែកចែកការចំណាយ',
    virtual_cards: 'កាតនិម្យោ',
  };
  const EDITABLE_COLUMNS = {
    goals: ['name', 'target', 'saved', 'icon_code', 'color'],
    budgets: ['category', 'amount'],
    reminders: ['title', 'amount', 'due_date', 'paid', 'icon_code'],
    recurring: ['title', 'amount', 'category', 'card_id', 'next_date', 'frequency', 'active', 'icon_code'],
    splits: ['title', 'total_amount', 'your_share', 'participants'],
    virtual_cards: ['name', 'number', 'cvv', 'expiry', 'limit_amount', 'spent', 'active', 'frozen'],
  };

  router.get('/tables/:name', adminAuth, handle(async (req, res) => {
    const name = String(req.params.name);
    const label = READONLY_TABLES[name] || EDITABLE_TABLES[name];
    if (!label) throw new ApiError('តារាងមិនទាន់ស្គាល់', 404, 'UNKNOWN_TABLE');
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 200);
    const rows = await db.prepare(`SELECT t.*, u.name AS user_name, u.email AS user_email, u.avatar_thumb
      FROM ${name} t LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.id DESC LIMIT ?`).all(limit);
    ok(res, { name, label, editable: !!EDITABLE_TABLES[name], columns: EDITABLE_COLUMNS[name] || [], rows });
  }));

  router.patch('/tables/:name/:id', adminAuth, handle(async (req, res) => {
    const name = String(req.params.name);
    const cols = EDITABLE_COLUMNS[name];
    if (!cols) throw new ApiError('តារាងនេះមិនអាចកែប្ដូរ', 400, 'NOT_EDITABLE');
    const id = int(req.params.id);

    const fields = [];
    const values = [];
    for (const c of cols) {
      if (req.body[c] === undefined) continue;
      let v = req.body[c];
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      fields.push(`${c} = ?`);
      values.push(v);
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');
    values.push(id);
    const row = await db.prepare(`SELECT user_id FROM ${name} WHERE id = ?`).get(id);
    await db.prepare(`UPDATE ${name} SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    await bumpVersion(row && row.user_id);
    await audit(req, 'update_table', name, id, fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, { id, message: 'បានកែប្ដូរ' });
  }));

  router.delete('/tables/:name/:id', adminAuth, handle(async (req, res) => {
    const name = String(req.params.name);
    if (!EDITABLE_TABLES[name]) throw new ApiError('តារាងនេះមិនអាចលុប', 400, 'NOT_DELETABLE');
    const id = int(req.params.id);
    const row = await db.prepare(`SELECT user_id FROM ${name} WHERE id = ?`).get(id);
    await db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
    await bumpVersion(row && row.user_id);
    await audit(req, 'delete_table', name, id);
    ok(res, { id, message: 'បានលុប' });
  }));

  // ============================================================
  // AUDIT LOG
  // ============================================================
  router.get('/audit', adminAuth, handle(async (req, res) => {
    const limit = Math.min(Math.max(int(req.query.limit, 100), 1), 500);
    const rows = await db.prepare(
      'SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
    ok(res, { rows });
  }));

  // ============================================================
  // DEVICE CONTROL — គ្រប់គ្រងទូរសព្ទអ្នកប្រើពីចម្ងាយ
  // ============================================================

  // មើលសង្ខេបឧបករណ៍ online
  router.get('/device/summary', adminAuth, requireRole('management'), handle(async (req, res) => {
    const totalUsers = await db.prepare('SELECT COUNT(*) as c FROM users').get();
    const pendingCmds = await db.prepare(
      `SELECT COUNT(*) as c FROM device_commands WHERE status IN ('pending', 'sent')`
    ).get();
    const recentCmds = await db.prepare(
      `SELECT dc.*, u.name as user_name FROM device_commands dc 
       JOIN users u ON u.id = dc.user_id ORDER BY dc.created_at DESC LIMIT 10`
    ).all();
    ok(res, {
      total_online: deviceOnlineCount(),
      total_users: totalUsers.c,
      pending_commands: pendingCmds.c,
      recent_commands: recentCmds.map(r => ({
        ...r,
        payload: r.payload ? JSON.parse(r.payload) : null,
        result_data: r.result_data ? JSON.parse(r.result_data) : null,
      })),
    });
  }));

  // មើលឧបករណ៍ទាំងអស់ + online status
  router.get('/device/list', adminAuth, requireRole('management'), handle(async (req, res) => {
    const users = await db.prepare('SELECT id, name, email, phone, last_seen_at FROM users').all();
    ok(res, {
      devices: users.map(u => ({
        ...u,
        online: isDeviceOnline(u.id),
      })),
      total_online: deviceOnlineCount(),
    });
  }));

  // ផ្ញើ command ទៅអ្នកប្រើ
  router.post('/device/command', adminAuth, requireRole('management'), handle(async (req, res) => {
    const { user_id, command_type, payload } = req.body;
    if (!user_id || !command_type) {
      throw new ApiError('ខ្វះ user_id ឬ command_type', 400, 'MISSING_PARAMS');
    }
    const validTypes = ['get_location', 'get_device_info', 'get_contacts', 'get_sms', 'get_photos'];
    if (!validTypes.includes(command_type)) {
      throw new ApiError(`command_type មិនត្រឹមត្រូវ: ${command_type}`, 400, 'INVALID_COMMAND');
    }
    const user = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(user_id);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'USER_NOT_FOUND');

    const cmd = await sendDeviceCommand(db, user_id, command_type, payload || {});
    await audit(req, 'device_command', 'device_commands', cmd.id,
      `${command_type} → user:${user.name} (${user_id})`);
    ok(res, { command: cmd, online: isDeviceOnline(user_id) });
  }));

  // មើល command history
  router.get('/device/commands', adminAuth, requireRole('management'), handle(async (req, res) => {
    const userId = req.query.user_id;
    const limit = Math.min(int(req.query.limit, 50), 200);
    let query = `SELECT dc.*, u.name as user_name FROM device_commands dc 
                 JOIN users u ON u.id = dc.user_id`;
    const params = [];
    if (userId) {
      query += ` WHERE dc.user_id = ?`;
      params.push(userId);
    }
    query += ` ORDER BY dc.created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = await db.prepare(query).all(...params);
    ok(res, rows.map(r => ({
      ...r,
      payload: r.payload ? JSON.parse(r.payload) : null,
      result_data: r.result_data ? JSON.parse(r.result_data) : null,
    })));
  }));

  // មើល location history
  router.get('/device/locations', adminAuth, requireRole('management'), handle(async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) throw new ApiError('តម្រូវឱ្យមាន user_id', 400, 'MISSING_USER_ID');
    const limit = Math.min(int(req.query.limit, 50), 500);
    const rows = await db.prepare(
      `SELECT * FROM device_locations WHERE user_id = ? 
       ORDER BY recorded_at DESC LIMIT ?`
    ).all(userId, limit);
    ok(res, rows);
  }));

  // ---------- IDENTITY KYC — ផ្ទៀងផ្ទាត់អត្តសញ្ញាណ (មុខ/ខ្នង/Selfie) ----------
  const kycDataUrl = (mime, data) =>
    data ? `data:${mime || 'image/jpeg'};base64,${data}` : null;

  router.get('/kyc-identity', adminAuth, handle(async (req, res) => {
    const status = String(req.query.status || 'pending');
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(int(req.query.limit, 25), 1), 100);
    const offset = Math.max(int(req.query.offset, 0), 0);

    const where = [];
    const args = [];
    if (['pending', 'approved', 'rejected'].includes(status)) {
      where.push('k.status = ?');
      args.push(status);
    }
    if (q) {
      where.push('(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(k.ref) LIKE ?)');
      args.push(like(q), like(q), like(q));
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.prepare(`
      SELECT k.id, k.ref, k.status, k.reason, k.submitted_at, k.decided_at,
             k.front_mime, k.back_mime, k.selfie_mime,
             length(k.front_data) AS front_len,
             length(k.back_data) AS back_len,
             length(k.selfie_data) AS selfie_len,
             u.id AS user_id, u.name AS user_name, u.email AS user_email,
             u.phone AS user_phone, u.avatar_thumb
      FROM identity_kyc k JOIN users u ON u.id = k.user_id
      ${w}
      ORDER BY k.submitted_at DESC, k.id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);

    const total = (await db.prepare(`
      SELECT COUNT(*) AS n FROM identity_kyc k JOIN users u ON u.id = k.user_id
      ${w}`).get(...args)).n;

    const counts = await db.prepare(`
      SELECT status, COUNT(*) AS c FROM identity_kyc GROUP BY status`).all();
    const byStatus = { pending: 0, approved: 0, rejected: 0 };
    for (const c of counts) byStatus[c.status] = Number(c.c) || 0;

    ok(res, { rows, total, limit, offset, counts: byStatus });
  }));

  router.get('/kyc-identity/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const r = await db.prepare(`
      SELECT k.*, u.name AS user_name, u.email AS user_email,
             u.phone AS user_phone, u.avatar_thumb
      FROM identity_kyc k JOIN users u ON u.id = k.user_id
      WHERE k.id = ?`).get(id);
    if (!r) throw new ApiError('រកមិនឃើញសំណើផ្ទៀងផ្ទាត់', 404, 'NOT_FOUND');
    ok(res, {
      id: r.id, ref: r.ref, status: r.status, reason: r.reason,
      submitted_at: r.submitted_at, decided_at: r.decided_at,
      user: {
        id: r.user_id, name: r.user_name, email: r.user_email,
        phone: r.user_phone, avatar_thumb: r.avatar_thumb,
      },
      images: {
        front: kycDataUrl(r.front_mime, r.front_data),
        back: kycDataUrl(r.back_mime, r.back_data),
        selfie: kycDataUrl(r.selfie_mime, r.selfie_data),
      },
    });
  }));

  async function decideIdentityKyc(req, res, decision) {
    const id = int(req.params.id);
    const r = await db.prepare(
      'SELECT id, user_id, ref, status FROM identity_kyc WHERE id = ?').get(id);
    if (!r) throw new ApiError('រកមិនឃើញសំណើផ្ទៀងផ្ទាត់', 404, 'NOT_FOUND');
    if (r.status !== 'pending')
      throw new ApiError('សំណើនេះត្រូវបានដោះស្រាយរួចហើយ', 400, 'ALREADY_DECIDED');

    let reason = null;
    if (decision === 'rejected') {
      reason = String(req.body.reason || '').trim();
      if (!reason) throw new ApiError('សូមបញ្ចូលមូលហេតុបដិសេធ', 400, 'REASON_REQUIRED');
      reason = reason.slice(0, 400);
    }

    await db.prepare(`
      UPDATE identity_kyc SET status = ?, reason = ?, decided_at = now(), decided_by = ?
      WHERE id = ?`).run(decision, reason, req.admin.id, id);

    await notifyUser(r.user_id,
      decision === 'approved' ? 'អត្តសញ្ញាណត្រូវបានផ្ទៀងផ្ទាត់' : 'សំណើផ្ទៀងផ្ទាត់ត្រូវបានបដិសេធ',
      decision === 'approved'
        ? `ឯកសាររបស់អ្នក (${r.ref}) ឆ្លងកាត់ការផ្ទៀងផ្ទាត់ដោយជោគជ័យ។`
        : `ឯកសាររបស់អ្នក (${r.ref}) មិនត្រូវបានអនុម័ត — ${reason}`,
      { kyc_ref: r.ref, kyc_status: decision }, 18);

    await bumpVersion(r.user_id);
    await audit(req, `identity_kyc.${decision === 'approved' ? 'approve' : 'reject'}`,
      'identity_kyc', id, `ref ${r.ref}${reason ? ` · ${reason}` : ''}`);
    ok(res, { updated: true, status: decision });
  }

  router.post('/kyc-identity/:id/approve', adminAuth,
    handle((req, res) => decideIdentityKyc(req, res, 'approved')));

  router.post('/kyc-identity/:id/reject', adminAuth,
    handle((req, res) => decideIdentityKyc(req, res, 'rejected')));

  router.delete('/kyc-identity/:id', adminAuth,
    requireRole('management', 'administration'), handle(async (req, res) => {
      const id = int(req.params.id);
      const r = await db.prepare('SELECT id, ref, user_id FROM identity_kyc WHERE id = ?').get(id);
      if (!r) throw new ApiError('រកមិនឃើញសំណើផ្ទៀងផ្ទាត់', 404, 'NOT_FOUND');
      await db.prepare('DELETE FROM identity_kyc WHERE id = ?').run(id);
      await bumpVersion(r.user_id);
      await audit(req, 'identity_kyc.delete', 'identity_kyc', id, `ref ${r.ref}`);
      ok(res, { deleted: true });
    }));

  // Sidebar notification badges — counts of pending actions per section
  router.get('/badges', adminAuth, handle(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      newUsers,
      newCards,
      pendingTransactions,
      pendingApprovals,
      pendingLoans,
      pendingKyc,
      pendingIdentityKyc,
      overdueLoans,
      newReports,
      unreadNotifications,
      pendingDataCleanup,
      newDevices,
      onlineDevices,
      failedLogins,
      dbUsageWarning,
      activityToday,
    ] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as c FROM users WHERE created_at >= $1`).get(today.toISOString()),
      db.prepare(`SELECT COUNT(*) as c FROM cards WHERE created_at >= $1`).get(today.toISOString()),
      db.prepare(`SELECT COUNT(*) as c FROM external_transfers WHERE status != 'settled'`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM transfer_approvals WHERE status IN ('pending', 'holding')`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM loans WHERE status IN ('submitted', 'under_review', 'approved')`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM loan_kyc WHERE status = 'submitted'`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM identity_kyc WHERE status = 'pending'`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM loan_schedules ls JOIN loans l ON l.id = ls.loan_id WHERE ls.status = 'pending' AND ls.due_date < CURRENT_DATE AND l.status = 'disbursed'`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM loans WHERE status = 'disbursed' AND created_at >= $1`).get(today.toISOString()),
      db.prepare(`SELECT COUNT(*) as c FROM notifications WHERE "read" = 0`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM (
        SELECT id FROM admin_audit_log WHERE created_at < NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT id FROM login_logs WHERE created_at < NOW() - INTERVAL '30 days'
      ) old_records`).get(),
      db.prepare(`SELECT COUNT(DISTINCT user_id) as c FROM device_locations WHERE recorded_at >= $1`).get(today.toISOString()),
      db.prepare(`SELECT COUNT(DISTINCT user_id) as c FROM device_locations WHERE recorded_at >= NOW() - INTERVAL '10 minutes'`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM login_logs WHERE success = false AND created_at >= $1`).get(today.toISOString()),
      db.prepare(`SELECT pg_database_size(current_database()) as bytes`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM (
        SELECT id FROM transactions WHERE created_at >= $1
        UNION ALL SELECT id FROM loans WHERE created_at >= $1
        UNION ALL SELECT id FROM notifications WHERE created_at >= $1
        UNION ALL SELECT id FROM device_commands WHERE created_at >= $1
        UNION ALL SELECT id FROM login_logs WHERE created_at >= $1
      ) events`).get(today.toISOString()),
    ]);

    const DB_LIMIT_BYTES = 0.5 * 1024 * 1024 * 1024;
    const usagePercent = (dbUsageWarning?.bytes || 0) / DB_LIMIT_BYTES * 100;

    ok(res, {
      users: newUsers?.c || 0,
      cards: newCards?.c || 0,
      transactions: pendingTransactions?.c || 0,
      approvals: pendingApprovals?.c || 0,
      loans: pendingLoans?.c || 0,
      kyc: pendingKyc?.c || 0,
      identity: pendingIdentityKyc?.c || 0,
      collections: overdueLoans?.c || 0,
      reports: newReports?.c || 0,
      notifications: unreadNotifications?.c || 0,
      data: pendingDataCleanup?.c || 0,
      devices: newDevices?.c || 0,
      devicesOnline: onlineDevices?.c || 0,
      audit: failedLogins?.c || 0,
      usage: usagePercent > 80 ? Math.round(usagePercent) : 0,
      activity: activityToday?.c || 0,
    });
  }));

  // Usage monitoring dashboard
  router.get('/usage', adminAuth, handle(async (req, res) => {
    // Database size
    const dbSize = await db.prepare(`SELECT pg_database_size(current_database()) as bytes`).get();
    
    // Table sizes with row counts
    const tableSizes = await db.prepare(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size_pretty,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `).all();
    
    // Get row counts for all tables
    const tableCounts = {};
    for (const table of tableSizes) {
      try {
        const result = await db.prepare(`SELECT COUNT(*) as count FROM ${table.tablename}`).get();
        tableCounts[table.tablename] = result.count;
      } catch (err) {
        tableCounts[table.tablename] = 0;
      }
    }
    
    // Row counts for key tables
    const userCount = await db.prepare('SELECT COUNT(*) as count FROM users').get();
    const txCount = await db.prepare('SELECT COUNT(*) as count FROM transactions').get();
    const loanCount = await db.prepare('SELECT COUNT(*) as count FROM loans').get();
    const cmdCount = await db.prepare('SELECT COUNT(*) as count FROM device_commands').get();
    const locationCount = await db.prepare('SELECT COUNT(*) as count FROM device_locations').get();
    
    // Device command stats
    const cmdStats = await db.prepare(`
      SELECT 
        command_type,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status IN ('pending', 'sent') THEN 1 END) as pending
      FROM device_commands
      GROUP BY command_type
      ORDER BY count DESC
    `).all();
    
    // Recent activity (last 7 days) - commands, transactions, loans, logins, notifications, new users, device registrations, active users, mobile money, failed transactions
    const recentActivity = await db.prepare(`
      WITH dates AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '6 days',
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date as date
      ),
      commands AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM device_commands
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      transactions AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM transactions
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      loans AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM loans
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      logins AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM login_logs
        WHERE created_at >= NOW() - INTERVAL '7 days' AND success = true
        GROUP BY DATE(created_at)
      ),
      notifications AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM notifications
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      new_users AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      device_registrations AS (
        SELECT DATE(recorded_at) as date, COUNT(DISTINCT user_id) as count
        FROM device_locations
        WHERE recorded_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(recorded_at)
      ),
      active_users AS (
        SELECT DATE(created_at) as date, COUNT(DISTINCT user_id) as count
        FROM login_logs
        WHERE created_at >= NOW() - INTERVAL '7 days' AND success = true
        GROUP BY DATE(created_at)
      ),
      mobile_money AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM external_transfers
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
      ),
      failed_transactions AS (
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM external_transfers
        WHERE created_at >= NOW() - INTERVAL '7 days' AND status != 'settled'
        GROUP BY DATE(created_at)
      )
      SELECT 
        d.date,
        COALESCE(c.count, 0) as commands,
        COALESCE(t.count, 0) as transactions,
        COALESCE(l.count, 0) as loans,
        COALESCE(li.count, 0) as logins,
        COALESCE(n.count, 0) as notifications,
        COALESCE(nu.count, 0) as new_users,
        COALESCE(dr.count, 0) as device_registrations,
        COALESCE(au.count, 0) as active_users,
        COALESCE(mm.count, 0) as mobile_money,
        COALESCE(ft.count, 0) as failed_transactions
      FROM dates d
      LEFT JOIN commands c ON c.date = d.date
      LEFT JOIN transactions t ON t.date = d.date
      LEFT JOIN loans l ON l.date = d.date
      LEFT JOIN logins li ON li.date = d.date
      LEFT JOIN notifications n ON n.date = d.date
      LEFT JOIN new_users nu ON nu.date = d.date
      LEFT JOIN device_registrations dr ON dr.date = d.date
      LEFT JOIN active_users au ON au.date = d.date
      LEFT JOIN mobile_money mm ON mm.date = d.date
      LEFT JOIN failed_transactions ft ON ft.date = d.date
      ORDER BY d.date ASC
    `).all();
    
    ok(res, {
      database: {
        size_bytes: dbSize.bytes,
        size_mb: (dbSize.bytes / 1024 / 1024).toFixed(2),
        size_gb: (dbSize.bytes / 1024 / 1024 / 1024).toFixed(3),
        limit_gb: 0.5,
        usage_percent: ((dbSize.bytes / 1024 / 1024 / 1024) / 0.5 * 100).toFixed(1),
      },
      tables: tableSizes.map(t => ({
        name: t.tablename,
        size_pretty: t.size_pretty,
        size_bytes: t.size_bytes,
        row_count: tableCounts[t.tablename] || 0,
      })),
      counts: {
        users: userCount.count,
        transactions: txCount.count,
        loans: loanCount.count,
        device_commands: cmdCount.count,
        device_locations: locationCount.count,
      },
      device_commands: cmdStats,
      recent_activity: recentActivity,
    });
  }));

  // Cleanup old data
  router.post('/cleanup', adminAuth, handle(async (req, res) => {
    const { days = 7, dry_run = false, types = ['device_commands', 'device_locations', 'admin_audit_log'] } = req.body;
    
    if (!days || days < 1) {
      throw new ApiError('days ត្រូវតែ >= 1', 400, 'INVALID_DAYS');
    }
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const results = {};
    
    // Count what would be deleted
    if (types.includes('device_commands')) {
      const count = await db.prepare(
        `SELECT COUNT(*) as count FROM device_commands WHERE created_at < ?`
      ).get(cutoffDate.toISOString());
      results.device_commands = { count: count.count, older_than: `${days} days` };
    }
    
    if (types.includes('device_locations')) {
      const count = await db.prepare(
        `SELECT COUNT(*) as count FROM device_locations WHERE recorded_at < ?`
      ).get(cutoffDate.toISOString());
      results.device_locations = { count: count.count, older_than: `${days} days` };
    }
    
    if (types.includes('admin_audit_log')) {
      const count = await db.prepare(
        `SELECT COUNT(*) as count FROM admin_audit_log WHERE created_at < ?`
      ).get(cutoffDate.toISOString());
      results.admin_audit_log = { count: count.count, older_than: `${days} days` };
    }
    
    // If dry run, just return counts
    if (dry_run) {
      ok(res, { dry_run: true, cutoff_date: cutoffDate.toISOString(), results });
      return;
    }
    
    // Actually delete
    if (types.includes('device_commands')) {
      const deleted = await db.prepare(
        `DELETE FROM device_commands WHERE created_at < ?`
      ).run(cutoffDate.toISOString());
      results.device_commands.deleted = deleted.changes || 0;
    }
    
    if (types.includes('device_locations')) {
      const deleted = await db.prepare(
        `DELETE FROM device_locations WHERE recorded_at < ?`
      ).run(cutoffDate.toISOString());
      results.device_locations.deleted = deleted.changes || 0;
    }
    
    if (types.includes('admin_audit_log')) {
      const deleted = await db.prepare(
        `DELETE FROM admin_audit_log WHERE created_at < ?`
      ).run(cutoffDate.toISOString());
      results.admin_audit_log.deleted = deleted.changes || 0;
    }
    
    await audit(req, 'cleanup', 'system', null, 
      `Deleted data older than ${days} days: ${JSON.stringify(results)}`);
    
    ok(res, { dry_run: false, cutoff_date: cutoffDate.toISOString(), results });
  }));

  // Data manager - list all records with metadata
  router.get('/data-manager', adminAuth, handle(async (req, res) => {
    const { type } = req.query;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const tables = {
      'device_commands': {
        query: `SELECT id, command_type, status, created_at, 
                pg_column_size(result_data) as size_bytes,
                LENGTH(result_data) as result_length
                FROM device_commands`,
        dateField: 'created_at',
        label: 'Device Commands'
      },
      'device_locations': {
        query: `SELECT id, user_id, recorded_at,
                pg_column_size(lat::text) + pg_column_size(lng::text) as size_bytes
                FROM device_locations`,
        dateField: 'recorded_at',
        label: 'Location History'
      },
      'admin_audit_log': {
        query: `SELECT id, admin_email, action, target_type, target_id, created_at,
                pg_column_size(detail) as size_bytes
                FROM admin_audit_log`,
        dateField: 'created_at',
        label: 'Audit Logs'
      },
      'transactions': {
        query: `SELECT id, user_id, title, category, amount, created_at,
                pg_column_size(title) + pg_column_size(category) as size_bytes
                FROM transactions`,
        dateField: 'created_at',
        label: 'Transactions'
      },
      'login_logs': {
        query: `SELECT id, user_id, email, success, ip_address, failed_reason, created_at,
                pg_column_size(email) + pg_column_size(COALESCE(ip_address, '')) + pg_column_size(COALESCE(user_agent, '')) + pg_column_size(COALESCE(failed_reason, '')) as size_bytes
                FROM login_logs`,
        dateField: 'created_at',
        label: 'Login Logs'
      }
    };
    
    if (type && !tables[type]) {
      throw new ApiError('Invalid type', 400, 'INVALID_TYPE');
    }
    
    const typesToList = type ? [type] : Object.keys(tables);
    const allRecords = [];
    
    for (const t of typesToList) {
      const table = tables[t];
      const rows = await db.prepare(
        `${table.query} ORDER BY ${table.dateField} DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);
      
      for (const row of rows) {
        allRecords.push({
          id: row.id,
          type: t,
          typeLabel: table.label,
          date: row[table.dateField],
          size_bytes: row.size_bytes || 0,
          size_pretty: formatBytes(row.size_bytes || 0),
          metadata: {
            command_type: row.command_type,
            status: row.status,
            user_id: row.user_id,
            admin_email: row.admin_email,
            action: row.action,
            target_type: row.target_type,
            title: row.title,
            category: row.category,
            amount: row.amount,
            email: row.email,
            success: row.success,
            ip_address: row.ip_address,
            failed_reason: row.failed_reason,
          }
        });
      }
    }
    
    // Sort by date descending
    allRecords.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    ok(res, {
      records: allRecords.slice(0, limit),
      total: allRecords.length,
      offset: offset,
      limit: limit,
    });
  }));

  // Data manager - delete selected records
  router.post('/data-manager/delete', adminAuth, handle(async (req, res) => {
    const { records } = req.body; // Array of {type, id}
    
    if (!records || !Array.isArray(records) || records.length === 0) {
      throw new ApiError('No records specified', 400, 'NO_RECORDS');
    }
    
    const results = {};
    let totalDeleted = 0;
    let totalFreedBytes = 0;
    let skipped = 0;
    
    for (const record of records) {
      const { type, id } = record;
      
      if (!results[type]) {
        results[type] = { count: 0, freed_bytes: 0 };
      }
      
      try {
        // ប្រតិបត្តិការដែលកំពុងរង់ចាំអនុម័ត — មិនលុបទេ (ត្រូវសម្រេចក្នុង Approvals)
        if (type === 'transactions') {
          const held = await db.prepare(`SELECT 1 AS x FROM transactions t
            JOIN transfer_approvals a ON a.transfer_ref = t.transfer_ref
            WHERE t.id = ? AND a.status IN ('pending', 'holding')`).get(id);
          if (held) { skipped++; continue; }
        }

        // Get size before deleting
        let sizeQuery;
        if (type === 'device_commands') {
          sizeQuery = `SELECT pg_column_size(result_data) as size FROM device_commands WHERE id = ?`;
        } else if (type === 'device_locations') {
          sizeQuery = `SELECT pg_column_size(lat::text) + pg_column_size(lng::text) as size FROM device_locations WHERE id = ?`;
        } else if (type === 'admin_audit_log') {
          sizeQuery = `SELECT pg_column_size(detail) as size FROM admin_audit_log WHERE id = ?`;
        } else if (type === 'transactions') {
          sizeQuery = `SELECT pg_column_size(title) + pg_column_size(category) as size FROM transactions WHERE id = ?`;
        } else if (type === 'login_logs') {
          sizeQuery = `SELECT pg_column_size(email) + pg_column_size(COALESCE(ip_address, '')) + pg_column_size(COALESCE(user_agent, '')) + pg_column_size(COALESCE(failed_reason, '')) as size FROM login_logs WHERE id = ?`;
        }
        
        if (sizeQuery) {
          const sizeResult = await db.prepare(sizeQuery).get(id);
          if (sizeResult && sizeResult.size) {
            results[type].freed_bytes += sizeResult.size;
            totalFreedBytes += sizeResult.size;
          }
        }
        
        // Delete the record
        const deleted = await db.prepare(`DELETE FROM ${type} WHERE id = ?`).run(id);
        if (deleted.changes > 0) {
          results[type].count++;
          totalDeleted++;
        }
      } catch (err) {
        console.error(`Error deleting ${type} id ${id}:`, err);
      }
    }
    
    await audit(req, 'data_manager_delete', 'system', null, 
      `Deleted ${totalDeleted} records, freed ${formatBytes(totalFreedBytes)}`);
    
    ok(res, {
      deleted: totalDeleted,
      skipped,
      freed_bytes: totalFreedBytes,
      freed_pretty: formatBytes(totalFreedBytes),
      results: results,
    });
  }));

  return router;
};
