// ============================================================================
// Loan & Banking Backend — Complete Edition
// (Firebase Admin + FCM + Secure Transfers + QR + PIN lockout)
// ============================================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const cors = require('cors');

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
app.use(express.json({ limit: '10kb' }));
// Express 5 មិនបំពេញ req.body = {} ទេ ពេលសំណើគ្មាន body → routes ដែល destructure
// req.body នឹង throw TypeError → 500 "Server error". Normalize ត្រង់នេះម្ដង។
app.use((req, _res, next) => {
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});
app.use(cors());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ---------- CONFIG ----------
// ⚠️ Render: ឯកសារ bank.db បាត់ពេល redeploy លើកលែងតែអ្នកភ្ជាប់ Persistent Disk
//    ហើយកំណត់ DB_PATH=/var/data/bank.db
const db = new Database(process.env.DB_PATH || 'bank.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
if (IS_PROD && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
const SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
const QR_SECRET = process.env.QR_SECRET || SECRET + ':qr';
const SALT = 10;

const TZ = '+7 hours';                 // ម៉ោងកម្ពុជា សម្រាប់កំណត់ "ថ្ងៃនេះ"
const MAX_TX = 10000;                  // កំណត់ចំនួនអតិបរមាក្នុងមួយប្រតិបត្តិការ
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
// ⚠️ បើអ្នកមានមុខងារ "បញ្ចូលលុយ" សម្រាប់ Demo ទើបបើវា (ក្នុង Production ត្រូវ false)
const ALLOW_DEMO_INCOME = process.env.ALLOW_DEMO_INCOME === 'true';

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================
try {
  console.log('⏳ Initializing Firebase Admin...');
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
      rawJson = rawJson.slice(1, -1);
    }
    serviceAccount = JSON.parse(rawJson);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    try {
      serviceAccount = require('./serviceAccountKey.json');
    } catch (e) {
      throw new Error('Missing FIREBASE_SERVICE_ACCOUNT environment variable or serviceAccountKey.json file.');
    }
  }

  if (!serviceAccount || !serviceAccount.project_id) {
    throw new Error('Service account configuration is invalid or missing project_id.');
  }
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin initialization error:', error.message);
}

// ============================================================
// SCHEMA & MIGRATION
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    auth_provider TEXT DEFAULT 'email',
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

  -- ថ្មី: ការពារការផ្ទេរស្ទួន
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    req_hash TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key, user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- ថ្មី: បញ្ជីធនាគារ/MFI ដែលគាំទ្រការផ្ទេរចេញក្រៅ
  CREATE TABLE IF NOT EXISTS banks (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    fee_rate REAL NOT NULL DEFAULT 0,
    fee_max REAL NOT NULL DEFAULT 0,
    min_amount REAL NOT NULL DEFAULT 0.01,
    max_amount REAL NOT NULL DEFAULT 10000,
    active INTEGER NOT NULL DEFAULT 1
  );

  -- ថ្មី: ការផ្ទេរចេញក្រៅ (រវាងធនាគារ/MFIs/វ៉លឡេត)
  CREATE TABLE IF NOT EXISTS external_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    bank_code TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_account TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    amount REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    transfer_ref TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'settled',
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
  );
`);

function addColumn(table, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`✅ Added ${table}.${ddl}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error(`❌ Migration ${table}.${ddl}:`, e.message);
  }
}
addColumn('users', "auth_provider TEXT DEFAULT 'email'");
addColumn('users', 'pin_attempts INTEGER DEFAULT 0');
addColumn('users', 'locked_until TEXT');
addColumn('users', 'referred_by INTEGER');
addColumn('transactions', 'counterparty_id INTEGER');
addColumn('transactions', 'transfer_ref TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id, is_expense);
  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_tx_user_cp ON transactions(user_id, counterparty_id);
  CREATE INDEX IF NOT EXISTS idx_ext_user_created
    ON external_transfers(user_id, created_at);
`);

// បញ្ជីធនាគារ/MFI ចាប់ផ្តើម (បញ្ចូលតែពេលតារាងទទេ ដើម្បីកុំឲ្យលុបតួលេខដែលកែដោយដៃ)
try {
  const n = db.prepare('SELECT COUNT(*) AS c FROM banks').get().c;
  if (n === 0) {
    const insBank = db.prepare(`INSERT INTO banks
      (code, name, currency, fee_rate, fee_max, min_amount, max_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    [
      ['ABA', 'ABA Bank', 'USD', 0, 0, 0.01, 10000],
      ['ACLEDA', 'ACLEDA Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['CANADIA', 'Canadia Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['WING', 'Wing Bank', 'USD', 0.002, 8, 0.01, 5000],
      ['JUNTUOR', 'Jotuor Account', 'USD', 0.001, 5, 0.01, 5000],
      ['LYF', 'LYF Wallet', 'USD', 0.002, 8, 0.01, 2000],
      ['OTHER', 'Global / Other Bank', 'USD', 0.005, 15, 1, 10000],
    ].forEach((b) => insBank.run(...b));
    console.log('✅ Seeded bank directory');
  }
} catch (e) {
  console.error('❌ Bank directory seed:', e.message);
}

// Users ចាស់ដែលមាន pin_hash ជា placeholder
try {
  const n = db.prepare(
    "UPDATE users SET auth_provider = 'google' WHERE pin_hash LIKE 'GOOGLE_AUTH_%'"
  ).run().changes;
  if (n > 0) console.log(`✅ Migrated ${n} Google users`);
} catch (e) {
  console.log('ℹ️ Migration check completed');
}

// ============================================================
// HELPERS
// ============================================================
class ApiError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ok = (res, data) => res.json({ success: true, data });
const fail = (res, msg, status = 400, code = null) =>
  res.status(status).json({ success: false, error: msg, ...(code ? { code } : {}) });

// ព័ទ្ធ async handler ទាំងអស់ ឲ្យចាប់ error មួយកន្លែង
const handle = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof ApiError) return fail(res, e.message, e.status, e.code);
    console.error('❌ Unhandled:', e);
    fail(res, 'Server error', 500, 'SERVER_ERROR');
  });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: 'No token' });
  try {
    req.userId = jwt.verify(token, SECRET).id;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// លុយ: បម្លែងជាលេខ ២ខ្ទង់ ឬ NaN
function toMoney(v) {
  const n = typeof v === 'number' ? v
    : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

// Rate limit សាមញ្ញក្នុង memory
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    throw new ApiError('សូមរង់ចាំបន្តិច រួចព្យាយាមម្ដងទៀត', 429, 'RATE_LIMITED');
  }
  arr.push(now);
  hits.set(key, arr);
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// ពិនិត្យ PIN ជាមួយ lockout (៥ដងខុស → ចាក់សោ ១៥នាទី)
async function checkPin(userId, pin) {
  const u = db.prepare(`
    SELECT pin_hash, pin_attempts,
           (locked_until IS NOT NULL AND locked_until > datetime('now')) AS locked
    FROM users WHERE id = ?`).get(userId);
  if (!u) throw new ApiError('User not found', 404, 'NOT_FOUND');
  if (u.locked) {
    throw new ApiError(`គណនីត្រូវបានចាក់សោ សូមព្យាយាមម្ដងទៀតក្រោយ ${LOCK_MINUTES} នាទី`, 423, 'PIN_LOCKED');
  }

  let valid = false;
  if (typeof pin === 'string' && /^\d{4}$/.test(pin)) {
    try { valid = await bcrypt.compare(pin, u.pin_hash); } catch { valid = false; }
  }

  if (!valid) {
    const attempts = (u.pin_attempts || 0) + 1;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      db.prepare(`UPDATE users SET pin_attempts = 0,
        locked_until = datetime('now', '+${LOCK_MINUTES} minutes') WHERE id = ?`).run(userId);
      throw new ApiError(`PIN ខុសច្រើនដងពេក គណនីត្រូវចាក់សោ ${LOCK_MINUTES} នាទី`, 423, 'PIN_LOCKED');
    }
    db.prepare('UPDATE users SET pin_attempts = ? WHERE id = ?').run(attempts, userId);
    throw new ApiError('Wrong PIN', 401, 'WRONG_PIN');
  }
  if (u.pin_attempts) {
    db.prepare('UPDATE users SET pin_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
  }
}

const spentToday = (cardId) => db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
  WHERE card_id = ? AND is_expense = 1
    AND date(created_at, '${TZ}') = date('now', '${TZ}')`).get(cardId).s;

function maskContact(u) {
  const digits = String(u.phone || '').replace(/\D/g, '');
  if (digits.length >= 4) return `•••• ${digits.slice(-4)}`;
  const [local, domain] = String(u.email || '').split('@');
  return local && domain ? `${local[0]}•••@${domain}` : '••••';
}

async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const row = db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').get(userId);
    if (!row || !row.token || getApps().length === 0) {
      console.log(`ℹ️ No FCM token for user ${userId} or Firebase not initialized`);
      return;
    }
    const strData = {};
    for (const [k, v] of Object.entries({ click_action: 'FLUTTER_NOTIFICATION_CLICK', ...data })) {
      strData[k] = String(v); // FCM data ត្រូវតែជា string
    }
    await getMessaging().send({
      token: row.token,
      notification: { title, body },
      data: strData,
      android: { priority: 'high' },
    });
    console.log(`✅ FCM sent to user ${userId}`);
  } catch (error) {
    console.error('❌ FCM sending failed:', error.message);
    if (error.code === 'messaging/registration-token-not-registered') {
      db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(userId);
    }
  }
}

function seedNewUser(userId) {
  const cards = [
    ['ABA Visa Platinum', '4532118800008824', '12/28', '458', 12450, 0xFF0052D4, 0xFF4364F7],
    ['Mastercard Gold', '5412750000003310', '09/27', '912', 5950, 0xFF0F9D8A, 0xFF38D39F],
    ['UnionPay Global', '6212260000005591', '05/29', '734', 0, 0xFF8E2DE2, 0xFF4A00E0],
  ];
  const insCard = db.prepare(`INSERT INTO cards
    (user_id, name, number, expiry, cvv, balance, color1, color2)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  cards.forEach((c) => insCard.run(userId, ...c));

  const insGoal = db.prepare(`INSERT INTO goals
    (user_id, name, target, saved, icon_code, color) VALUES (?, ?, ?, ?, ?, ?)`);
  insGoal.run(userId, 'ទិញទូរស័ព្ទថ្មី', 1200, 480, 14, 0xFF3D5AFE);
  insGoal.run(userId, 'ដំណើរកម្សាន្ត', 800, 650, 11, 0xFFFF8A3D);
  insGoal.run(userId, 'មូលនិធិគ្រាអាសន្ន', 3000, 900, 12, 0xFF16A34A);
}

// ============================================================
// ACHIEVEMENTS & CASHBACK DEFS
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
    db.prepare('INSERT OR IGNORE INTO achievements (user_id, code) VALUES (?, ?)').run(userId, code);
  } catch (_) {}
}

const CASHBACK_RATES = { 'អាហារ': 0.02, 'ទិញទំនិញ': 0.01, 'កម្សាន្ត': 0.03 };

function computeCashback(userId, category, amount, txId) {
  const rate = CASHBACK_RATES[category];
  if (!rate || rate <= 0) return 0;
  const cashback = Math.round(amount * rate * 100) / 100;
  if (cashback <= 0) return 0;
  const card = db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
  if (!card) return 0;
  db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(cashback, card.id);
  db.prepare(`INSERT INTO cashback (user_id, transaction_id, category, amount, rate)
    VALUES (?, ?, ?, ?, ?)`).run(userId, txId, category, cashback, rate);
  return cashback;
}

// ============================================================
// AUTH
// ============================================================
app.post('/auth/register', handle(async (req, res) => {
  const { name, email, phone, pin } = req.body;
  if (!name || !email || !phone || !/^\d{4}$/.test(pin || ''))
    throw new ApiError('Invalid input');

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new ApiError('Email already registered');

  const hash = await bcrypt.hash(pin, SALT);
  const info = db.prepare(
    'INSERT INTO users (name, email, phone, pin_hash, auth_provider) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email, phone, hash, 'email');
  const userId = info.lastInsertRowid;
  seedNewUser(userId);

  const token = jwt.sign({ id: userId }, SECRET, { expiresIn: '30d' });
  ok(res, { token, user: { id: userId, name, email, phone } });
}));

app.post('/auth/login', handle(async (req, res) => {
  const { email, pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new ApiError('User not found', 404, 'NOT_FOUND');

  if (user.auth_provider === 'google') {
    throw new ApiError('This account is linked with Google. Please use Google Login.', 400, 'USE_GOOGLE');
  }
  await checkPin(user.id, pin);

  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
  });
}));

app.post('/auth/google', handle(async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) throw new ApiError('No token provided');
  if (!getApps().length) throw new ApiError('Firebase Admin is not initialized on server.', 500);

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(id_token);
  } catch (e) {
    console.error('Google Auth Error:', e.message);
    throw new ApiError('Invalid Google Token', 401, 'BAD_GOOGLE_TOKEN');
  }
  const { email, name, email_verified } = decoded;
  if (!email || email_verified === false) {
    throw new ApiError('Google email is not verified', 401, 'EMAIL_NOT_VERIFIED');
  }

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let generatedPin = null;

  if (!user) {
    generatedPin = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await bcrypt.hash(generatedPin, SALT);
    const info = db.prepare(
      'INSERT INTO users (name, email, phone, pin_hash, auth_provider) VALUES (?, ?, ?, ?, ?)'
    ).run(name || 'Google User', email, '', hash, 'google');
    seedNewUser(info.lastInsertRowid);
    user = { id: info.lastInsertRowid, name: name || 'Google User', email, phone: '' };
  }
  // បើមានគណនីស្រាប់ មិនប្ដូរ auth_provider ទៀតទេ (ពីមុនធ្វើឲ្យ PIN login ខូច)

  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
    generatedPin,
  });
}));

app.get('/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, name, email, phone, auth_provider FROM users WHERE id = ?')
    .get(req.userId);
  if (!u) return fail(res, 'Not found', 404, 'NOT_FOUND');
  ok(res, u);
});

// ពិនិត្យ PIN (លែងមាន bypass សម្រាប់ Google User)
app.post('/auth/verify-pin', auth, handle(async (req, res) => {
  await checkPin(req.userId, req.body.pin);
  ok(res, { valid: true });
}));

// ប្ដូរ PIN (ត្រូវដឹង PIN ចាស់)
app.post('/auth/change-pin', auth, handle(async (req, res) => {
  const { old_pin, new_pin } = req.body;
  if (!/^\d{4}$/.test(new_pin || '')) throw new ApiError('PIN ថ្មីត្រូវមាន ៤ ខ្ទង់', 400, 'BAD_PIN');
  await checkPin(req.userId, old_pin);
  const hash = await bcrypt.hash(new_pin, SALT);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hash, req.userId);
  ok(res, { changed: true });
}));

// កំណត់ PIN សម្រាប់ Google User ដោយបញ្ជាក់ខ្លួនឡើងវិញតាម Google (ក្នុង ៥នាទី)
app.post('/auth/google/set-pin', auth, handle(async (req, res) => {
  const { id_token, new_pin } = req.body;
  if (!/^\d{4}$/.test(new_pin || '')) throw new ApiError('PIN ថ្មីត្រូវមាន ៤ ខ្ទង់', 400, 'BAD_PIN');
  if (!id_token || !getApps().length) throw new ApiError('No token provided');

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(id_token);
  } catch {
    throw new ApiError('Invalid Google Token', 401, 'BAD_GOOGLE_TOKEN');
  }
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.userId);
  if (!user || user.email !== decoded.email || decoded.email_verified === false)
    throw new ApiError('Google account mismatch', 403, 'ACCOUNT_MISMATCH');
  if (Date.now() / 1000 - (decoded.auth_time || 0) > 300)
    throw new ApiError('សូមចូលតាម Google ម្ដងទៀត', 401, 'REAUTH_REQUIRED');

  const hash = await bcrypt.hash(new_pin, SALT);
  db.prepare('UPDATE users SET pin_hash = ?, pin_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hash, req.userId);
  ok(res, { changed: true });
}));

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
  if (!card) return fail(res, 'Card not found', 404, 'NOT_FOUND');

  const updates = [];
  const values = [];
  if (frozen !== undefined) { updates.push('frozen = ?'); values.push(frozen ? 1 : 0); }
  if (online !== undefined) { updates.push('online = ?'); values.push(online ? 1 : 0); }
  if (daily_limit !== undefined) {
    const l = toMoney(daily_limit);
    if (!(l >= 0)) return fail(res, 'Invalid limit');
    updates.push('daily_limit = ?'); values.push(l);
  }
  if (updates.length === 0) return fail(res, 'Nothing to update');
  values.push(req.params.id, req.userId);
  db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  ok(res, { updated: true });
});

// ============================================================
// TRANSACTIONS
// ============================================================
app.get('/transactions', auth, (req, res) => {
  ok(res, db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200'
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
  if (from) { sql += " AND created_at >= replace(substr(?, 1, 19), 'T', ' ')"; params.push(from); }
  if (to) { sql += " AND created_at <= replace(substr(?, 1, 19), 'T', ' ')"; params.push(to); }
  if (min_amount) { sql += ' AND amount >= ?'; params.push(parseFloat(min_amount)); }
  if (max_amount) { sql += ' AND amount <= ?'; params.push(parseFloat(max_amount)); }
  if (is_expense !== undefined) {
    sql += ' AND is_expense = ?';
    params.push(is_expense === 'true' ? 1 : 0);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT 200';
  ok(res, db.prepare(sql).all(...params));
});

app.post('/transactions', auth, handle(async (req, res) => {
  const { card_id, title, category, icon_code, pin } = req.body;
  const amount = toMoney(req.body.amount);
  const is_expense = req.body.is_expense === true || req.body.is_expense === 1;

  if (!(amount > 0) || amount > MAX_TX) throw new ApiError('Invalid amount', 400, 'BAD_AMOUNT');
  if (!title || !category) throw new ApiError('Invalid input');
  // ប្រាក់ចូលត្រូវកើតពីការផ្ទេរពិតប្រាកដប៉ុណ្ណោះ (បើមិនដូច្នេះអ្នកណាក៏បង្កើតលុយបាន)
  if (!is_expense && !ALLOW_DEMO_INCOME)
    throw new ApiError('Income can only be created through transfers', 403, 'INCOME_NOT_ALLOWED');

  await checkPin(req.userId, pin);

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(card_id, req.userId);
  if (!card) throw new ApiError('Card not found', 404, 'NOT_FOUND');
  if (card.frozen) throw new ApiError('Card is frozen', 400, 'CARD_FROZEN');
  if (is_expense) {
    if (card.balance < amount) throw new ApiError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
    if (spentToday(card.id) + amount > card.daily_limit)
      throw new ApiError('Exceeds daily limit', 400, 'DAILY_LIMIT');
  }

  const run = db.transaction(() => {
    const delta = is_expense ? -amount : amount;
    const upd = db.prepare(`UPDATE cards SET balance = ROUND(balance + ?, 2)
      WHERE id = ? AND balance + ? >= 0`).run(delta, card.id, delta);
    if (upd.changes !== 1) throw new ApiError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');

    const info = db.prepare(`INSERT INTO transactions
      (user_id, card_id, title, category, amount, is_expense, icon_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.userId, card.id, String(title).slice(0, 100), String(category).slice(0, 50),
        amount, is_expense ? 1 : 0, Number.isInteger(icon_code) ? icon_code : 0);

    db.prepare(`INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, ?)`)
      .run(req.userId,
        is_expense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
        `${title}  ${is_expense ? '-' : '+'}$${amount.toFixed(2)}`,
        Number.isInteger(icon_code) ? icon_code : 0);
    return info.lastInsertRowid;
  });

  const id = run();
  unlockAchievement(req.userId, 'first_tx');
  const cashback = is_expense ? computeCashback(req.userId, category, amount, id) : 0;

  sendPushNotification(
    req.userId,
    is_expense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
    `${title}  ${is_expense ? '-' : '+'}$${amount.toFixed(2)}`,
    { type: 'transaction' }
  );

  ok(res, {
    id, cashback,
    new_balance: db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id).balance,
  });
}));

// ============================================================
// TRANSFERS (ថ្មី) — ការផ្ទេរលុយពីមនុស្សម្នាក់ទៅម្នាក់
// ============================================================

// 1) ស្វែងរកអ្នកទទួល: ទូរស័ព្ទ ឬ អ៊ីមែល (ត្រូវគ្នាពេញលេញប៉ុណ្ណោះ)
app.get('/recipients/lookup', auth, handle(async (req, res) => {
  rateLimit(`lookup:${req.userId}`, 20, 60 * 1000);
  const q = String(req.query.q || '').trim();
  if (q.length < 5) throw new ApiError('សូមបញ្ចូលលេខទូរស័ព្ទ ឬអ៊ីមែលឲ្យពេញលេញ', 400, 'BAD_QUERY');

  let user;
  if (q.includes('@')) {
    user = db.prepare('SELECT id, name, email, phone FROM users WHERE lower(email) = lower(?) AND id <> ?')
      .get(q, req.userId);
  } else {
    const digits = q.replace(/[\s\-()+]/g, '');
    if (!/^\d{6,15}$/.test(digits)) throw new ApiError('លេខទូរស័ព្ទមិនត្រឹមត្រូវ', 400, 'BAD_QUERY');
    user = db.prepare(`
      SELECT id, name, email, phone FROM users
      WHERE phone <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+','') = ?
        AND id <> ? LIMIT 1`).get(digits, req.userId);
  }
  if (!user) throw new ApiError('រកមិនឃើញអ្នកទទួល', 404, 'NOT_FOUND');

  ok(res, { recipient_id: String(user.id), name: user.name, masked_account: maskContact(user) });
}));

// 1b) បញ្ជីអ្នកទទួលដែលបានចុះឈ្មោះ (ឈ្មោះ + account បិទបាំងតែប៉ុណ្ណោះ)
app.get('/recipients', auth, handle(async (req, res) => {
  rateLimit(`recipients:${req.userId}`, 30, 60 * 1000);
  const q = String(req.query.q || '').trim().slice(0, 50).replace(/[%_]/g, '');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone,
      (SELECT MAX(t.created_at) FROM transactions t
         WHERE t.user_id = ? AND t.counterparty_id = u.id) AS last_at
    FROM users u
    WHERE u.id <> ?
      AND (? = '' OR lower(u.name) LIKE ?)
    ORDER BY (last_at IS NULL), last_at DESC, u.name COLLATE NOCASE
    LIMIT ?`).all(req.userId, req.userId, q, `%${q.toLowerCase()}%`, limit);
  ok(res, rows.map((r) => ({
    recipient_id: String(r.id),
    name: r.name,
    masked_account: maskContact(r),
    recent: !!r.last_at,
  })));
}));

// 2) QR: អ្នកទទួលបង្កើត token អាយុ ៥នាទី
app.post('/qr/create', auth, handle(async (req, res) => {
  let amt = null;
  if (req.body.amount !== undefined && req.body.amount !== null) {
    amt = toMoney(req.body.amount);
    if (!(amt > 0) || amt > MAX_TX) throw new ApiError('Invalid amount', 400, 'BAD_AMOUNT');
  }
  const qr_token = jwt.sign({ typ: 'qr', uid: req.userId, amt }, QR_SECRET, { expiresIn: '5m' });
  ok(res, { qr_token, expires_in: 300 });
}));

// 3) អ្នកផ្ញើស្កេន QR → Server បកស្រាយអ្នកទទួលពិតប្រាកដ
app.post('/qr/resolve', auth, handle(async (req, res) => {
  rateLimit(`qr:${req.userId}`, 30, 60 * 1000);
  let p;
  try {
    p = jwt.verify(String(req.body.qr_token || ''), QR_SECRET);
  } catch {
    throw new ApiError('QR ផុតកំណត់ ឬមិនត្រឹមត្រូវ', 400, 'BAD_QR');
  }
  if (p.typ !== 'qr') throw new ApiError('QR មិនត្រឹមត្រូវ', 400, 'BAD_QR');
  if (p.uid === req.userId) throw new ApiError('មិនអាចផ្ទេរទៅខ្លួនឯង', 400, 'SELF_TRANSFER');

  const user = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(p.uid);
  if (!user) throw new ApiError('QR មិនត្រឹមត្រូវ', 400, 'BAD_QR');
  ok(res, {
    recipient_id: String(user.id),
    name: user.name,
    masked_account: maskContact(user),
    amount: p.amt, // ប្រើសម្រាប់បំពេញជាមុនប៉ុណ្ណោះ
  });
}));

// 4) ផ្ទេរលុយ — Server ជាអ្នកសម្រេចទាំងអស់
const executeTransfer = db.transaction((p) => {
  // ពិនិត្យ idempotency ម្ដងទៀតក្នុង transaction (ការពារ request ស្ទួនដំណាលគ្នា)
  const prior = db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(p.idem, p.senderId);
  if (prior) {
    if (prior.req_hash !== p.reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return { replay: true, response: JSON.parse(prior.response) };
  }

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(p.cardId, p.senderId);
  if (!card) throw new ApiError('Card not found', 404, 'CARD_NOT_FOUND');
  if (card.frozen) throw new ApiError('កាតត្រូវបានបង្កក', 400, 'CARD_FROZEN');

  const sender = db.prepare('SELECT id, name FROM users WHERE id = ?').get(p.senderId);
  const recipient = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(p.recipientId);
  if (!recipient) throw new ApiError('រកមិនឃើញអ្នកទទួល', 404, 'NOT_FOUND');

  const recipientCard = db.prepare(
    'SELECT id FROM cards WHERE user_id = ? AND frozen = 0 ORDER BY id LIMIT 1'
  ).get(recipient.id);
  if (!recipientCard) throw new ApiError('អ្នកទទួលមិនអាចទទួលប្រាក់បានពេលនេះ', 400, 'RECIPIENT_UNAVAILABLE');

  if (card.balance < p.amount) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');
  if (p.amount > card.daily_limit || spentToday(card.id) + p.amount > card.daily_limit)
    throw new ApiError('លើសកម្រិតប្រាក់ប្រចាំថ្ងៃ', 400, 'DAILY_LIMIT');

  // កាត់ (មាន guard កុំឲ្យអវិជ្ជមាន) រួចបូក
  const dec = db.prepare(`UPDATE cards SET balance = ROUND(balance - ?, 2)
    WHERE id = ? AND balance >= ?`).run(p.amount, card.id, p.amount);
  if (dec.changes !== 1) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');
  db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(p.amount, recipientCard.id);

  const ref = crypto.randomUUID();
  const insTx = db.prepare(`INSERT INTO transactions
    (user_id, card_id, title, category, amount, is_expense, icon_code, counterparty_id, transfer_ref)
    VALUES (?, ?, ?, 'ផ្ទេរប្រាក់', ?, ?, 18, ?, ?)`);
  const noteSuffix = p.note ? ` · ${p.note}` : '';
  const outId = insTx.run(sender.id, card.id, `ផ្ទេរទៅ ${recipient.name}${noteSuffix}`.slice(0, 100),
    p.amount, 1, recipient.id, ref).lastInsertRowid;
  insTx.run(recipient.id, recipientCard.id, `ទទួលពី ${sender.name}${noteSuffix}`.slice(0, 100),
    p.amount, 0, sender.id, ref);

  const insNotif = db.prepare('INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, 18)');
  insNotif.run(sender.id, 'ផ្ទេរប្រាក់ជោគជ័យ', `ផ្ទេរ $${p.amount.toFixed(2)} ទៅ ${recipient.name}`);
  const recvNotifId = insNotif.run(recipient.id, 'បានទទួលប្រាក់',
    `អ្នកបានទទួល $${p.amount.toFixed(2)} ពី ${sender.name}`).lastInsertRowid;

  const response = {
    id: outId,
    transfer_ref: ref,
    new_balance: db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id).balance,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(outId),
    recipient: { name: recipient.name, masked_account: maskContact(recipient) },
  };
  db.prepare('INSERT INTO idempotency_keys (key, user_id, req_hash, response) VALUES (?, ?, ?, ?)')
    .run(p.idem, p.senderId, p.reqHash, JSON.stringify(response));

  return { replay: false, response, recipientId: recipient.id, recvNotifId };
});

app.post('/transfers', auth, handle(async (req, res) => {
  rateLimit(`transfer:${req.userId}`, 10, 60 * 1000);

  const idem = req.get('Idempotency-Key');
  if (!idem || idem.length < 8 || idem.length > 100)
    throw new ApiError('Missing Idempotency-Key', 400, 'BAD_REQUEST');

  const recipientId = parseInt(req.body.recipient_id, 10);
  const cardId = parseInt(req.body.card_id, 10);
  const amount = toMoney(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 60);

  if (!Number.isInteger(recipientId) || !Number.isInteger(cardId))
    throw new ApiError('Invalid input', 400, 'BAD_REQUEST');
  if (!(amount >= 0.01) || amount > MAX_TX)
    throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ', 400, 'BAD_AMOUNT');
  if (recipientId === req.userId)
    throw new ApiError('មិនអាចផ្ទេរទៅខ្លួនឯង', 400, 'SELF_TRANSFER');

  const reqHash = crypto.createHash('sha256')
    .update(`${recipientId}|${cardId}|${amount}|${note}`).digest('hex');

  // ស្ទួន → ត្រឡប់លទ្ធផលដដែល (មិនកាត់លុយម្ដងទៀត)
  const prior = db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(idem, req.userId);
  if (prior) {
    if (prior.req_hash !== reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return ok(res, JSON.parse(prior.response));
  }

  await checkPin(req.userId, req.body.pin);

  const result = executeTransfer({
    idem, reqHash, senderId: req.userId, recipientId, cardId, amount, note,
  });
  ok(res, result.response);

  if (!result.replay) {
    unlockAchievement(req.userId, 'first_tx');
    // FCM: មិនបង្ហាញចំនួនលុយលើ Lock Screen — App ទាញព័ត៌មានលម្អិតពី API
    sendPushNotification(result.recipientId, 'Aura Bank', 'អ្នកមានការជូនដំណឹងថ្មី', {
      type: 'transfer_received',
      id: result.recvNotifId,
    });
  }
}));

// 5) បញ្ជីធនាគារ/MFI ដែលគាំទ្រ (App ប្រើដើម្បីបង្ហាញ fee និងកំណត់ចំនួន)
app.get('/banks', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM banks WHERE active = 1 ORDER BY name').all());
});

// 6) ផ្ទេរចេញក្រៅ (ធនាគារ/MFIs/វ៉លឡេត/ក្រៅប្រទេស)
//    គោលការណ៍: លុយចេញពីកាតអ្នកផ្ញើតែម្ខាង — មិនបង្កើតចំណូលក្លែងក្លាយនៅកន្លែងណា។
const executeExternalTransfer = db.transaction((p) => {
  const prior = db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(p.idem, p.senderId);
  if (prior) {
    if (prior.req_hash !== p.reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return { replay: true, response: JSON.parse(prior.response) };
  }

  const bankRail = db.prepare('SELECT * FROM banks WHERE code = ? AND active = 1').get(p.bankCode);
  if (!bankRail) throw new ApiError('Rails មិនត្រូវបានគាំទ្រ', 400, 'BANK_NOT_SUPPORTED');

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(p.cardId, p.senderId);
  if (!card) throw new ApiError('Card not found', 404, 'CARD_NOT_FOUND');
  if (card.frozen) throw new ApiError('កាតត្រូវបានបង្កក', 400, 'CARD_FROZEN');

  if (!(p.amount >= bankRail.min_amount) || p.amount > bankRail.max_amount)
    throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវសម្រាប់ rails នេះ', 400, 'BAD_AMOUNT');
  if (p.amount > MAX_TX) throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ', 400, 'BAD_AMOUNT');

  const fee = Math.min(Math.round(p.amount * bankRail.fee_rate * 100) / 100, bankRail.fee_max);
  const total = Math.round((p.amount + fee) * 100) / 100;
  if (total > card.daily_limit || spentToday(card.id) + total > card.daily_limit)
    throw new ApiError('លើសកម្រិតប្រាក់ប្រចាំថ្ងៃ', 400, 'DAILY_LIMIT');

  const dec = db.prepare(`UPDATE cards SET balance = ROUND(balance - ?, 2)
    WHERE id = ? AND balance >= ?`).run(total, card.id, total);
  if (dec.changes !== 1) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');

  const ref = crypto.randomUUID();
  const label = `${p.recipientName} (${bankRail.name})`;
  const insTx = db.prepare(`INSERT INTO transactions
    (user_id, card_id, title, category, amount, is_expense, icon_code, transfer_ref)
    VALUES (?, ?, ?, 'ផ្ទេរប្រាក់', ?, 1, 18, ?)`);
  const noteSuffix = p.note ? ` · ${p.note}` : '';
  // amount កត់ត្រាតែចំនួនផ្ទេរ ដូច P2P / spend ភាគីទទួល
  const outId = insTx.run(p.senderId, card.id,
    `ផ្ទេរទៅ ${label}${noteSuffix}`.slice(0, 100), p.amount, ref).lastInsertRowid;

  const insExt = db.prepare(`INSERT INTO external_transfers
    (user_id, card_id, bank_code, recipient_name, recipient_account, currency,
     amount, fee, transfer_ref, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?)`);
  const extId = insExt.run(p.senderId, card.id, bankRail.code, p.recipientName,
    p.recipientAccount, bankRail.currency, p.amount, fee, ref, p.note || null).lastInsertRowid;

  const insNotif = db.prepare('INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, 18)');
  const notifId = insNotif.run(p.senderId, 'ផ្ទេរជោគជ័យ',
    `ផ្ទេរ $${p.amount.toFixed(2)} ទៅ ${label}`).lastInsertRowid;

  const response = {
    id: outId,
    external_transfer_id: extId,
    transfer_ref: ref,
    bank: { code: bankRail.code, name: bankRail.name },
    fee,
    total_debit: total,
    new_balance: db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id).balance,
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(outId),
    recipient: { name: p.recipientName, account: p.recipientAccount },
  };
  db.prepare('INSERT INTO idempotency_keys (key, user_id, req_hash, response) VALUES (?, ?, ?, ?)')
    .run(p.idem, p.senderId, p.reqHash, JSON.stringify(response));

  return { replay: false, response, notifId };
});

app.post('/transfers/external', auth, handle(async (req, res) => {
  rateLimit(`transfer:ext:${req.userId}`, 10, 60 * 1000);

  const idem = req.get('Idempotency-Key');
  if (!idem || idem.length < 8 || idem.length > 100)
    throw new ApiError('Missing Idempotency-Key', 400, 'BAD_REQUEST');

  const bankCode = String(req.body.bank_code || '').trim().toUpperCase();
  const recipientName = String(req.body.recipient_name || '').trim().slice(0, 60);
  const digits = String(req.body.recipient_account || '').replace(/[\s\-()+]/g, '');
  const cardId = parseInt(req.body.card_id, 10);
  const amount = toMoney(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 60);

  if (!/^[A-Z0-9_-]{2,12}$/.test(bankCode))
    throw new ApiError('Invalid bank_code', 400, 'BAD_REQUEST');
  if (recipientName.length < 2)
    throw new ApiError('សូមបញ្ចូលឈ្មោះអ្នកទទួល', 400, 'BAD_REQUEST');
  if (!/^\d{6,20}$/.test(digits))
    throw new ApiError('លេខគណនី ឬលេខទូរស័ព្ទមិនត្រឹមត្រូវ', 400, 'BAD_ACCOUNT');
  if (!Number.isInteger(cardId)) throw new ApiError('Invalid input', 400, 'BAD_REQUEST');
  if (!(amount >= 0.01) || amount > MAX_TX)
    throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ', 400, 'BAD_AMOUNT');

  const reqHash = crypto.createHash('sha256')
    .update(`${bankCode}|${digits}|${cardId}|${amount}|${recipientName}|${note}`).digest('hex');

  const prior = db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(idem, req.userId);
  if (prior) {
    if (prior.req_hash !== reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return ok(res, JSON.parse(prior.response));
  }

  // PIN ផ្ទៀងផ្ទាត់នៅ Server ជានិច្ច (មិនជឿ Client)
  await checkPin(req.userId, req.body.pin);

  const result = executeExternalTransfer({
    idem, reqHash, senderId: req.userId, bankCode,
    recipientName, recipientAccount: digits, cardId, amount, note,
  });
  ok(res, result.response);

  if (!result.replay) {
    unlockAchievement(req.userId, 'first_tx');
    // FCM ទៅឧបករណ៍របស់អ្នកផ្ញើ ដើម្បីឲ្យ list ព័ត៌មានលម្អិតក្នុង App ទាន់ពេល
    sendPushNotification(req.userId, 'Aura Bank', 'អ្នកមានការជូនដំណឹងថ្មី', {
      type: 'transfer_sent',
      id: result.notifId,
    });
  }
}));

// 7) ប្រវត្តិការផ្ទេរចេញក្រៅរបស់អ្នកប្រើ
app.get('/transfers/external', auth, (req, res) => {
  ok(res, db.prepare(`SELECT e.*, b.name AS bank_name FROM external_transfers e
    JOIN banks b ON b.code = e.bank_code
    WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(req.userId));
});

// ============================================================
// GOALS
// ============================================================
app.get('/goals', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM goals WHERE user_id = ?').all(req.userId));
});

app.post('/goals', auth, (req, res) => {
  const { name, icon_code, color } = req.body;
  const target = toMoney(req.body.target);
  if (!name || !(target > 0)) return fail(res, 'Invalid');
  const info = db.prepare(
    'INSERT INTO goals (user_id, name, target, icon_code, color) VALUES (?, ?, ?, ?, ?)'
  ).run(req.userId, name, target, icon_code || 19, color || 0xFF3D5AFE);
  ok(res, { id: info.lastInsertRowid });
});

app.post('/goals/:id/deposit', auth, (req, res) => {
  const amount = toMoney(req.body.amount);
  if (!(amount > 0)) return fail(res, 'Invalid amount');
  const g = db.prepare('SELECT id FROM goals WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!g) return fail(res, 'Not found', 404, 'NOT_FOUND');
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
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50'
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
  const principal = toMoney(req.body.principal);
  const months = parseInt(req.body.months, 10);
  const annual_rate = Number(req.body.annual_rate);
  if (!(principal > 0) || principal > MAX_TX || !(months >= 1) || months > 120 ||
      !Number.isFinite(annual_rate) || annual_rate < 0 || annual_rate > 100)
    return fail(res, 'Invalid');

  const exists = db.prepare('SELECT id FROM loans WHERE user_id = ? AND active = 1').get(req.userId);
  if (exists) return fail(res, 'You already have an active loan');

  const run = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO loans (user_id, principal, months, annual_rate) VALUES (?, ?, ?, ?)'
    ).run(req.userId, principal, months, annual_rate);
    const firstCard = db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(req.userId);
    if (firstCard) {
      db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(principal, firstCard.id);
    }
    return info.lastInsertRowid;
  });
  const id = run();
  unlockAchievement(req.userId, 'first_loan');
  ok(res, { id });
});

app.post('/loan/pay', auth, (req, res) => {
  const loan = db.prepare(
    'SELECT * FROM loans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1'
  ).get(req.userId);
  if (!loan) return fail(res, 'No active loan');

  const r = loan.annual_rate / 12 / 100;
  const monthly = Math.round((r === 0 ? loan.principal / loan.months
    : loan.principal * r / (1 - Math.pow(1 + r, -loan.months))) * 100) / 100;

  const card = db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(req.userId);
  if (!card || card.balance < monthly) return fail(res, 'Insufficient balance', 400, 'INSUFFICIENT_FUNDS');

  const newPaid = loan.paid + 1;
  const active = newPaid >= loan.months ? 0 : 1;
  db.transaction(() => {
    db.prepare('UPDATE cards SET balance = ROUND(balance - ?, 2) WHERE id = ?').run(monthly, card.id);
    db.prepare('UPDATE loans SET paid = ?, active = ? WHERE id = ?').run(newPaid, active, loan.id);
  })();

  sendPushNotification(req.userId, 'បង់រំលោះកម្ចី', `បង់បាន $${monthly.toFixed(2)}`, { type: 'loan_paid' });
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
  const spentRows = db.prepare(`
    SELECT category, SUM(amount) AS spent FROM transactions
    WHERE user_id = ? AND is_expense = 1
      AND date(created_at, '${TZ}') >= date('now', '${TZ}', 'start of month')
    GROUP BY category
  `).all(req.userId);
  const spentMap = {};
  for (const r of spentRows) spentMap[r.category] = r.spent;
  ok(res, rows.map((b) => ({ ...b, spent: spentMap[b.category] || 0 })));
});

app.post('/budgets', auth, (req, res) => {
  const { category } = req.body;
  const amount = toMoney(req.body.amount);
  if (!category || !(amount > 0)) return fail(res, 'Invalid');
  try {
    db.prepare('INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)')
      .run(req.userId, category, amount);
    const count = db.prepare('SELECT COUNT(*) AS c FROM budgets WHERE user_id = ?').get(req.userId).c;
    unlockAchievement(req.userId, 'budget_set');
    if (count >= 5) unlockAchievement(req.userId, 'budget_master');
    ok(res, { created: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return fail(res, 'Budget already exists');
    fail(res, e.message, 500);
  }
});

app.patch('/budgets/:id', auth, (req, res) => {
  const amount = toMoney(req.body.amount);
  if (!(amount > 0)) return fail(res, 'Invalid');
  db.prepare('UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?')
    .run(amount, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/budgets/:id', auth, (req, res) => {
  db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
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
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0]; // ម៉ោងកម្ពុជា
  const s = db.prepare('SELECT * FROM streaks WHERE user_id = ?').get(req.userId);
  if (!s) {
    db.prepare('INSERT INTO streaks (user_id, current_days, total_days, last_check_in) VALUES (?, 1, 1, ?)')
      .run(req.userId, today);
    return ok(res, { current_days: 1, total_days: 1, is_new: true });
  }
  if (s.last_check_in === today) return ok(res, { ...s, is_new: false });
  const yesterday = new Date(Date.now() + 7 * 3600 * 1000 - 86400000).toISOString().split('T')[0];
  const newCurrent = s.last_check_in === yesterday ? s.current_days + 1 : 1;
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
  ok(res, ACHIEVEMENTS_DEF.map((a) => ({
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
  const { title, due_date, icon_code } = req.body;
  const amount = toMoney(req.body.amount);
  if (!title || !(amount > 0) || !due_date) return fail(res, 'Invalid');
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
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// RECURRING
// ============================================================
app.get('/recurring', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM recurring WHERE user_id = ? ORDER BY next_date ASC').all(req.userId));
});

app.post('/recurring', auth, (req, res) => {
  const { title, category, card_id, next_date, frequency, icon_code } = req.body;
  const amount = toMoney(req.body.amount);
  if (!title || !(amount > 0) || !next_date || !card_id) return fail(res, 'Invalid');
  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(card_id, req.userId);
  if (!card) return fail(res, 'Card not found', 404, 'NOT_FOUND');
  if (!['monthly', 'weekly', 'yearly'].includes(frequency || 'monthly')) return fail(res, 'Invalid frequency');
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
  db.prepare('DELETE FROM recurring WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

app.post('/recurring/process-due', auth, (req, res) => {
  const today = new Date().toISOString();
  const due = db.prepare(
    'SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND next_date <= ?'
  ).all(req.userId, today);
  let processed = 0;
  for (const r of due) {
    const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(r.card_id, req.userId);
    if (!card || card.balance < r.amount || card.frozen) continue;
    const next = new Date();
    if (r.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (r.frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (r.frequency === 'yearly') next.setFullYear(next.getFullYear() + 1);
    db.transaction(() => {
      db.prepare('UPDATE cards SET balance = ROUND(balance - ?, 2) WHERE id = ?').run(r.amount, r.card_id);
      db.prepare(`INSERT INTO transactions
        (user_id, card_id, title, category, amount, is_expense, icon_code)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(req.userId, r.card_id, r.title, r.category, r.amount, r.icon_code);
      db.prepare('UPDATE recurring SET next_date = ? WHERE id = ?')
        .run(next.toISOString().split('T')[0], r.id);
    })();
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
  const { title, participants } = req.body;
  const total_amount = toMoney(req.body.total_amount);
  if (!title || !(total_amount > 0) || !Array.isArray(participants) || participants.length < 1)
    return fail(res, 'Invalid');
  const share = Math.round(total_amount / (participants.length + 1) * 100) / 100;
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
  const { name } = req.body;
  const limit = req.body.limit_amount === undefined ? 500 : toMoney(req.body.limit_amount);
  if (!name || !(limit > 0)) return fail(res, 'Invalid');
  const number = '4' + Array.from({ length: 15 }, () => crypto.randomInt(0, 10)).join('');
  const cvv = String(crypto.randomInt(100, 1000));
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const y = String(new Date().getFullYear() + 3).slice(-2);
  db.prepare(`INSERT INTO virtual_cards
    (user_id, name, number, cvv, expiry, limit_amount) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.userId, name, number, cvv, `${m}/${y}`, limit);
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
  db.prepare(`UPDATE virtual_cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  ok(res, { updated: true });
});

app.delete('/virtual-cards/:id', auth, (req, res) => {
  db.prepare('DELETE FROM virtual_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// REFERRAL
// ============================================================
app.get('/referral', auth, (req, res) => {
  let r = db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  if (!r) {
    const code = 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    db.prepare('INSERT INTO referrals (user_id, code) VALUES (?, ?)').run(req.userId, code);
    r = db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  }
  ok(res, r);
});

app.post('/referral/redeem', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return fail(res, 'Invalid');
  const me = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(req.userId);
  if (me && me.referred_by) return fail(res, 'អ្នកបានប្រើកូដណែនាំរួចហើយ', 400, 'ALREADY_REDEEMED');

  const referrer = db.prepare('SELECT user_id FROM referrals WHERE code = ?').get(String(code).toUpperCase());
  if (!referrer) return fail(res, 'Invalid code');
  if (referrer.user_id === req.userId) return fail(res, 'Cannot use own code');

  db.transaction(() => {
    const bump = db.prepare(`UPDATE cards SET balance = ROUND(balance + 5, 2)
      WHERE id = (SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1)`);
    bump.run(referrer.user_id);
    bump.run(req.userId);
    db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.user_id, req.userId);
    db.prepare('UPDATE referrals SET referred_count = referred_count + 1, earnings = earnings + 5 WHERE user_id = ?')
      .run(referrer.user_id);
    db.prepare('INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, ?)')
      .run(referrer.user_id, 'ប្រាក់រង្វាន់ Referral', 'ទទួលបាន $5.00', 18);
  })();
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
  const thisStart = `date('now', '${TZ}', 'start of month')`;
  const lastStart = `date('now', '${TZ}', 'start of month', '-1 month')`;

  const thisMonth = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE user_id = ? AND is_expense = 1 AND date(created_at, '${TZ}') >= ${thisStart}
    GROUP BY category ORDER BY total DESC
  `).all(req.userId);

  const lastMonth = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM transactions
    WHERE user_id = ? AND is_expense = 1
      AND date(created_at, '${TZ}') >= ${lastStart} AND date(created_at, '${TZ}') < ${thisStart}
    GROUP BY category
  `).all(req.userId);

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
          ? `ចំណាយខែនេះកើន ${pct}% ធៀបខែមុន (+$${diff.toFixed(2)})`
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
    const frequent = thisMonth.reduce((m, r) => (r.count > m.count ? r : m), thisMonth[0]);
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
      WHERE user_id = ? AND is_expense = 1 AND category = ?
        AND date(created_at, '${TZ}') >= ${thisStart}
    `).get(req.userId, b.category).s;
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
// FCM TOKEN REGISTRATION
// ============================================================
app.post('/fcm/register', auth, (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return fail(res, 'Invalid');
  db.transaction(() => {
    // Token មួយជាកម្មសិទ្ធិទូរស័ព្ទមួយ: លុបពីអ្នកប្រើផ្សេង ដើម្បីកុំឲ្យ
    // ការជូនដំណឹងរបស់ B ទៅលោតលើទូរស័ព្ទដែល A ធ្លាប់ Login
    db.prepare('DELETE FROM fcm_tokens WHERE token = ? OR user_id = ?').run(token, req.userId);
    db.prepare('INSERT INTO fcm_tokens (user_id, token) VALUES (?, ?)').run(req.userId, token);
  })();
  console.log(`✅ FCM Token registered for user ${req.userId}`);
  ok(res, { registered: true });
});

// ហៅពេល Logout
app.post('/fcm/unregister', auth, (req, res) => {
  db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(req.userId);
  ok(res, { unregistered: true });
});

// ============================================================
// CURRENCY
// ============================================================
app.get('/currency/rates', auth, (req, res) => {
  ok(res, { USD_KHR: 4100, KHR_USD: 1 / 4100 });
});

// ============================================================
// ERROR HANDLERS & START
// ============================================================
app.use((req, res) => fail(res, 'Not found', 404, 'NOT_FOUND'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 'Invalid JSON', 400, 'BAD_JSON');
  console.error('❌ Unhandled:', err);
  fail(res, 'Server error', 500, 'SERVER_ERROR');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend on http://localhost:${PORT}`));