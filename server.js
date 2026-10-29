// ============================================================================
// Loan & Banking Backend — Complete Edition (with Google Auth & Secure Init)
// Features: Auth, Cards, Transactions, Goals, Notifs, Loans, Budgets,
//           Reminders, Recurring, Streak, Achievements, Search, Insights,
//           Cashback, Splits, Virtual Cards, Referral, FCM, Currency
// ============================================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const cors = require('cors');
const admin = require('firebase-admin'); // 🎯 បន្ថែម Firebase Admin

const app = express();
app.use(express.json());
app.use(cors());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const db = new Database('bank.db');
const SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
const SALT = 10;

// ============================================================
// FIREBASE ADMIN INITIALIZATION 🎯 (ដោះស្រាយបញ្ហាសុវត្ថិភាព)
// ============================================================
try {
  let serviceAccount;

  // ព្យាយាមទាញយកពីឯកសារ (សម្រាប់រត់លើ Local)
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (e) {
    // ប្រសិនបើគ្មានឯកសារ សូមទាញយកពី Environment Variable (សម្រាប់ Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      throw new Error('Missing Firebase credentials');
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin initialization error:', error.message);
}

// ============================================================
// SCHEMA
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    number TEXT NOT NULL,
    expiry TEXT NOT NULL,
    cvv TEXT NOT NULL,
    balance REAL DEFAULT 0,
    frozen INTEGER DEFAULT 0,
    online INTEGER DEFAULT 1,
    daily_limit REAL DEFAULT 2000,
    color1 INTEGER NOT NULL,
    color2 INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    is_expense INTEGER NOT NULL,
    icon_code INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target REAL NOT NULL,
    saved REAL DEFAULT 0,
    icon_code INTEGER NOT NULL,
    color INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    icon_code INTEGER NOT NULL,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    principal REAL NOT NULL,
    months INTEGER NOT NULL,
    annual_rate REAL NOT NULL,
    paid INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, category),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS streaks (
    user_id INTEGER PRIMARY KEY,
    current_days INTEGER DEFAULT 0,
    total_days INTEGER DEFAULT 0,
    last_check_in TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, code),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    due_date TEXT NOT NULL,
    paid INTEGER DEFAULT 0,
    icon_code INTEGER DEFAULT 16,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    card_id INTEGER NOT NULL,
    next_date TEXT NOT NULL,
    frequency TEXT DEFAULT 'monthly',
    active INTEGER DEFAULT 1,
    icon_code INTEGER DEFAULT 16,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    total_amount REAL NOT NULL,
    your_share REAL NOT NULL,
    participants TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS virtual_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    number TEXT NOT NULL,
    cvv TEXT NOT NULL,
    expiry TEXT NOT NULL,
    limit_amount REAL DEFAULT 500,
    spent REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    frozen INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    code TEXT UNIQUE NOT NULL,
    referred_count INTEGER DEFAULT 0,
    earnings REAL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS fcm_tokens (
    user_id INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cashback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    transaction_id INTEGER,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    rate REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ============================================================
// HELPERS
// ============================================================
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.userId = jwt.verify(token, SECRET).id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

// ============================================================
// ACHIEVEMENTS
// ============================================================
const ACHIEVEMENTS_DEF = [
  { code: 'first_tx', title: 'ប្រតិបត្តិការដំបូង', desc: 'បង្កើតប្រតិបត្តិការដំបូង', icon: '🎉' },
  { code: 'savings_100', title: 'អ្នកសន្សំ', desc: 'សន្សំបាន $100', icon: '💰' },
  { code: 'savings_1000', title: 'អ្នកសន្សំឆ្នើម', desc: 'សន្សំបាន $1000', icon: '🏆' },
  { code: 'streak_7', title: 'មួយសប្តាហ៍', desc: 'ចូល ៧ ថ្ងៃជាប់', icon: '🔥' },
  { code: 'streak_30', title: 'មួយខែ', desc: 'ចូល ៣០ ថ្ងៃជាប់', icon: '⚡' },
  { code: 'first_loan', title: 'កម្ចីដំបូង', desc: 'ស្នើកម្ចីដំបូង', icon: '📋' },
  { code: 'budget_set', title: 'អ្នករៀបចំថវិកា', desc: 'កំណត់ថវិកាដំបូង', icon: '📊' },
  { code: 'referral_1', title: 'អ្នកណែនាំ', desc: 'ណែនាំមិត្ត ១ នាក់', icon: '🤝' },
  { code: 'streak_100', title: 'មួយរយថ្ងៃ', desc: 'ចូល ១០០ ថ្ងៃជាប់', icon: '👑' },
  { code: 'budget_master', title: 'ម្ចាស់ថវិកា', desc: 'កំណត់ថវិកា ៥ ប្រភេទ', icon: '🎯' },
];

function unlockAchievement(userId, code) {
  try {
    db.prepare('INSERT OR IGNORE INTO achievements (user_id, code) VALUES (?, ?)')
      .run(userId, code);
  } catch (_) {}
}

// ============================================================
// CASHBACK
// ============================================================
const CASHBACK_RATES = {
  'អាហារ': 0.02,
  'ទិញទំនិញ': 0.01,
  'កម្សាន្ត': 0.03,
};

function computeCashback(userId, category, amount, txId) {
  const rate = CASHBACK_RATES[category];
  if (!rate || rate <= 0) return 0;
  const cashback = Math.round(amount * rate * 100) / 100;
  if (cashback <= 0) return 0;
  const card = db.prepare('SELECT id FROM cards WHERE user_id = ? LIMIT 1').get(userId);
  if (!card) return 0;
  db.prepare('UPDATE cards SET balance = balance + ? WHERE id = ?')
    .run(cashback, card.id);
  db.prepare(`INSERT INTO cashback (user_id, transaction_id, category, amount, rate)
    VALUES (?, ?, ?, ?, ?)`).run(userId, txId, category, cashback, rate);
  return cashback;
}

// ============================================================
// AUTH
// ============================================================
app.post('/auth/register', async (req, res) => {
  const { name, email, phone, pin } = req.body;
  if (!name || !email || !phone || !/^\d{4}$/.test(pin || ''))
    return fail(res, 'Invalid input');

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return fail(res, 'Email already registered');

  const hash = await bcrypt.hash(pin, SALT);
  const info = db.prepare(
    'INSERT INTO users (name, email, phone, pin_hash) VALUES (?, ?, ?, ?)'
  ).run(name, email, phone, hash);

  const userId = info.lastInsertRowid;

  const cards = [
    ['ABA Visa Platinum', '4532118800008824', '12/28', '458', 12450, 0xFF0052D4, 0xFF4364F7],
    ['Mastercard Gold', '5412750000003310', '09/27', '912', 5950, 0xFF0F9D8A, 0xFF38D39F],
    ['UnionPay Global', '6212260000005591', '05/29', '734', 0, 0xFF8E2DE2, 0xFF4A00E0],
  ];
  const insCard = db.prepare(`INSERT INTO cards
    (user_id, name, number, expiry, cvv, balance, color1, color2)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  cards.forEach(c => insCard.run(userId, ...c));

  const insGoal = db.prepare(`INSERT INTO goals
    (user_id, name, target, saved, icon_code, color)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insGoal.run(userId, 'ទិញទូរស័ព្ទថ្មី', 1200, 480, 14, 0xFF3D5AFE);
  insGoal.run(userId, 'ដំណើរកម្សាន្ត', 800, 650, 11, 0xFFFF8A3D);
  insGoal.run(userId, 'មូលនិធិគ្រាអាសន្ន', 3000, 900, 12, 0xFF16A34A);

  const token = jwt.sign({ id: userId }, SECRET, { expiresIn: '30d' });
  ok(res, { token, user: { id: userId, name, email, phone } });
});

app.post('/auth/login', (req, res) => {
  const { email, pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'User not found', 404);
  if (!bcrypt.compareSync(pin, user.pin_hash)) return fail(res, 'Wrong PIN', 401);
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
  });
});

// 🎯 GOOGLE AUTH ROUTE
app.post('/auth/google', async (req, res) => {
  const { id_token } = req.body;

  if (!id_token) {
    return fail(res, 'No token provided');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(id_token);
    const { uid, email, name } = decodedToken;

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      const hash = await bcrypt.hash('GOOGLE_AUTH_' + uid, SALT); 
      const phone = ''; 
      const info = db.prepare(
        'INSERT INTO users (name, email, phone, pin_hash) VALUES (?, ?, ?, ?)'
      ).run(name || 'Google User', email, phone, hash);

      const userId = info.lastInsertRowid;

      const cards = [
        ['ABA Visa Platinum', '4532118800008824', '12/28', '458', 12450, 0xFF0052D4, 0xFF4364F7],
        ['Mastercard Gold', '5412750000003310', '09/27', '912', 5950, 0xFF0F9D8A, 0xFF38D39F],
        ['UnionPay Global', '6212260000005591', '05/29', '734', 0, 0xFF8E2DE2, 0xFF4A00E0],
      ];
      const insCard = db.prepare(`INSERT INTO cards
        (user_id, name, number, expiry, cvv, balance, color1, color2)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      cards.forEach(c => insCard.run(userId, ...c));

      const insGoal = db.prepare(`INSERT INTO goals
        (user_id, name, target, saved, icon_code, color)
        VALUES (?, ?, ?, ?, ?, ?)`);
      insGoal.run(userId, 'ទិញទូរស័ព្ទថ្មី', 1200, 480, 14, 0xFF3D5AFE);
      insGoal.run(userId, 'ដំណើរកម្សាន្ត', 800, 650, 11, 0xFFFF8A3D);
      insGoal.run(userId, 'មូលនិធិគ្រាអាសន្ន', 3000, 900, 12, 0xFF16A34A);

      user = { id: userId, name: name || 'Google User', email: email, phone: phone };
    }

    const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });

    ok(res, {
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone }
    });

  } catch (error) {
    console.error('Google Auth Error:', error);
    fail(res, 'Invalid Google Token', 401);
  }
});

app.get('/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?')
    .get(req.userId);
  if (!u) return fail(res, 'Not found', 404);
  ok(res, u);
});

app.post('/auth/verify-pin', auth, (req, res) => {
  const { pin } = req.body;
  const u = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.userId);
  if (!u) return fail(res, 'User not found', 404);
  if (!bcrypt.compareSync(pin || '', u.pin_hash)) return fail(res, 'Wrong PIN', 401);
  ok(res, { valid: true });
});

// ============================================================
// CARDS
// ============================================================
app.get('/cards', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM cards WHERE user_id = ?').all(req.userId));
});

app.patch('/cards/:id', auth, (req, res) => {
  const { frozen, online, daily_limit } = req.body;
  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!card) return fail(res, 'Card not found', 404);

  const updates = [];
  const values = [];
  if (frozen !== undefined) { updates.push('frozen = ?'); values.push(frozen ? 1 : 0); }
  if (online !== undefined) { updates.push('online = ?'); values.push(online ? 1 : 0); }
  if (daily_limit !== undefined) { updates.push('daily_limit = ?'); values.push(daily_limit); }
  if (updates.length === 0) return fail(res, 'Nothing to update');
  values.push(req.params.id, req.userId);
  db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...values);
  ok(res, { updated: true });
});

// ============================================================
// TRANSACTIONS
// ============================================================
app.get('/transactions', auth, (req, res) => {
  ok(res, db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
  ).all(req.userId));
});

app.get('/transactions/search', auth, (req, res) => {
  const { q, category, from, to, min_amount, max_amount, is_expense } = req.query;
  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [req.userId];
  if (q) {
    sql += ' AND (title LIKE ? OR category LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  if (min_amount) { sql += ' AND amount >= ?'; params.push(parseFloat(min_amount)); }
  if (max_amount) { sql += ' AND amount <= ?'; params.push(parseFloat(max_amount)); }
  if (is_expense !== undefined) {
    sql += ' AND is_expense = ?';
    params.push(is_expense === 'true' ? 1 : 0);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  ok(res, db.prepare(sql).all(...params));
});

app.post('/transactions', auth, (req, res) => {
  const { card_id, title, category, amount, is_expense, icon_code, pin } = req.body;
  const u = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(pin || '', u.pin_hash)) return fail(res, 'Wrong PIN', 401);

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?')
    .get(card_id, req.userId);
  if (!card) return fail(res, 'Card not found', 404);
  if (card.frozen) return fail(res, 'Card is frozen');
  if (amount <= 0) return fail(res, 'Invalid amount');
  if (is_expense && card.balance < amount) return fail(res, 'Insufficient balance');
  if (is_expense && amount > card.daily_limit) return fail(res, 'Exceeds daily limit');

  const run = db.transaction(() => {
    const delta = is_expense ? -amount : amount;
    db.prepare('UPDATE cards SET balance = balance + ? WHERE id = ?').run(delta, card_id);
    const info = db.prepare(`INSERT INTO transactions
      (user_id, card_id, title, category, amount, is_expense, icon_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.userId, card_id, title, category, amount, is_expense ? 1 : 0, icon_code);
    db.prepare(`INSERT INTO notifications
      (user_id, title, body, icon_code) VALUES (?, ?, ?, ?)`)
      .run(req.userId,
        is_expense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
        `${title}  ${is_expense ? '-' : '+'}$${amount.toFixed(2)}`,
        icon_code);
    return info.lastInsertRowid;
  });

  try {
    const id = run();
    let cashback = 0;
    if (is_expense) cashback = computeCashback(req.userId, category, amount, id);
    ok(res, {
      id, cashback,
      new_balance: db.prepare('SELECT balance FROM cards WHERE id = ?').get(card_id).balance,
    });
  } catch (e) {
    fail(res, e.message, 500);
  }
});

// ============================================================
// GOALS
// ============================================================
app.get('/goals', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM goals WHERE user_id = ?').all(req.userId));
});

app.post('/goals', auth, (req, res) => {
  const { name, target, icon_code, color } = req.body;
  if (!name || target <= 0) return fail(res, 'Invalid');
  const info = db.prepare(
    'INSERT INTO goals (user_id, name, target, icon_code, color) VALUES (?, ?, ?, ?, ?)'
  ).run(req.userId, name, target, icon_code || 19, color || 0xFF3D5AFE);
  ok(res, { id: info.lastInsertRowid });
});

app.post('/goals/:id/deposit', auth, (req, res) => {
  const { amount } = req.body;
  if (amount <= 0) return fail(res, 'Invalid amount');
  const g = db.prepare('SELECT id FROM goals WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!g) return fail(res, 'Not found', 404);
  db.prepare('UPDATE goals SET saved = saved + ? WHERE id = ?').run(amount, req.params.id);
  const g2 = db.prepare('SELECT saved FROM goals WHERE id = ?').get(req.params.id);
  if (g2.saved >= 100) unlockAchievement(req.userId, 'savings_100');
  if (g2.saved >= 1000) unlockAchievement(req.userId, 'savings_1000');
  ok(res, { updated: true });
});

// ============================================================
// NOTIFICATIONS
// ============================================================
app.get('/notifications', auth, (req, res) => {
  ok(res, db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.userId));
});

app.post('/notifications/read-all', auth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.userId);
  ok(res, { read: true });
});

// ============================================================
// LOANS
// ============================================================
app.get('/loan', auth, (req, res) => {
  ok(res, db.prepare(
    'SELECT * FROM loans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1'
  ).get(req.userId) || null);
});

app.post('/loan', auth, (req, res) => {
  const { principal, months, annual_rate } = req.body;
  if (principal <= 0 || months < 1) return fail(res, 'Invalid');
  const exists = db.prepare(
    'SELECT id FROM loans WHERE user_id = ? AND active = 1'
  ).get(req.userId);
  if (exists) return fail(res, 'You already have an active loan');

  const info = db.prepare(
    'INSERT INTO loans (user_id, principal, months, annual_rate) VALUES (?, ?, ?, ?)'
  ).run(req.userId, principal, months, annual_rate);

  const firstCard = db.prepare('SELECT id FROM cards WHERE user_id = ? LIMIT 1').get(req.userId);
  if (firstCard) {
    db.prepare('UPDATE cards SET balance = balance + ? WHERE id = ?').run(principal, firstCard.id);
  }
  unlockAchievement(req.userId, 'first_loan');
  ok(res, { id: info.lastInsertRowid });
});

app.post('/loan/pay', auth, (req, res) => {
  const loan = db.prepare(
    'SELECT * FROM loans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1'
  ).get(req.userId);
  if (!loan) return fail(res, 'No active loan');

  const r = loan.annual_rate / 12 / 100;
  const monthly = r === 0 ? loan.principal / loan.months
    : loan.principal * r / (1 - Math.pow(1 + r, -loan.months));

  const card = db.prepare('SELECT * FROM cards WHERE user_id = ? LIMIT 1').get(req.userId);
  if (!card || card.balance < monthly) return fail(res, 'Insufficient balance');

  db.prepare('UPDATE cards SET balance = balance - ? WHERE id = ?').run(monthly, card.id);
  const newPaid = loan.paid + 1;
  const active = newPaid >= loan.months ? 0 : 1;
  db.prepare('UPDATE loans SET paid = ?, active = ? WHERE id = ?')
    .run(newPaid, active, loan.id);
  ok(res, { monthly, paid: newPaid, months: loan.months });
});

// ============================================================
// ANALYTICS
// ============================================================
app.get('/analytics', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT category, SUM(amount) AS total FROM transactions WHERE user_id = ? AND is_expense = 1 GROUP BY category'
  ).all(req.userId);
  const income = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND is_expense = 0'
  ).get(req.userId).s;
  const expense = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND is_expense = 1'
  ).get(req.userId).s;
  ok(res, { income, expense, by_category: rows });
});

// ============================================================
// BUDGETS
// ============================================================
app.get('/budgets', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(req.userId);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const spentRows = db.prepare(`
    SELECT category, SUM(amount) AS spent FROM transactions
    WHERE user_id = ? AND is_expense = 1 AND created_at >= ?
    GROUP BY category
  `).all(req.userId, startOfMonth.toISOString());
  const spentMap = {};
  for (const r of spentRows) spentMap[r.category] = r.spent;
  ok(res, rows.map(b => ({ ...b, spent: spentMap[b.category] || 0 })));
});

app.post('/budgets', auth, (req, res) => {
  const { category, amount } = req.body;
  if (!category || amount <= 0) return fail(res, 'Invalid');
  try {
    db.prepare('INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)')
      .run(req.userId, category, amount);
    const count = db.prepare('SELECT COUNT(*) AS c FROM budgets WHERE user_id = ?')
      .get(req.userId).c;
    unlockAchievement(req.userId, 'budget_set');
    if (count >= 5) unlockAchievement(req.userId, 'budget_master');
    ok(res, { created: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return fail(res, 'Budget already exists');
    fail(res, e.message, 500);
  }
});

app.patch('/budgets/:id', auth, (req, res) => {
  db.prepare('UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?')
    .run(req.body.amount, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/budgets/:id', auth, (req, res) => {
  db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// STREAK
// ============================================================
app.get('/streak', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM streaks WHERE user_id = ?').get(req.userId);
  ok(res, s || { current_days: 0, total_days: 0, last_check_in: null });
});

app.post('/streak/check-in', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  let s = db.prepare('SELECT * FROM streaks WHERE user_id = ?').get(req.userId);
  if (!s) {
    db.prepare('INSERT INTO streaks (user_id, current_days, total_days, last_check_in) VALUES (?, 1, 1, ?)')
      .run(req.userId, today);
    return ok(res, { current_days: 1, total_days: 1, is_new: true });
  }
  if (s.last_check_in === today) return ok(res, { ...s, is_new: false });
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const consecutive = s.last_check_in === yesterday;
  const newCurrent = consecutive ? s.current_days + 1 : 1;
  db.prepare('UPDATE streaks SET current_days = ?, total_days = ?, last_check_in = ? WHERE user_id = ?')
    .run(newCurrent, s.total_days + 1, today, req.userId);
  if (newCurrent >= 7) unlockAchievement(req.userId, 'streak_7');
  if (newCurrent >= 30) unlockAchievement(req.userId, 'streak_30');
  if (newCurrent >= 100) unlockAchievement(req.userId, 'streak_100');
  ok(res, { current_days: newCurrent, total_days: s.total_days + 1, is_new: true });
});

// ============================================================
// ACHIEVEMENTS
// ============================================================
app.get('/achievements', auth, (req, res) => {
  const unlocked = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id = ?').all(req.userId);
  const map = {};
  for (const u of unlocked) map[u.code] = u.unlocked_at;
  ok(res, ACHIEVEMENTS_DEF.map(a => ({
    ...a, unlocked: !!map[a.code], unlocked_at: map[a.code] || null,
  })));
});

// ============================================================
// REMINDERS
// ============================================================
app.get('/reminders', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date ASC').all(req.userId));
});

app.post('/reminders', auth, (req, res) => {
  const { title, amount, due_date, icon_code } = req.body;
  if (!title || amount <= 0 || !due_date) return fail(res, 'Invalid');
  db.prepare('INSERT INTO reminders (user_id, title, amount, due_date, icon_code) VALUES (?, ?, ?, ?, ?)')
    .run(req.userId, title, amount, due_date, icon_code || 16);
  ok(res, { created: true });
});

app.patch('/reminders/:id', auth, (req, res) => {
  db.prepare('UPDATE reminders SET paid = ? WHERE id = ? AND user_id = ?')
    .run(req.body.paid ? 1 : 0, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/reminders/:id', auth, (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// RECURRING
// ============================================================
app.get('/recurring', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM recurring WHERE user_id = ? ORDER BY next_date ASC').all(req.userId));
});

app.post('/recurring', auth, (req, res) => {
  const { title, amount, category, card_id, next_date, frequency, icon_code } = req.body;
  if (!title || amount <= 0 || !next_date || !card_id) return fail(res, 'Invalid');
  db.prepare(`INSERT INTO recurring
    (user_id, title, amount, category, card_id, next_date, frequency, icon_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.userId, title, amount, category || 'វិក្កយបត្រ', card_id, next_date, frequency || 'monthly', icon_code || 16);
  ok(res, { created: true });
});

app.patch('/recurring/:id', auth, (req, res) => {
  db.prepare('UPDATE recurring SET active = ? WHERE id = ? AND user_id = ?')
    .run(req.body.active ? 1 : 0, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/recurring/:id', auth, (req, res) => {
  db.prepare('DELETE FROM recurring WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

app.post('/recurring/process-due', auth, (req, res) => {
  const today = new Date().toISOString();
  const due = db.prepare(`
    SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND next_date <= ?
  `).all(req.userId, today);
  let processed = 0;
  for (const r of due) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?')
      .get(r.card_id, req.userId);
    if (!card || card.balance < r.amount || card.frozen) continue;
    db.prepare('UPDATE cards SET balance = balance - ? WHERE id = ?').run(r.amount, r.card_id);
    db.prepare(`INSERT INTO transactions
      (user_id, card_id, title, category, amount, is_expense, icon_code)
      VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(req.userId, r.card_id, r.title, r.category, r.amount, r.icon_code);
    const next = new Date();
    if (r.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (r.frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (r.frequency === 'yearly') next.setFullYear(next.getFullYear() + 1);
    db.prepare('UPDATE recurring SET next_date = ? WHERE id = ?')
      .run(next.toISOString().split('T')[0], r.id);
    processed++;
  }
  ok(res, { processed });
});

// ============================================================
// SPLITS
// ============================================================
app.get('/splits', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM splits WHERE user_id = ? ORDER BY created_at DESC').all(req.userId));
});

app.post('/splits', auth, (req, res) => {
  const { title, total_amount, participants } = req.body;
  if (!title || total_amount <= 0 || !Array.isArray(participants) || participants.length < 1)
    return fail(res, 'Invalid');
  const share = total_amount / (participants.length + 1);
  db.prepare(`INSERT INTO splits
    (user_id, title, total_amount, your_share, participants) VALUES (?, ?, ?, ?, ?)`)
    .run(req.userId, title, total_amount, share, JSON.stringify(participants));
  ok(res, { your_share: share });
});

// ============================================================
// VIRTUAL CARDS
// ============================================================
app.get('/virtual-cards', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM virtual_cards WHERE user_id = ?').all(req.userId));
});

app.post('/virtual-cards', auth, (req, res) => {
  const { name, limit_amount } = req.body;
  if (!name) return fail(res, 'Invalid');
  const number = '4' + Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
  const cvv = String(Math.floor(100 + Math.random() * 900));
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const y = String(new Date().getFullYear() + 3).slice(-2);
  const expiry = `${m}/${y}`;
  db.prepare(`INSERT INTO virtual_cards
    (user_id, name, number, cvv, expiry, limit_amount) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.userId, name, number, cvv, expiry, limit_amount || 500);
  ok(res, { created: true });
});

app.patch('/virtual-cards/:id', auth, (req, res) => {
  const { active, frozen } = req.body;
  const updates = [];
  const params = [];
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (frozen !== undefined) { updates.push('frozen = ?'); params.push(frozen ? 1 : 0); }
  if (updates.length === 0) return fail(res, 'Nothing to update');
  params.push(req.params.id, req.userId);
  db.prepare(`UPDATE virtual_cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
    .run(...params);
  ok(res, { updated: true });
});

app.delete('/virtual-cards/:id', auth, (req, res) => {
  db.prepare('DELETE FROM virtual_cards WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// REFERRAL
// ============================================================
app.get('/referral', auth, (req, res) => {
  let r = db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  if (!r) {
    const code = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    db.prepare('INSERT INTO referrals (user_id, code) VALUES (?, ?)').run(req.userId, code);
    r = db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  }
  ok(res, r);
});

app.post('/referral/redeem', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return fail(res, 'Invalid');
  const referrer = db.prepare('SELECT user_id FROM referrals WHERE code = ?')
    .get(code.toUpperCase());
  if (!referrer) return fail(res, 'Invalid code');
  if (referrer.user_id === req.userId) return fail(res, 'Cannot use own code');
  db.prepare('UPDATE cards SET balance = balance + 5 WHERE user_id = ?').run(referrer.user_id);
  db.prepare('UPDATE cards SET balance = balance + 5 WHERE user_id = ?').run(req.userId);
  db.prepare('UPDATE referrals SET referred_count = referred_count + 1, earnings = earnings + 5 WHERE user_id = ?')
    .run(referrer.user_id);
  db.prepare('INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, ?)')
    .run(referrer.user_id, 'ប្រាក់រង្វាន់ Referral', 'ទទួលបាន $5.00', 18);
  unlockAchievement(referrer.user_id, 'referral_1');
  ok(res, { bonus: 5 });
});

// ============================================================
// CASHBACK
// ============================================================
app.get('/cashback', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM cashback WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(req.userId);
  const total = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM cashback WHERE user_id = ?'
  ).get(req.userId).s;
  ok(res, { total, history: rows, rates: CASHBACK_RATES });
});

// ============================================================
// INSIGHTS
// ============================================================
app.get('/insights', auth, (req, res) => {
  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const endLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

  const thisMonth = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE user_id = ? AND is_expense = 1 AND created_at >= ?
    GROUP BY category ORDER BY total DESC
  `).all(req.userId, startThisMonth);

  const lastMonth = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM transactions
    WHERE user_id = ? AND is_expense = 1 AND created_at >= ? AND created_at <= ?
    GROUP BY category
  `).all(req.userId, startLastMonth, endLastMonth);

  const lastMap = {};
  for (const r of lastMonth) lastMap[r.category] = r.total;

  const totalThisMonth = thisMonth.reduce((s, r) => s + r.total, 0);
  const totalLastMonth = lastMonth.reduce((s, r) => s + r.total, 0);

  const insights = [];

  if (thisMonth.length > 0) {
    const top = thisMonth[0];
    const pct = totalThisMonth > 0 ? (top.total / totalThisMonth * 100).toFixed(0) : 0;
    insights.push({
      type: 'top_category', icon: '📊',
      title: 'ប្រភេទចំណាយច្រើនបំផុត',
      body: `អ្នកចំណាយ $${top.total.toFixed(2)} លើ "${top.category}" (${pct}% នៃចំណាយសរុប)`,
      severity: parseFloat(pct) > 40 ? 'warning' : 'info',
    });
  }

  if (totalLastMonth > 0) {
    const diff = totalThisMonth - totalLastMonth;
    const pct = (diff / totalLastMonth * 100).toFixed(0);
    if (Math.abs(diff) > 10) {
      insights.push({
        type: 'month_compare', icon: diff > 0 ? '📈' : '📉',
        title: diff > 0 ? 'ចំណាយកើនឡើង' : 'ចំណាយថយចុះ',
        body: diff > 0
          ? `ចំណាយខែនេះកើន ${pct}% ធៀបខែមុន (+\$${diff.toFixed(2)})`
          : `អ្នកសន្សំបាន $${Math.abs(diff).toFixed(2)} (${Math.abs(pct)}% តិចជាងខែមុន)`,
        severity: diff > 0 ? 'warning' : 'success',
      });
    }
  }

  for (const cat of thisMonth) {
    const last = lastMap[cat.category] || 0;
    if (last > 0 && cat.total > last * 1.5 && cat.total - last > 20) {
      insights.push({
        type: 'spike', icon: '⚠️',
        title: `កើនឡើងលើ "${cat.category}"`,
        body: `ចំណាយលើ "${cat.category}" កើនពី $${last.toFixed(2)} → $${cat.total.toFixed(2)}`,
        severity: 'warning',
      });
    }
  }

  if (thisMonth.length > 0) {
    const frequent = thisMonth.reduce((m, r) => r.count > m.count ? r : m, thisMonth[0]);
    if (frequent.count >= 5) {
      insights.push({
        type: 'frequency', icon: '🔁',
        title: 'ចំណាយញឹកញាប់',
        body: `អ្នកមានប្រតិបត្តិការ "${frequent.category}" ${frequent.count} ដងខែនេះ`,
        severity: 'info',
      });
    }
  }

  if (totalThisMonth < totalLastMonth * 0.8 && totalLastMonth > 0) {
    insights.push({
      type: 'encouragement', icon: '🎉',
      title: 'ល្អណាស់!',
      body: 'អ្នកកំពុងគ្រប់គ្រងចំណាយបានល្អ ធៀបខែមុន',
      severity: 'success',
    });
  }

  const budgets = db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(req.userId);
  for (const b of budgets) {
    const spent = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE user_id = ? AND is_expense = 1 AND category = ? AND created_at >= ?
    `).get(req.userId, b.category, startThisMonth).s;
    if (spent > b.amount) {
      insights.push({
        type: 'budget_over', icon: '🚨',
        title: `លើសថវិកា "${b.category}"`,
        body: `អ្នកចំណាយ $${spent.toFixed(2)} លើសថវិកា $${b.amount.toFixed(2)}`,
        severity: 'danger',
      });
    }
  }

  ok(res, {
    this_month_total: totalThisMonth,
    last_month_total: totalLastMonth,
    by_category: thisMonth,
    insights,
  });
});

// ============================================================
// FCM
// ============================================================
app.post('/fcm/register', auth, (req, res) => {
  const { token } = req.body;
  if (!token) return fail(res, 'Invalid');
  db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(req.userId);
  db.prepare('INSERT INTO fcm_tokens (user_id, token) VALUES (?, ?)')
    .run(req.userId, token);
  ok(res, { registered: true });
});

// ============================================================
// CURRENCY
// ============================================================
app.get('/currency/rates', auth, (req, res) => {
  ok(res, { USD_KHR: 4100, KHR_USD: 1 / 4100 });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend on http://localhost:${PORT}`));