// ============================================================
// ADMIN DASHBOARD API
// គ្រប់គ្រងទិន្នថយទាំងអស់: អ្នកប្រើ, កាត, ប្រតិបត្តិការ, កម្ចី, សេចក្តីសារ, គោលបំណង...
// ចូលដោយគណនីធម្មតា (អ៊ីមែល + PIN) ប៉ុន្តែត្រូវមាន is_admin = 1
// ត្រូវ mount នៅ server.js:  app.use('/admin/api', require('./admin')(ctx))
// ============================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

module.exports = function createAdminRouter(ctx) {
  const { db, ok, fail, ApiError, handle, SECRET, sendPushNotification } = ctx;
  const router = express.Router();

  const ADMIN_TTL = '12h';
  const SALT = 10;

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

  // ---------- admin auth ----------
  function adminAuth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'No token' });
    try {
      const p = jwt.verify(token, SECRET);
      if (p.typ !== 'admin') throw new Error('wrong scope');
      req.admin = { id: p.id, email: p.email };
      next();
    } catch {
      res.status(401).json({ success: false, error: 'Invalid admin token' });
    }
  }

  // ចូល admin — ប្រើ អ៊ីមែល + PIN ធម្មតា ប៉ុន្តែមិនបញ្ចូល pin_attempts (admin មិនត្រូវត្រូវចាក់សោគណនីខ្លួនឯង)
  router.post('/login', handle(async (req, res) => {
    const email = String(req.body.email || '').trim();
    const pin = String(req.body.pin || '');
    if (!email || !/^\d{4}$/.test(pin)) {
      throw new ApiError('សូមបញ្ចូលអ៊ីមែល និង PIN 4 ខ្ទង់', 400, 'BAD_INPUT');
    }
    const u = await db.prepare(
      'SELECT id, name, email, pin_hash, is_admin, locked_until FROM users WHERE lower(email) = lower(?)'
    ).get(email);
    if (!u) throw new ApiError('រកមិនឃើញគណនី', 404, 'NOT_FOUND');

    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new ApiError('គណនីត្រូវបានចាក់សោ', 423, 'PIN_LOCKED');
    }

    let valid = false;
    try { valid = await bcrypt.compare(pin, u.pin_hash); } catch { valid = false; }
    if (!valid) throw new ApiError('PIN មិនត្រឹមត្រូវ', 401, 'WRONG_PIN');

    // អនុញ្ញាតម្តងនេះ (ADMIN_EMAILS) → ផ្តល់សិទ្ធិ admin ភ្លាម
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
      { id: u.id, email: u.email, name: u.name, typ: 'admin' },
      SECRET, { expiresIn: ADMIN_TTL }
    );
    ok(res, { token, admin: { id: u.id, name: u.name, email: u.email } });
  }));

  router.get('/me', adminAuth, handle(async (req, res) => {
    const u = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.admin.id);
    ok(res, u || req.admin);
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
        (SELECT COUNT(*) FROM external_transfers) AS external_transfers
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
      SELECT id, name, email, phone, created_at FROM users
      ORDER BY created_at DESC LIMIT 6
    `).all();

    const recentTx = await db.prepare(`
      SELECT t.id, t.title, t.category, t.amount, t.is_expense, t.created_at,
             u.id AS user_id, u.name AS user_name
      FROM transactions t JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC LIMIT 8
    `).all();

    ok(res, { totals, daily, categories, topUsers, recentUsers, recentTx });
  }));

  // ============================================================
  // USERS
  // ============================================================
  router.get('/users', adminAuth, handle(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(int(req.query.limit, 25), 1), 200);
    const offset = Math.max(int(req.query.offset, 0), 0);
    const rows = await db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.auth_provider, u.is_admin,
             u.pin_attempts, u.locked_until, u.created_at,
             (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id) AS card_count,
             (SELECT COALESCE(SUM(c.balance), 0) FROM cards c WHERE c.user_id = u.id) AS balance,
             (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS tx_count,
             (SELECT MAX(t.created_at) FROM transactions t WHERE t.user_id = u.id) AS last_tx
      FROM users u
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR u.phone LIKE ?)
      ORDER BY u.id DESC LIMIT ? OFFSET ?
    `).all(q, like(q), like(q), like(q), limit, offset);
    const total = (await db.prepare(`
      SELECT COUNT(*) AS n FROM users u
      WHERE (?::text = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR u.phone LIKE ?)
    `).get(q, like(q), like(q), like(q))).n;
    ok(res, { rows, total, limit, offset });
  }));

  router.get('/users/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const user = await db.prepare(`
      SELECT id, name, email, phone, auth_provider, is_admin, pin_attempts,
             locked_until, created_at, avatar_thumb
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
    ok(res, { user, cards, transactions, loans, goals, budgets, notifications, referrals });
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
    if (req.body.unlock === true) {
      push('pin_attempts', 0);
      push('locked_until', null);
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');

    values.push(id);
    await db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
    await audit(req, 'reset_pin', 'users', id);
    ok(res, { id, message: 'បានកំណត់ PIN ថ្មី' });
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
      SELECT c.*, u.name AS user_name, u.email AS user_email
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
      if (b === null || b < 0) throw new ApiError('សម្រាប់ត្រូវតែ ≥ 0', 400, 'BAD_BALANCE');
      push('balance', money(b));
    }
    if (req.body.frozen !== undefined) push('frozen', req.body.frozen ? 1 : 0);
    if (req.body.online !== undefined) push('online', req.body.online ? 1 : 0);
    if (req.body.daily_limit !== undefined) {
      const l = num(req.body.daily_limit);
      if (l === null || l < 0) throw new ApiError('ដីហទិតត្រូវតែ ≥ 0', 400, 'BAD_LIMIT');
      push('daily_limit', money(l));
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');

    values.push(id);
    await db.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
    await audit(req, 'create_card', 'cards', info.lastInsertRowid, `user ${userId}`);
    ok(res, await db.prepare('SELECT * FROM cards WHERE id = ?').get(info.lastInsertRowid));
  }));

  router.delete('/cards/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const card = await db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
    if (!card) throw new ApiError('រកមិនឃើញកាត', 404, 'NOT_FOUND');
    await db.prepare('DELETE FROM cards WHERE id = ?').run(id);
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
      SELECT t.*, u.name AS user_name, u.email AS user_email, c.name AS card_name
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
    if (!title) throw new ApiError('សូមបញ្ចូលចំណាង', 400, 'BAD_INPUT');
    if (!(amount > 0)) throw new ApiError('ចំនួនលុយត្រូវតែ > 0', 400, 'BAD_AMOUNT');

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
    });
    await audit(req, 'delete_transaction', 'transactions', id, tx.title);
    ok(res, { id, message: 'បានលុបប្រតិបត្តិការ' });
  }));

  // ============================================================
  // LOANS
  // ============================================================
  router.get('/loans', adminAuth, handle(async (req, res) => {
    const rows = await db.prepare(`
      SELECT l.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
      FROM loans l JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC LIMIT 200
    `).all();
    ok(res, { rows });
  }));

  router.patch('/loans/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');

    const fields = [];
    const values = [];
    const push = (col, val) => { fields.push(`${col} = ?`); values.push(val); };
    if (req.body.active !== undefined) push('active', req.body.active ? 1 : 0);
    if (req.body.principal !== undefined) {
      const p = num(req.body.principal);
      if (p === null || p <= 0) throw new ApiError('ចំនួនប្រាក់ត្រូវតែ > 0', 400, 'BAD_AMOUNT');
      push('principal', money(p));
    }
    if (req.body.months !== undefined) {
      const m = int(req.body.months);
      if (m < 1 || m > 120) throw new ApiError('រយៈខែត្រូវតែ 1–120', 400, 'BAD_MONTHS');
      push('months', m);
    }
    if (req.body.annual_rate !== undefined) {
      const r = num(req.body.annual_rate);
      if (r === null || r < 0 || r > 100) throw new ApiError('កាន្លោះត្រូវតែ 0–100', 400, 'BAD_RATE');
      push('annual_rate', r);
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');

    values.push(id);
    await db.prepare(`UPDATE loans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    await audit(req, 'update_loan', 'loans', id, fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, await db.prepare('SELECT * FROM loans WHERE id = ?').get(id));
  }));

  router.post('/loans/:id/repay', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const amount = money(num(req.body.amount) || 0);
    if (!(amount > 0)) throw new ApiError('ចំនួនលុយត្រូវតែ > 0', 400, 'BAD_AMOUNT');
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');

    const paid = money(Number(loan.paid) + amount);
    const active = paid >= Number(loan.principal) ? 0 : loan.active;
    await db.prepare('UPDATE loans SET paid = ?, active = ? WHERE id = ?').run(paid, active, id);
    await audit(req, 'repay_loan', 'loans', id, `$${amount}`);
    ok(res, await db.prepare('SELECT * FROM loans WHERE id = ?').get(id));
  }));

  router.delete('/loans/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    await db.prepare('DELETE FROM loans WHERE id = ?').run(id);
    await audit(req, 'delete_loan', 'loans', id);
    ok(res, { id, message: 'បានលុបកម្ចី' });
  }));

  // ============================================================
  // NOTIFICATIONS & PUSH
  // ============================================================
  router.get('/notifications', adminAuth, handle(async (req, res) => {
    const limit = Math.min(Math.max(int(req.query.limit, 50), 1), 200);
    const rows = await db.prepare(`
      SELECT n.*, u.name AS user_name, u.email AS user_email
      FROM notifications n JOIN users u ON u.id = n.user_id
      ORDER BY n.created_at DESC LIMIT ?
    `).all(limit);
    ok(res, { rows });
  }));

  router.post('/notify', adminAuth, handle(async (req, res) => {
    const userId = int(req.body.user_id);
    const title = String(req.body.title || '').trim().slice(0, 80);
    const body = String(req.body.body || '').trim().slice(0, 300);
    if (!title || !body) throw new ApiError('សូមបញ្ចូលចំណាង និងអត្ថបទ', 400, 'BAD_INPUT');
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'NOT_FOUND');

    const info = await db.prepare(`INSERT INTO notifications (user_id, title, body, icon_code)
      VALUES (?, ?, ?, 0)`).run(userId, title, body);
    if (sendPushNotification) sendPushNotification(userId, title, body, { type: 'admin' });
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
    const rows = await db.prepare(`SELECT t.*, u.name AS user_name, u.email AS user_email
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
    await db.prepare(`UPDATE ${name} SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    await audit(req, 'update_table', name, id, fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, { id, message: 'បានកែប្ដូរ' });
  }));

  router.delete('/tables/:name/:id', adminAuth, handle(async (req, res) => {
    const name = String(req.params.name);
    if (!EDITABLE_TABLES[name]) throw new ApiError('តារាងនេះមិនអាចលុប', 400, 'NOT_DELETABLE');
    const id = int(req.params.id);
    await db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id);
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

  return router;
};
