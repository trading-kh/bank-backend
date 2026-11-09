// ============================================================================
// Loan & Banking Backend — Complete Edition
// (Firebase Admin + FCM + Secure Transfers + QR + PIN lockout)
// ============================================================================
const express = require('express');
const http = require('http');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const createLoanAppRouter = require('./loan-routes');
const { initLoanSchema, syncArrears, runAutoDebit } = require('./loan-engine');
const { setupWebSocket, sendDeviceCommand, isDeviceOnline, deviceOnlineCount } = require('./device-control');

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
// Avatar ជា base64 data URL (រហូត ~200 KB) → parse មុន global 10 KB limit
app.use('/me/avatar', express.json({ limit: '300kb' }));
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

// ---------- HEALTH ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, commit: String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7) });
});

// ---------- BANK LOGOS (សាធារណៈ — FCM large icon) ----------
app.use('/banks', express.static(path.join(__dirname, 'public', 'banks'), {
  maxAge: '7d',
  immutable: true,
}));

// ---------- CONFIG ----------
// ទិន្នន័យរក្សាទុកក្នុង Postgres (DATABASE_URL) → មិនបាត់ពេល redeploy
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// URL សាធារណៈ — FCM ទាញយក logo ធនាគារពីទីនេះ (ត្រូវជា HTTPS សាធារណៈ)
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL ||
  'https://bank-backend-f6ay.onrender.com').replace(/\/+$/, '');
const PUSH_BANK_LOGOS = new Set([
  'ABA', 'ACLEDA', 'CANADIA', 'WING', 'JUNTUOR', 'CHIPMONG', 'SATHAPANA',
  'VATTANAC', 'CPB', 'PPCBANK', 'HATTHA', 'TRUEMONEY', 'LYF', 'MAYBANK', 'BAKONG',
]);
if (IS_PROD && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
const SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
const QR_SECRET = process.env.QR_SECRET || SECRET + ':qr';
const SALT = 10;

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
// SCHEMA & MIGRATION (Postgres)
// ============================================================
async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      auth_provider TEXT DEFAULT 'email',
      pin_attempts INTEGER DEFAULT 0,
      locked_until TIMESTAMPTZ,
      referred_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_thumb TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS data_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'operations';
    ALTER TABLE users DROP COLUMN IF EXISTS bank_name;
    ALTER TABLE users DROP COLUMN IF EXISTS bank_account;
    UPDATE users SET role = 'management' WHERE is_admin = 1 AND (role IS NULL OR role = 'operations');

    CREATE TABLE IF NOT EXISTS cards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      number TEXT NOT NULL,
      expiry TEXT NOT NULL,
      cvv TEXT NOT NULL,
      balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0,
      online INTEGER NOT NULL DEFAULT 1,
      daily_limit DOUBLE PRECISION NOT NULL DEFAULT 2000,
      color1 BIGINT NOT NULL,
      color2 BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE cards ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      is_expense INTEGER NOT NULL,
      icon_code INTEGER NOT NULL,
      counterparty_id INTEGER,
      transfer_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target DOUBLE PRECISION NOT NULL,
      saved DOUBLE PRECISION NOT NULL DEFAULT 0,
      icon_code INTEGER NOT NULL,
      color BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      icon_code INTEGER NOT NULL,
      "read" INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS bank_code TEXT;

    CREATE TABLE IF NOT EXISTS qr_otp_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bank_code TEXT NOT NULL,
      account TEXT NOT NULL,
      name TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      card_id INTEGER NOT NULL,
      note TEXT,
      raw_qr TEXT,
      otp_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS loans (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      principal DOUBLE PRECISION NOT NULL,
      months INTEGER NOT NULL,
      annual_rate DOUBLE PRECISION NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE loans ADD COLUMN IF NOT EXISTS province TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS district TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS commune TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS village TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS birth_place TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'submitted';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'online';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS co_name TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS co_phone TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_method TEXT DEFAULT 'annuity';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS fee_percent DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS fee_amount DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_payment DOUBLE PRECISION;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_interest DOUBLE PRECISION;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_payable DOUBLE PRECISION;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS outstanding DOUBLE PRECISION;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS purpose TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_income DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_expense DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS bank_name TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS bank_account TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS account_verified INTEGER DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit INTEGER DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

    CREATE TABLE IF NOT EXISTS loan_schedules (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      installment_no INTEGER NOT NULL,
      due_date DATE NOT NULL,
      principal_due DOUBLE PRECISION NOT NULL,
      interest_due DOUBLE PRECISION NOT NULL,
      total_due DOUBLE PRECISION NOT NULL,
      paid_amount DOUBLE PRECISION DEFAULT 0,
      status TEXT DEFAULT 'pending',
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS loan_payments (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES cards(id),
      amount DOUBLE PRECISION NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS loan_kyc (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      full_name TEXT,
      national_id TEXT,
      dob TEXT,
      gender TEXT,
      phone TEXT,
      province TEXT,
      district TEXT,
      commune TEXT,
      village TEXT,
      birth_place TEXT,
      occupation TEXT,
      business_name TEXT,
      business_type TEXT,
      business_years DOUBLE PRECISION DEFAULT 0,
      monthly_income DOUBLE PRECISION DEFAULT 0,
      monthly_expense DOUBLE PRECISION DEFAULT 0,
      existing_debt DOUBLE PRECISION DEFAULT 0,
      bank_name TEXT,
      bank_account TEXT,
      doc_type TEXT,
      doc_number TEXT,
      status TEXT DEFAULT 'draft',
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS full_name TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS national_id TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS dob TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS gender TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS province TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS district TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS commune TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS village TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS birth_place TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS occupation TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS business_name TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS business_type TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS business_years DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS monthly_income DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS monthly_expense DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS existing_debt DOUBLE PRECISION DEFAULT 0;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS bank_name TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS bank_account TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS doc_type TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS doc_number TEXT;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
    ALTER TABLE loan_kyc ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

    CREATE TABLE IF NOT EXISTS budgets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, category)
    );

    CREATE TABLE IF NOT EXISTS streaks (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      current_days INTEGER NOT NULL DEFAULT 0,
      total_days INTEGER NOT NULL DEFAULT 0,
      last_check_in TEXT
    );

    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, code)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      due_date TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      icon_code INTEGER NOT NULL DEFAULT 16,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS recurring (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      category TEXT NOT NULL,
      card_id INTEGER NOT NULL,
      next_date TEXT NOT NULL,
      frequency TEXT DEFAULT 'monthly',
      active INTEGER NOT NULL DEFAULT 1,
      icon_code INTEGER NOT NULL DEFAULT 16,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS splits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      total_amount DOUBLE PRECISION NOT NULL,
      your_share DOUBLE PRECISION NOT NULL,
      participants TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS virtual_cards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      number TEXT NOT NULL,
      cvv TEXT NOT NULL,
      expiry TEXT NOT NULL,
      limit_amount DOUBLE PRECISION NOT NULL DEFAULT 500,
      spent DOUBLE PRECISION NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      referred_count INTEGER NOT NULL DEFAULT 0,
      earnings DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS fcm_tokens (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cashback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_id INTEGER,
      category TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      rate DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      req_hash TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (key, user_id)
    );

    CREATE TABLE IF NOT EXISTS banks (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      fee_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_max DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_amount DOUBLE PRECISION NOT NULL DEFAULT 0.01,
      max_amount DOUBLE PRECISION NOT NULL DEFAULT 10000,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS external_transfers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      bank_code TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      recipient_account TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      amount DOUBLE PRECISION NOT NULL,
      fee DOUBLE PRECISION NOT NULL DEFAULT 0,
      transfer_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'settled',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id, is_expense);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_name ON users(lower(name));
    CREATE INDEX IF NOT EXISTS idx_tx_user_cp ON transactions(user_id, counterparty_id);
    CREATE INDEX IF NOT EXISTS idx_ext_user_created ON external_transfers(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS device_commands (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      command_type TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      result_data TEXT,
      result_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS device_locations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      address TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      failed_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_device_cmds_user ON device_commands(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_device_locs_user ON device_locations(user_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at DESC);
  `);

  // កម្មវិធីកម្ចីវីក្រុយ: KYC, តារាងសងប្រាក់, កំណត់ចំនាំ, ប្រមូល
  await initLoanSchema(db);

  // SQLite មាន ROUND(x, 2) សម្រាប់ REAL — Postgres មានតែ round(numeric, int)
  await db.exec(`
    CREATE OR REPLACE FUNCTION round(double precision, integer)
    RETURNS double precision AS $$
      SELECT round($1::numeric, $2)::double precision
    $$ LANGUAGE sql IMMUTABLE;
  `);

  // បញ្ជីធនាគារ/MFI ចាប់ផ្តើម (បញ្ចូលតែពេលតារាងទទេ)
  try {
    const n = (await db.prepare('SELECT COUNT(*) AS c FROM banks').get()).c;
    if (n === 0) {
      for (const b of [
        ['ABA', 'ABA Bank', 'USD', 0, 0, 0.01, 10000],
        ['ACLEDA', 'ACLEDA Bank', 'USD', 0.001, 5, 0.01, 10000],
        ['CANADIA', 'Canadia Bank', 'USD', 0.001, 5, 0.01, 10000],
        ['WING', 'Wing Bank', 'USD', 0.002, 8, 0.01, 5000],
        ['JUNTUOR', 'Jotuor Account', 'USD', 0.001, 5, 0.01, 5000],
        ['LYF', 'LYF Wallet', 'USD', 0.002, 8, 0.01, 2000],
        ['OTHER', 'Global / Other Bank', 'USD', 0.005, 15, 1, 10000],
      ]) {
        await db.prepare(`INSERT INTO banks
          (code, name, currency, fee_rate, fee_max, min_amount, max_amount)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...b);
      }
      console.log('✅ Seeded bank directory');
    }
    // ធនាគារបន្ថែម — បញ្ចូលតែលេខកូដដែលខ្វះ (DB មានស្រាប់មិនប៉ះ)
    for (const b of [
      ['CHIPMONG', 'Chip Mong Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['SATHAPANA', 'Sathapana Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['VATTANAC', 'Vattanac Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['CPB', 'Cambodia Post Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['PPCBANK', 'PPCBank', 'USD', 0.001, 5, 0.01, 10000],
      ['HATTHA', 'Hattha Bank', 'USD', 0.001, 5, 0.01, 10000],
      ['MAYBANK', 'Maybank Cambodia', 'USD', 0.001, 5, 0.01, 10000],
      ['TRUEMONEY', 'TrueMoney', 'USD', 0.002, 8, 0.01, 2000],
      ['BAKONG', 'Bakong', 'USD', 0.001, 5, 0.01, 10000],
    ]) {
      await db.prepare(`INSERT INTO banks
        (code, name, currency, fee_rate, fee_max, min_amount, max_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`).run(...b);
    }
  } catch (e) {
    console.error('❌ Bank directory seed:', e.message);
  }

  // Users ចាស់ដែលមាន pin_hash ជា placeholder
  try {
    const r = await db.prepare(
      "UPDATE users SET auth_provider = 'google' WHERE pin_hash LIKE 'GOOGLE_AUTH_%'"
    ).run();
    if (r.changes > 0) console.log(`✅ Migrated ${r.changes} Google users`);
  } catch (e) {
    console.log('ℹ️ Migration check completed');
  }
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
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
  req.userId = payload.id;

  // គណនីត្រូវបានផ្អាកដោយ admin? → ហាមមិនឲ្យប្រើបន្ត
  db.prepare('SELECT is_locked FROM users WHERE id = ?').get(req.userId)
    .then((u) => {
      if (u && u.is_locked) {
        return res.status(403).json({
          success: false, error: 'គណនីត្រូវបានផ្អាកដោយអ្នកគ្រប់គ្រង', code: 'ACCOUNT_LOCKED',
        });
      }
      next();
    })
    .catch((e) => {
      console.error('❌ lock check failed:', e.message);
      next();
    });

  // កត់ពេលសកម្ម (Live/Offline) — មួយដងក្នុង ៦០ វិនាទី ដើម្បីកុំឲ្យទាក់ទង DB ច្រើនពេក
  db.prepare(`UPDATE users SET last_seen_at = now() WHERE id = ?
    AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`)
    .run(req.userId).catch(() => {});
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
  const u = await db.prepare(`
    SELECT pin_hash, pin_attempts,
           (locked_until IS NOT NULL AND locked_until > now()) AS locked
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
      await db.prepare(`UPDATE users SET pin_attempts = 0,
        locked_until = now() + interval '${LOCK_MINUTES} minutes' WHERE id = ?`).run(userId);
      throw new ApiError(`PIN ខុសច្រើនដងពេក គណនីត្រូវចាក់សោ ${LOCK_MINUTES} នាទី`, 423, 'PIN_LOCKED');
    }
    await db.prepare('UPDATE users SET pin_attempts = ? WHERE id = ?').run(attempts, userId);
    throw new ApiError('Wrong PIN', 401, 'WRONG_PIN');
  }
  if (u.pin_attempts) {
    await db.prepare('UPDATE users SET pin_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
  }
}

const spentToday = async (cardId) => (await db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
  WHERE card_id = ? AND is_expense = 1
    AND (created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
      = (now() AT TIME ZONE 'Asia/Phnom_Penh')::date`).get(cardId)).s;

function maskContact(u) {
  const digits = String(u.phone || '').replace(/\D/g, '');
  if (digits.length >= 4) return `•••• ${digits.slice(-4)}`;
  const [local, domain] = String(u.email || '').split('@');
  return local && domain ? `${local[0]}•••@${domain}` : '••••';
}

async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const row = await db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').get(userId);
    if (!row || !row.token || getApps().length === 0) {
      console.log(`ℹ️ No FCM token for user ${userId} or Firebase not initialized`);
      return;
    }
    const strData = {};
    for (const [k, v] of Object.entries({ click_action: 'FLUTTER_NOTIFICATION_CLICK', ...data })) {
      strData[k] = String(v); // FCM data ត្រូវតែជា string
    }
    // Logo ធនាគារជា large icon ក្នុង notification ពេល app បិទ/នៅផ្ទៃខាងក្រោយ
    const bc = String(data.bank_code || '').trim().toUpperCase();
    const logoUrl = PUSH_BANK_LOGOS.has(bc)
      ? `${PUBLIC_BASE_URL}/banks/${bc.toLowerCase()}.png` : null;
    await getMessaging().send({
      token: row.token,
      notification: { title, body },
      data: strData,
      android: {
        priority: 'high',
        ...(logoUrl ? { notification: { imageUrl: logoUrl } } : {}),
      },
    });
    console.log(`✅ FCM sent to user ${userId}${bc ? ` · ${bc}` : ''}`);
  } catch (error) {
    console.error('❌ FCM sending failed:', error.message);
    if (error.code === 'messaging/registration-token-not-registered') {
      await db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(userId);
    }
  }
}

/// កត់ត្រាការជូនដំណឹងក្នុង DB + ផ្ញើ push — រាល់ប្រតិបត្តិការត្រូវហៅវា
/// bankCode: ធនាគារដែលពាក់ព័ន្ធ (App បង្ហាញ logo តាមនេះ)
async function notifyUser(userId, title, body, data = {}, iconCode = 18,
  bankCode = null) {
  let id = null;
  try {
    const info = await db.prepare(
      'INSERT INTO notifications (user_id, title, body, icon_code, bank_code) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, title, body, iconCode,
      bankCode ? String(bankCode).toUpperCase() : null);
    id = info.lastInsertRowid ?? null;
  } catch (e) {
    console.error('❌ notification insert failed:', e.message);
  }
  await sendPushNotification(userId, title, body,
    { ...data, ...(bankCode ? { bank_code: bankCode } : {}),
      ...(id ? { notification_id: id } : {}) });
  return id;
}

// គណនី Admin ប្រព័ន្ធ (ចូលដោយ email + password) — បង្កើត/ធ្វើបច្ចុប្បន្នដោយស្វ័យប្រវត្តិ
// ពី ADMIN_EMAIL + ADMIN_PASSWORD (កំណត់ជា env var នៅ Render — មិនដែលសរសេរក្នុង code)
async function ensureAdminAccount() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || !password) return;
  if (!email.includes('@')) {
    console.warn('⚠️ ADMIN_EMAIL is not a valid email — admin account skipped');
    return;
  }
  const name = String(process.env.ADMIN_NAME || 'Admin');
  const phone = String(process.env.ADMIN_PHONE || '+85500000000');
  const hash = await bcrypt.hash(password, SALT);
  const existing = await db.prepare('SELECT id, auth_provider FROM users WHERE lower(email) = lower(?)').get(email);

  if (existing) {
    await db.prepare('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?')
      .run(hash, existing.id);
    console.log(`✅ Admin account ready (existing): ${email}`);
    return;
  }
  // PIN ចៃដន្យ — គណនី admin ប្រព័ន្ធមិនអាចចូលកម្មវិធីទូរសែព្យ
  const pinHash = await bcrypt.hash(String(Math.floor(1000 + Math.random() * 9000)), SALT);
  await db.prepare(`INSERT INTO users (name, email, phone, pin_hash, password_hash, auth_provider, is_admin)
    VALUES (?, ?, ?, ?, ?, 'admin', 1)`).run(name, email, phone, pinHash, hash);
  console.log(`✅ Admin account created: ${email}`);
}

async function seedNewUser(userId) {
  const cards = [
    ['ABA Visa Platinum', '4532118800008824', '12/28', '458', 0, 0xFF0052D4, 0xFF4364F7],
    ['Mastercard Gold', '5412750000003310', '09/27', '912', 0, 0xFF0F9D8A, 0xFF38D39F],
    ['UnionPay Global', '6212260000005591', '05/29', '734', 0, 0xFF8E2DE2, 0xFF4A00E0],
  ];
  const insCard = db.prepare(`INSERT INTO cards
    (user_id, name, number, expiry, cvv, balance, color1, color2)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of cards) await insCard.run(userId, ...c);

  const insGoal = db.prepare(`INSERT INTO goals
    (user_id, name, target, saved, icon_code, color) VALUES (?, ?, ?, ?, ?, ?)`);
  await insGoal.run(userId, 'ទិញទូរស័ព្ទថ្មី', 1200, 480, 14, 0xFF3D5AFE);
  await insGoal.run(userId, 'ដំណើរកម្សាន្ត', 800, 650, 11, 0xFFFF8A3D);
  await insGoal.run(userId, 'មូលនិធិគ្រាអាសន្ន', 3000, 900, 12, 0xFF16A34A);
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

async function unlockAchievement(userId, code) {
  try {
    await db.prepare(
      'INSERT INTO achievements (user_id, code) VALUES (?, ?) ON CONFLICT DO NOTHING'
    ).run(userId, code);
  } catch (_) {}
}

const CASHBACK_RATES = { 'អាហារ': 0.02, 'ទិញទំនិញ': 0.01, 'កម្សាន្ត': 0.03 };

async function computeCashback(userId, category, amount, txId) {
  const rate = CASHBACK_RATES[category];
  if (!rate || rate <= 0) return 0;
  const cashback = Math.round(amount * rate * 100) / 100;
  if (cashback <= 0) return 0;
  const card = await db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
  if (!card) return 0;
  await db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(cashback, card.id);
  await db.prepare(`INSERT INTO cashback (user_id, transaction_id, category, amount, rate)
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

  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new ApiError('Email already registered');

  const hash = await bcrypt.hash(pin, SALT);
  const info = await db.prepare(
    'INSERT INTO users (name, email, phone, pin_hash, auth_provider) VALUES (?, ?, ?, ?, ?)'
  ).run(name, email, phone, hash, 'email');
  const userId = info.lastInsertRowid;
  await seedNewUser(userId);

  const token = jwt.sign({ id: userId }, SECRET, { expiresIn: '30d' });
  ok(res, { token, user: { id: userId, name, email, phone, avatar: null } });
}));

app.post('/auth/login', handle(async (req, res) => {
  const { email, pin } = req.body;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip;
  const userAgent = req.headers['user-agent'];
  
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    await db.prepare(
      'INSERT INTO login_logs (email, success, ip_address, user_agent, failed_reason) VALUES (?, ?, ?, ?, ?)'
    ).run(email, false, ipAddress, userAgent, 'NOT_FOUND');
    throw new ApiError('User not found', 404, 'NOT_FOUND');
  }

  if (user.is_locked) {
    await db.prepare(
      'INSERT INTO login_logs (user_id, email, success, ip_address, user_agent, failed_reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, email, false, ipAddress, userAgent, 'ACCOUNT_LOCKED');
    throw new ApiError('គណនីត្រូវបានផ្អាកដោយអ្នកគ្រប់គ្រង', 403, 'ACCOUNT_LOCKED');
  }
  if (user.auth_provider === 'google') {
    await db.prepare(
      'INSERT INTO login_logs (user_id, email, success, ip_address, user_agent, failed_reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, email, false, ipAddress, userAgent, 'USE_GOOGLE');
    throw new ApiError('This account is linked with Google. Please use Google Login.', 400, 'USE_GOOGLE');
  }
  if (user.auth_provider === 'admin') {
    await db.prepare(
      'INSERT INTO login_logs (user_id, email, success, ip_address, user_agent, failed_reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, email, false, ipAddress, userAgent, 'ADMIN_ACCOUNT');
    throw new ApiError('គណនីនេះជាគណនីគ្រប់គ្រងប្រព័ន្ធ មិនអាចចូលកម្មវិធីទូរសែព្យបានទេ', 403, 'ADMIN_ACCOUNT');
  }
  
  try {
    await checkPin(user.id, pin);
  } catch (err) {
    await db.prepare(
      'INSERT INTO login_logs (user_id, email, success, ip_address, user_agent, failed_reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(user.id, email, false, ipAddress, userAgent, 'WRONG_PIN');
    throw err;
  }

  await db.prepare('UPDATE users SET last_seen_at = now() WHERE id = ?').run(user.id);
  await db.prepare(
    'INSERT INTO login_logs (user_id, email, success, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, email, true, ipAddress, userAgent);
  
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, avatar: user.avatar || null },
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

  let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  let generatedPin = null;

  if (user && user.is_locked) {
    throw new ApiError('គណនីត្រូវបានផ្អាកដោយអ្នកគ្រប់គ្រង', 403, 'ACCOUNT_LOCKED');
  }

  if (!user) {
    generatedPin = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await bcrypt.hash(generatedPin, SALT);
    const info = await db.prepare(
      'INSERT INTO users (name, email, phone, pin_hash, auth_provider) VALUES (?, ?, ?, ?, ?)'
    ).run(name || 'Google User', email, '', hash, 'google');
    await seedNewUser(info.lastInsertRowid);
    user = { id: info.lastInsertRowid, name: name || 'Google User', email, phone: '', avatar: null };
  }
  // បើមានគណនីស្រាប់ មិនប្ដូរ auth_provider ទៀតទេ (ពីមុនធ្វើឲ្យ PIN login ខូច)

  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  ok(res, {
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, avatar: user.avatar || null },
    generatedPin,
  });
}));

app.get('/me', auth, async (req, res) => {
  const u = await db.prepare(
    'SELECT id, name, email, phone, avatar, auth_provider, data_version FROM users WHERE id = ?'
  ).get(req.userId);
  if (!u) return fail(res, 'Not found', 404, 'NOT_FOUND');
  ok(res, u);
});

// ---------- AVATAR ----------
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const AVATAR_MAX_BYTES = 200 * 1024;
const THUMB_MAX_BYTES = 24 * 1024;

// រក្សាទុករូប Profile ជា base64 ក្នុង Postgres (disk របស់ Render ជា ephemeral)
app.post('/me/avatar', auth, handle(async (req, res) => {
  const raw = req.body.avatar;
  if (raw === null || raw === '') {
    await db.prepare('UPDATE users SET avatar = NULL, avatar_thumb = NULL WHERE id = ?')
      .run(req.userId);
    return ok(res, { avatar: null });
  }
  const m = typeof raw === 'string' ? AVATAR_RE.exec(raw) : null;
  if (!m) throw new ApiError('រូបភាពមិនត្រឹមត្រូវ', 400, 'BAD_AVATAR');

  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > AVATAR_MAX_BYTES)
    throw new ApiError('រូបភាពធំពេក (អតិបរមា 200 KB)', 413, 'AVATAR_TOO_LARGE');

  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp)
    throw new ApiError('រូបភាពមិនត្រឹមត្រូវ', 400, 'BAD_AVATAR');

  // Thumbnail 96px សម្រាប់បង្ហាញក្នុងបញ្ជីអ្នកទទួល (បើមិនមាន ឬធំពេក ដាក់ null)
  const thumbRaw = req.body.thumb;
  let thumb = null;
  if (typeof thumbRaw === 'string' && thumbRaw) {
    const tm = AVATAR_RE.exec(thumbRaw);
    if (tm && Buffer.from(tm[2], 'base64').length <= THUMB_MAX_BYTES) thumb = tm[2];
  }

  await db.prepare('UPDATE users SET avatar = ?, avatar_thumb = ? WHERE id = ?')
    .run(raw, thumb, req.userId);
  ok(res, { updated: true });
}));

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
  await db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hash, req.userId);
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
  const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.userId);
  if (!user || user.email !== decoded.email || decoded.email_verified === false)
    throw new ApiError('Google account mismatch', 403, 'ACCOUNT_MISMATCH');
  if (Date.now() / 1000 - (decoded.auth_time || 0) > 300)
    throw new ApiError('សូមចូលតាម Google ម្ដងទៀត', 401, 'REAUTH_REQUIRED');

  const hash = await bcrypt.hash(new_pin, SALT);
  await db.prepare('UPDATE users SET pin_hash = ?, pin_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(hash, req.userId);
  ok(res, { changed: true });
}));

// ============================================================
// CARDS
// ============================================================
app.get('/cards', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id').all(req.userId));
});

app.patch('/cards/:id', auth, async (req, res) => {
  const { frozen, online, daily_limit } = req.body;
  const card = await db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?')
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
  await db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
  ok(res, { updated: true });
});

// ============================================================
// TRANSACTIONS
// ============================================================
app.get('/transactions', auth, async (req, res) => {
  ok(res, await db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200'
  ).all(req.userId));
});

app.get('/transactions/search', auth, async (req, res) => {
  const { q, category, from, to, min_amount, max_amount, is_expense } = req.query;
  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [req.userId];
  if (q) {
    sql += ' AND (title ILIKE ? OR category ILIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (from) { sql += ' AND created_at >= ?::timestamptz'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?::timestamptz'; params.push(to); }
  if (min_amount) { sql += ' AND amount >= ?'; params.push(parseFloat(min_amount)); }
  if (max_amount) { sql += ' AND amount <= ?'; params.push(parseFloat(max_amount)); }
  if (is_expense !== undefined) {
    sql += ' AND is_expense = ?';
    params.push(is_expense === 'true' ? 1 : 0);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT 200';
  ok(res, await db.prepare(sql).all(...params));
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

  const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(card_id, req.userId);
  if (!card) throw new ApiError('Card not found', 404, 'NOT_FOUND');
  if (card.frozen) throw new ApiError('Card is frozen', 400, 'CARD_FROZEN');
  if (is_expense) {
    if (card.balance < amount) throw new ApiError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
    if (await spentToday(card.id) + amount > card.daily_limit)
      throw new ApiError('Exceeds daily limit', 400, 'DAILY_LIMIT');
  }

  const id = await db.transaction(async () => {
    const delta = is_expense ? -amount : amount;
    const upd = await db.prepare(`UPDATE cards SET balance = ROUND(balance + ?, 2)
      WHERE id = ? AND balance + ? >= 0`).run(delta, card.id, delta);
    if (upd.changes !== 1) throw new ApiError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');

    const info = await db.prepare(`INSERT INTO transactions
      (user_id, card_id, title, category, amount, is_expense, icon_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.userId, card.id, String(title).slice(0, 100), String(category).slice(0, 50),
        amount, is_expense ? 1 : 0, Number.isInteger(icon_code) ? icon_code : 0);

    await db.prepare(`INSERT INTO notifications (user_id, title, body, icon_code, bank_code) VALUES (?, ?, ?, ?, 'AURA')`)
      .run(req.userId,
        is_expense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
        `${title}  ${is_expense ? '-' : '+'}$${amount.toFixed(2)}`,
        Number.isInteger(icon_code) ? icon_code : 0);
    return info.lastInsertRowid;
  });

  await unlockAchievement(req.userId, 'first_tx');
  const cashback = is_expense ? await computeCashback(req.userId, category, amount, id) : 0;

  sendPushNotification(
    req.userId,
    is_expense ? 'ប្រតិបត្តិការជោគជ័យ' : 'ទទួលបានប្រាក់',
    `${title}  ${is_expense ? '-' : '+'}$${amount.toFixed(2)}`,
    { type: 'transaction', bank_code: 'AURA' }
  );

  ok(res, {
    id, cashback,
    new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id)).balance,
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
    user = await db.prepare('SELECT id, name, email, phone, avatar_thumb FROM users WHERE lower(email) = lower(?) AND id <> ? AND COALESCE(auth_provider, \'\') <> \'admin\'')
      .get(q, req.userId);
  } else {
    const digits = q.replace(/[\s\-()+]/g, '');
    if (!/^\d{6,15}$/.test(digits)) throw new ApiError('លេខទូរស័ព្ទមិនត្រឹមត្រូវ', 400, 'BAD_QUERY');
    user = await db.prepare(`
      SELECT id, name, email, phone, avatar_thumb FROM users
      WHERE phone <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+','') = ?
        AND id <> ? AND COALESCE(auth_provider, '') <> 'admin' LIMIT 1`).get(digits, req.userId);
  }
  if (!user) throw new ApiError('រកមិនឃើញអ្នកទទួល', 404, 'NOT_FOUND');

  ok(res, {
    recipient_id: String(user.id),
    name: user.name,
    masked_account: maskContact(user),
    avatar_thumb: user.avatar_thumb || null,
  });
}));

// 1b) បញ្ជីអ្នកទទួលដែលបានចុះឈ្មោះ (ឈ្មោះ + account បិទបាំងតែប៉ុណ្ណោះ)
app.get('/recipients', auth, handle(async (req, res) => {
  rateLimit(`recipients:${req.userId}`, 30, 60 * 1000);
  const q = String(req.query.q || '').trim().slice(0, 50).replace(/[%_]/g, '');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const rows = await db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.avatar_thumb,
      (SELECT MAX(t.created_at) FROM transactions t
         WHERE t.user_id = ? AND t.counterparty_id = u.id) AS last_at
    FROM users u
    WHERE u.id <> ?
      AND COALESCE(u.auth_provider, '') <> 'admin'
      AND (?::text = '' OR lower(u.name) LIKE ?)
    ORDER BY last_at DESC NULLS LAST, lower(u.name)
    LIMIT ?`).all(req.userId, req.userId, q, `%${q.toLowerCase()}%`, limit);
  ok(res, rows.map((r) => ({
    recipient_id: String(r.id),
    name: r.name,
    masked_account: maskContact(r),
    recent: !!r.last_at,
    avatar_thumb: r.avatar_thumb || null,
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

  const user = await db.prepare("SELECT id, name, email, phone, avatar_thumb FROM users WHERE id = ? AND COALESCE(auth_provider, '') <> 'admin'").get(p.uid);
  if (!user) throw new ApiError('QR មិនត្រឹមត្រូវ', 400, 'BAD_QR');
  ok(res, {
    recipient_id: String(user.id),
    name: user.name,
    masked_account: maskContact(user),
    avatar_thumb: user.avatar_thumb || null,
    amount: p.amt, // ប្រើសម្រាប់បំពេញជាមុនប៉ុណ្ណោះ
  });
}));

// 4) ផ្ទេរលុយ — Server ជាអ្នកសម្រេចទាំងអស់
const executeTransfer = (p) => db.transaction(async () => {
  // ពិនិត្យ idempotency ម្ដងទៀតក្នុង transaction (ការពារ request ស្ទួនដំណាលគ្នា)
  const prior = await db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(p.idem, p.senderId);
  if (prior) {
    if (prior.req_hash !== p.reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return { replay: true, response: JSON.parse(prior.response) };
  }

  const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(p.cardId, p.senderId);
  if (!card) throw new ApiError('Card not found', 404, 'CARD_NOT_FOUND');
  if (card.frozen) throw new ApiError('កាតត្រូវបានបង្កក', 400, 'CARD_FROZEN');

  const sender = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(p.senderId);
  const recipient = await db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(p.recipientId);
  if (!recipient) throw new ApiError('រកមិនឃើញអ្នកទទួល', 404, 'NOT_FOUND');

  const recipientCard = await db.prepare(
    'SELECT id FROM cards WHERE user_id = ? AND frozen = 0 ORDER BY id LIMIT 1'
  ).get(recipient.id);
  if (!recipientCard) throw new ApiError('អ្នកទទួលមិនអាចទទួលប្រាក់បានពេលនេះ', 400, 'RECIPIENT_UNAVAILABLE');

  if (card.balance < p.amount) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');
  if (p.amount > card.daily_limit || await spentToday(card.id) + p.amount > card.daily_limit)
    throw new ApiError('លើសកម្រិតប្រាក់ប្រចាំថ្ងៃ', 400, 'DAILY_LIMIT');

  // កាត់ (មាន guard កុំឲ្យអវិជ្ជមាន) រួចបូក
  const dec = await db.prepare(`UPDATE cards SET balance = ROUND(balance - ?, 2)
    WHERE id = ? AND balance >= ?`).run(p.amount, card.id, p.amount);
  if (dec.changes !== 1) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');
  await db.prepare('UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(p.amount, recipientCard.id);

  const ref = crypto.randomUUID();
  const insTx = db.prepare(`INSERT INTO transactions
    (user_id, card_id, title, category, amount, is_expense, icon_code, counterparty_id, transfer_ref)
    VALUES (?, ?, ?, 'ផ្ទេរប្រាក់', ?, ?, 18, ?, ?)`);
  const noteSuffix = p.note ? ` · ${p.note}` : '';
  const outId = (await insTx.run(sender.id, card.id, `ផ្ទេរទៅ ${recipient.name}${noteSuffix}`.slice(0, 100),
    p.amount, 1, recipient.id, ref)).lastInsertRowid;
  await insTx.run(recipient.id, recipientCard.id, `ទទួលពី ${sender.name}${noteSuffix}`.slice(0, 100),
    p.amount, 0, sender.id, ref);

  const insNotif = db.prepare('INSERT INTO notifications (user_id, title, body, icon_code, bank_code) VALUES (?, ?, ?, 18, ?)');
  await insNotif.run(sender.id, 'ផ្ទេរប្រាក់ជោគជ័យ', `ផ្ទេរ $${p.amount.toFixed(2)} ទៅ ${recipient.name}`, 'AURA');
  const recvBody = `លោកអ្នកបានទទួលប្រាក់ចំនួន $${p.amount.toFixed(2)} ពីឈ្មោះ ${sender.name}`;
  const recvNotifId = (await insNotif.run(recipient.id, 'បានទទួលប្រាក់',
    recvBody, 'AURA')).lastInsertRowid;

  const response = {
    id: outId,
    transfer_ref: ref,
    new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id)).balance,
    transaction: await db.prepare('SELECT * FROM transactions WHERE id = ?').get(outId),
    recipient: { name: recipient.name, masked_account: maskContact(recipient) },
  };
  await db.prepare('INSERT INTO idempotency_keys (key, user_id, req_hash, response) VALUES (?, ?, ?, ?)')
    .run(p.idem, p.senderId, p.reqHash, JSON.stringify(response));

  return { replay: false, response, recipientId: recipient.id, recvNotifId, recvBody };
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
  const prior = await db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(idem, req.userId);
  if (prior) {
    if (prior.req_hash !== reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return ok(res, JSON.parse(prior.response));
  }

  await checkPin(req.userId, req.body.pin);

  const result = await executeTransfer({
    idem, reqHash, senderId: req.userId, recipientId, cardId, amount, note,
  });
  ok(res, result.response);

  if (!result.replay) {
    await unlockAchievement(req.userId, 'first_tx');
    sendPushNotification(result.recipientId, 'បានទទួលប្រាក់', result.recvBody, {
      type: 'transfer_received',
      id: result.recvNotifId,
      bank_code: 'AURA',
    });
  }
}));

// 5) បញ្ជីធនាគារ/MFI ដែលគាំទ្រ (App ប្រើដើម្បីបង្ហាញ fee និងកំណត់ចំនួន)
app.get('/banks', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM banks WHERE active = 1 ORDER BY name').all());
});

// 6) ផ្ទេរចេញក្រៅ (ធនាគារ/MFIs/វ៉លឡេត/ក្រៅប្រទេស)
//    គោលការណ៍: លុយចេញពីកាតអ្នកផ្ញើតែម្ខាង — មិនបង្កើតចំណូលក្លែងក្លាយនៅកន្លែងណា។
const executeExternalTransfer = (p) => db.transaction(async () => {
  const prior = await db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(p.idem, p.senderId);
  if (prior) {
    if (prior.req_hash !== p.reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return { replay: true, response: JSON.parse(prior.response) };
  }

  const bankRail = await db.prepare('SELECT * FROM banks WHERE code = ? AND active = 1').get(p.bankCode);
  if (!bankRail) throw new ApiError('Rails មិនត្រូវបានគាំទ្រ', 400, 'BANK_NOT_SUPPORTED');

  const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(p.cardId, p.senderId);
  if (!card) throw new ApiError('Card not found', 404, 'CARD_NOT_FOUND');
  if (card.frozen) throw new ApiError('កាតត្រូវបានបង្កក', 400, 'CARD_FROZEN');

  if (!(p.amount >= bankRail.min_amount) || p.amount > bankRail.max_amount)
    throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវសម្រាប់ rails នេះ', 400, 'BAD_AMOUNT');
  if (p.amount > MAX_TX) throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ', 400, 'BAD_AMOUNT');

  const fee = Math.min(Math.round(p.amount * bankRail.fee_rate * 100) / 100, bankRail.fee_max);
  const total = Math.round((p.amount + fee) * 100) / 100;
  if (total > card.daily_limit || await spentToday(card.id) + total > card.daily_limit)
    throw new ApiError('លើសកម្រិតប្រាក់ប្រចាំថ្ងៃ', 400, 'DAILY_LIMIT');

  const dec = await db.prepare(`UPDATE cards SET balance = ROUND(balance - ?, 2)
    WHERE id = ? AND balance >= ?`).run(total, card.id, total);
  if (dec.changes !== 1) throw new ApiError('សមតុល្យមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');

  const ref = crypto.randomUUID();
  const label = `${p.recipientName} (${bankRail.name})`;
  const insTx = db.prepare(`INSERT INTO transactions
    (user_id, card_id, title, category, amount, is_expense, icon_code, transfer_ref)
    VALUES (?, ?, ?, 'ផ្ទេរប្រាក់', ?, 1, 18, ?)`);
  const noteSuffix = p.note ? ` · ${p.note}` : '';
  // amount កត់ត្រាតែចំនួនផ្ទេរ ដូច P2P / spend ភាគីទទួល
  const outId = (await insTx.run(p.senderId, card.id,
    `ផ្ទេរទៅ ${label}${noteSuffix}`.slice(0, 100), p.amount, ref)).lastInsertRowid;

  const insExt = db.prepare(`INSERT INTO external_transfers
    (user_id, card_id, bank_code, recipient_name, recipient_account, currency,
     amount, fee, transfer_ref, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?)`);
  const extId = (await insExt.run(p.senderId, card.id, bankRail.code, p.recipientName,
    p.recipientAccount, bankRail.currency, p.amount, fee, ref, p.note || null)).lastInsertRowid;

  const insNotif = db.prepare('INSERT INTO notifications (user_id, title, body, icon_code, bank_code) VALUES (?, ?, ?, 18, ?)');
  const notifId = (await insNotif.run(p.senderId, 'ផ្ទេរជោគជ័យ',
    `ផ្ទេរ $${p.amount.toFixed(2)} ទៅ ${label}`, bankRail.code)).lastInsertRowid;

  const response = {
    id: outId,
    external_transfer_id: extId,
    transfer_ref: ref,
    bank: { code: bankRail.code, name: bankRail.name },
    fee,
    total_debit: total,
    new_balance: (await db.prepare('SELECT balance FROM cards WHERE id = ?').get(card.id)).balance,
    transaction: await db.prepare('SELECT * FROM transactions WHERE id = ?').get(outId),
    recipient: { name: p.recipientName, account: p.recipientAccount },
  };
  await db.prepare('INSERT INTO idempotency_keys (key, user_id, req_hash, response) VALUES (?, ?, ?, ?)')
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

  const prior = await db.prepare('SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?')
    .get(idem, req.userId);
  if (prior) {
    if (prior.req_hash !== reqHash)
      throw new ApiError('Idempotency-Key ត្រូវបានប្រើជាមួយសំណើផ្សេង', 422, 'IDEMPOTENCY_MISMATCH');
    return ok(res, JSON.parse(prior.response));
  }

  // PIN ផ្ទៀងផ្ទាត់នៅ Server ជានិច្ច (មិនជឿ Client)
  await checkPin(req.userId, req.body.pin);

  const result = await executeExternalTransfer({
    idem, reqHash, senderId: req.userId, bankCode,
    recipientName, recipientAccount: digits, cardId, amount, note,
  });
  ok(res, result.response);

  if (!result.replay) {
    await unlockAchievement(req.userId, 'first_tx');
    // FCM ទៅឧបករណ៍របស់អ្នកផ្ញើ ដើម្បីឲ្យ list ព័ត៌មានលម្អិតក្នុង App ទាន់ពេល
    sendPushNotification(req.userId, 'Aura Bank', 'អ្នកមានការជូនដំណឹងថ្មី', {
      type: 'transfer_sent',
      id: result.notifId,
      bank_code: bankCode,
    });
  }
}));

// 7) ប្រវត្តិការផ្ទេរចេញក្រៅរបស់អ្នកប្រើ
app.get('/transfers/external', auth, async (req, res) => {
  ok(res, await db.prepare(`SELECT e.*, b.name AS bank_name FROM external_transfers e
    JOIN banks b ON b.code = e.bank_code
    WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT 100`).all(req.userId));
});

// ============================================================
// QR ខាងក្រៅ (មិនមែន Aura Bank) — ត្រូវការ OTP មុនផ្ទេរប្រាក់
// ============================================================
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;

// EMVCo / KHQR: TLV 2 ខ្ទង់ tag + 2 ខ្ទង់ length
function parseEmvTlv(s) {
  const out = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(tag) || !Number.isInteger(len) || len < 0) break;
    if (i + 4 + len > s.length) break;
    out.push({ tag, value: s.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

const QR_BANK_SUFFIX = {
  aba: 'ABA', abaa: 'ABA', acleda: 'ACLEDA', aclb: 'ACLEDA',
  canadia: 'CANADIA', cana: 'CANADIA', wing: 'WING', wingb: 'WING',
  juntuor: 'JUNTUOR', jtrust: 'JUNTUOR', lyf: 'LYF',
  chipmong: 'CHIPMONG', cmb: 'CHIPMONG', cmpb: 'CHIPMONG',
  sathapana: 'SATHAPANA', sathapanab: 'SATHAPANA', spn: 'SATHAPANA',
  vattanac: 'VATTANAC', vattanacb: 'VATTANAC', vtb: 'VATTANAC',
  cpb: 'CPB', cpbank: 'CPB', cambodiapostbank: 'CPB',
  ppcbank: 'PPCBANK', ppcb: 'PPCBANK',
  hattha: 'HATTHA', hatthab: 'HATTHA', htb: 'HATTHA',
  maybank: 'MAYBANK', mbb: 'MAYBANK',
  truemoney: 'TRUEMONEY', tmn: 'TRUEMONEY',
  bakong: 'BAKONG', nbc: 'BAKONG',
};

// បកស្រាយ QR ខាងក្រៅ → { account, name, bankCode, amount }
function parseExternalQr(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^aurabank:\/\//i.test(text)) return { aura: true };
  if (text.length > 1024) return null;

  let account = '';
  let bankId = '';
  let name = '';
  let bankCode = '';
  let amount = null;

  if (text.startsWith('000201')) {
    const top = parseEmvTlv(text);
    const get = (t) => top.find((x) => x.tag === t)?.value || '';
    for (const t of top) {
      const n = parseInt(t.tag, 10);
      if (n >= 26 && n <= 51) {
        const sub = parseEmvTlv(t.value);
        // sub 00 = Bakong ID (`name@abaa`) → ធនាគារពិតរបស់ QR
        bankId = (sub.find((x) => x.tag === '00') || {}).value || bankId;
        const acc = (sub.find((x) => x.tag === '01') || sub.find((x) => x.tag === '02'))?.value;
        if (acc) { account = acc; break; }
      }
    }
    if (!account) account = bankId;
    name = get('59') || get('60') || '';
    const amt = parseFloat(get('54'));
    if (Number.isFinite(amt) && amt > 0) amount = Math.round(amt * 100) / 100;
  } else if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      account = String(j.account || j.acc || j.number || j.phone || '');
      name = String(j.name || j.merchant || j.merchant_name || '');
      bankCode = String(j.bank || j.bank_code || j.bankCode || '');
      const amt = Number(j.amount);
      if (Number.isFinite(amt) && amt > 0) amount = Math.round(amt * 100) / 100;
    } catch { /* មិនមែន JSON */ }
  } else if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      account = u.searchParams.get('account') || u.searchParams.get('acc')
        || u.searchParams.get('phone') || '';
      name = u.searchParams.get('name') || u.searchParams.get('merchant') || '';
      bankCode = u.searchParams.get('bank') || u.searchParams.get('bank_code') || '';
      const amt = Number(u.searchParams.get('amount'));
      if (Number.isFinite(amt) && amt > 0) amount = Math.round(amt * 100) / 100;
    } catch { /* URL ខូច */ }
  }

  if (!account) {
    const bare = text.replace(/[\s-]/g, '');
    if (/^\d{6,20}$/.test(bare)) account = bare;
  }
  if (!account) return null;
  if (account.length > 64) account = account.slice(0, 64);

  bankCode = bankCode.trim().toUpperCase();
  if (!bankCode) {
    const suffix = ((account.split('@')[1] || '') ||
      (bankId.split('@')[1] || '')).toLowerCase();
    bankCode = QR_BANK_SUFFIX[suffix] || 'OTHER';
  }
  return { account, name: name.slice(0, 60), bankCode, amount };
}

// 1) ពិនិត្យ QR ខាងក្រៅ — App ហៅនៅពេល token Aura មិនត្រូវ
app.post('/qr/external/inspect', auth, handle(async (req, res) => {
  rateLimit(`qr:ext:inspect:${req.userId}`, 20, 60 * 1000);
  const parsed = parseExternalQr(req.body.qr);
  if (parsed?.aura) throw new ApiError('QR នេះជារបស់ Aura Bank', 400, 'AURA_QR');
  ok(res, parsed
    ? {
        recognized: true,
        account: parsed.account,
        name: parsed.name,
        bank_code: parsed.bankCode,
        amount: parsed.amount,
      }
    : { recognized: false, account: '', name: '', bank_code: 'OTHER', amount: null });
}));

// 2) ចាប់ផ្ដើមផ្ទេរ QR ខាងក្រៅ → បង្កើត OTP ៦ ខ្ទង់ (អាយុ ៥ នាទី)
//    OTP ផ្ញើតាម Notification + FCM — មិនដែលត្រឡប់ទៅ Client ទេ
app.post('/qr/external/start', auth, handle(async (req, res) => {
  rateLimit(`qr:ext:start:${req.userId}`, 6, 60 * 1000);

  const bankCode = String(req.body.bank_code || '').trim().toUpperCase();
  const account = String(req.body.account || '').trim().slice(0, 64);
  const recipientName = (String(req.body.name || '').trim() || 'អ្នកទទួល').slice(0, 60);
  const cardId = parseInt(req.body.card_id, 10);
  const amount = toMoney(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 60);
  const rawQr = String(req.body.raw_qr || '').slice(0, 1024);

  if (!/^[A-Z0-9_]{2,12}$/.test(bankCode))
    throw new ApiError('សូមជ្រើសរើសធនាគារ', 400, 'BAD_BANK');
  const rail = await db.prepare('SELECT * FROM banks WHERE code = ? AND active = 1').get(bankCode);
  if (!rail) throw new ApiError('ធនាគារនេះមិនត្រូវបានគាំទ្រ', 400, 'BANK_NOT_SUPPORTED');
  if (!/^[A-Za-z0-9._@+\-]{3,64}$/.test(account))
    throw new ApiError('លេខគណនីមិនត្រឹមត្រូវ', 400, 'BAD_ACCOUNT');
  if (!Number.isInteger(cardId))
    throw new ApiError('Invalid input', 400, 'BAD_REQUEST');
  if (!(amount >= Math.max(0.01, rail.min_amount)) || amount > Math.min(MAX_TX, rail.max_amount))
    throw new ApiError('ចំនួនទឹកប្រាក់មិនត្រឹមត្រូវ', 400, 'BAD_AMOUNT');

  const card = await db.prepare('SELECT id, frozen FROM cards WHERE id = ? AND user_id = ?')
    .get(cardId, req.userId);
  if (!card) throw new ApiError('Card not found', 404, 'CARD_NOT_FOUND');
  if (card.frozen) throw new ApiError('កាតត្រូវបានបង្កក', 400, 'CARD_FROZEN');

  // OTP ចាស់ដែលមិនទាន់ប្រើ → លុបសិទ្ធិ (មានតែ OTP ចុងក្រោយមួយប៉ុណ្ណោះ)
  await db.prepare('UPDATE qr_otp_requests SET used = 1 WHERE user_id = ? AND used = 0')
    .run(req.userId);

  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otp, SALT);

  const info = await db.prepare(`INSERT INTO qr_otp_requests
    (user_id, bank_code, account, name, amount, card_id, note, raw_qr, otp_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now() + interval '${OTP_TTL_SECONDS} seconds')`)
    .run(req.userId, bankCode, account, recipientName, amount, cardId,
      note || null, rawQr || null, otpHash);

  // ពេលវេលាផុតកំណត់ជាក់លាក់ (ម៉ោងកម្ពុជា) — ជំនួសពាក្យ «អាយុ ៥ នាទី»
  const expireAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);
  const expireTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(expireAt);
  const body = `លេខកូដ OTP របស់អ្នក ${otp}\nផ្ទេរ $${amount.toFixed(2)} ទៅ ${recipientName} · ${rail.name} · ផុតកំណត់ម៉ោង ${expireTime}`;
  const notifId = (await db.prepare(
    'INSERT INTO notifications (user_id, title, body, icon_code, bank_code) VALUES (?, ?, ?, 18, ?)'
  ).run(req.userId, 'Aura Bank · OTP', body, rail.code)).lastInsertRowid;

  const user = await db.prepare('SELECT phone FROM users WHERE id = ?').get(req.userId);
  sendPushNotification(req.userId, 'Aura Bank · OTP', body,
    { type: 'otp', id: notifId, bank_code: rail.code });

  ok(res, {
    request_id: info.lastInsertRowid,
    expires_in: OTP_TTL_SECONDS,
    hint: maskContact(user || {}),
    notification_id: notifId,
  });
}));

// 3) ផ្ទៀងផ្ទាត់ OTP → ផ្ទេរប្រាក់ (បរិមាណ/គណនី/កាត ត្រូវបានចាក់សោក្នុងសំណើ OTP)
app.post('/qr/external/confirm', auth, handle(async (req, res) => {
  rateLimit(`qr:ext:confirm:${req.userId}`, 10, 60 * 1000);

  const idem = req.get('Idempotency-Key');
  if (!idem || idem.length < 8 || idem.length > 100)
    throw new ApiError('Missing Idempotency-Key', 400, 'BAD_REQUEST');

  const requestId = parseInt(req.body.request_id, 10);
  const otp = String(req.body.otp || '').trim();
  if (!Number.isInteger(requestId))
    throw new ApiError('Invalid input', 400, 'BAD_REQUEST');
  if (!/^\d{6}$/.test(otp))
    throw new ApiError('សូមបំពេញលេខកូដ OTP ៦ ខ្ទង់', 400, 'BAD_OTP');

  const r = await db.prepare('SELECT * FROM qr_otp_requests WHERE id = ? AND user_id = ?')
    .get(requestId, req.userId);
  if (!r)
    throw new ApiError('សំណើ OTP មិនត្រឹមត្រូវ សូមស្នើម្តងទៀត', 400, 'OTP_NOT_FOUND');

  if (r.used) {
    // ចុចម្តងទៀតបន្ទាប់ពីជោគជ័យ → ត្រឡប់លទ្ធផលដដែល (មិនកាត់លុយពីរដង)
    const prior = await db.prepare(
      'SELECT req_hash, response FROM idempotency_keys WHERE key = ? AND user_id = ?'
    ).get(idem, req.userId);
    if (prior) return ok(res, JSON.parse(prior.response));
    throw new ApiError('OTP នេះត្រូវបានប្រើរួចហើយ', 400, 'OTP_USED');
  }
  if (new Date(r.expires_at) < new Date())
    throw new ApiError('OTP ផុតកំណត់ សូមស្នើម្តងទៀត', 400, 'OTP_EXPIRED');
  if (r.attempts >= OTP_MAX_ATTEMPTS)
    throw new ApiError('OTP ខុសច្រើនដងពេក សូមស្នើម្តងទៀត', 429, 'OTP_LOCKED');

  let valid = false;
  try { valid = await bcrypt.compare(otp, r.otp_hash); } catch { valid = false; }
  if (!valid) {
    await db.prepare('UPDATE qr_otp_requests SET attempts = attempts + 1 WHERE id = ?')
      .run(r.id);
    const left = OTP_MAX_ATTEMPTS - (r.attempts + 1);
    throw new ApiError(
      left > 0 ? `OTP មិនត្រឹមត្រូវ (នៅសល់ ${left} ដង)` : 'OTP ខុសច្រើនដងពេក សូមស្នើម្តងទៀត',
      401, 'WRONG_OTP');
  }

  await db.prepare('UPDATE qr_otp_requests SET used = 1 WHERE id = ?').run(r.id);

  const reqHash = crypto.createHash('sha256')
    .update(`${r.bank_code}|${r.account}|${r.card_id}|${r.amount}|${r.name}|${r.note || ''}|otp:${r.id}`)
    .digest('hex');

  const result = await executeExternalTransfer({
    idem, reqHash, senderId: req.userId, bankCode: r.bank_code,
    recipientName: r.name, recipientAccount: r.account,
    cardId: r.card_id, amount: r.amount, note: r.note || '',
  });
  ok(res, result.response);

  if (!result.replay) {
    await unlockAchievement(req.userId, 'first_tx');
    sendPushNotification(req.userId, 'Aura Bank', 'អ្នកមានការជូនដំណឹងថ្មី', {
      type: 'transfer_sent',
      id: result.notifId,
      bank_code: r.bank_code,
    });
  }
}));

// ============================================================
// GOALS
// ============================================================
app.get('/goals', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM goals WHERE user_id = ?').all(req.userId));
});

app.post('/goals', auth, async (req, res) => {
  const { name, icon_code, color } = req.body;
  const target = toMoney(req.body.target);
  if (!name || !(target > 0)) return fail(res, 'Invalid');
  const info = await db.prepare(
    'INSERT INTO goals (user_id, name, target, icon_code, color) VALUES (?, ?, ?, ?, ?)'
  ).run(req.userId, name, target, icon_code || 19, color || 0xFF3D5AFE);
  ok(res, { id: info.lastInsertRowid });
});

app.post('/goals/:id/deposit', auth, async (req, res) => {
  const amount = toMoney(req.body.amount);
  if (!(amount > 0)) return fail(res, 'Invalid amount');
  const g = await db.prepare('SELECT id, name FROM goals WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!g) return fail(res, 'Not found', 404, 'NOT_FOUND');
  await db.prepare('UPDATE goals SET saved = saved + ? WHERE id = ?').run(amount, req.params.id);
  const g2 = await db.prepare('SELECT saved FROM goals WHERE id = ?').get(req.params.id);
  await notifyUser(req.userId, 'ដាក់ប្រាក់ចូលគោលដៅ',
    `បានដាក់ $${amount.toFixed(2)} ចូល "${g.name}" · សរុប $${Number(g2.saved).toFixed(2)}`,
    { type: 'goal_deposit' }, 19);
  if (g2.saved >= 100) await unlockAchievement(req.userId, 'savings_100');
  if (g2.saved >= 1000) await unlockAchievement(req.userId, 'savings_1000');
  ok(res, { updated: true });
});

// ============================================================
// NOTIFICATIONS
// ============================================================
app.get('/notifications', auth, async (req, res) => {
  ok(res, await db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50'
  ).all(req.userId));
});

app.post('/notifications/read-all', auth, async (req, res) => {
  await db.prepare('UPDATE notifications SET "read" = 1 WHERE user_id = ?').run(req.userId);
  ok(res, { read: true });
});

// ============================================================
// LOANS (កម្មវិធីកម្ចីវីក្រុយ — KYC → សាកលកម្ម → អនុមត្ត → តារាងសងប្រាក់)
// ============================================================
app.use(createLoanAppRouter({
  db, ok, ApiError, handle, auth, sendPushNotification: notifyUser, unlockAchievement,
}));

// ============================================================
// LOAN SCHEDULER — បង់ស្វត្តកម្ម + តាមដានកង់បង់យឺតពេក
// ============================================================
async function runLoanJobs() {
  try {
    await syncArrears(db);
    const out = await runAutoDebit(db, { sendPushNotification: notifyUser });
    const paid = out.results.filter((r) => r.status === 'paid');
    if (paid.length)
      console.log(`💳 បង់ស្វត្តកម្មបាន ${paid.length} វីនុបទ`);
  } catch (e) {
    console.error('❌ Loan job failed:', e.message);
  }
}
setInterval(runLoanJobs, 15 * 60 * 1000).unref();
setTimeout(runLoanJobs, 10000).unref();

// ============================================================
// ANALYTICS
// ============================================================
app.get('/analytics', auth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT category, SUM(amount) AS total FROM transactions WHERE user_id = ? AND is_expense = 1 GROUP BY category'
  ).all(req.userId);
  const income = (await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND is_expense = 0'
  ).get(req.userId)).s;
  const expense = (await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND is_expense = 1'
  ).get(req.userId)).s;
  ok(res, { income, expense, by_category: rows });
});

// ============================================================
// BUDGETS
// ============================================================
app.get('/budgets', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(req.userId);
  const spentRows = await db.prepare(`
    SELECT category, SUM(amount) AS spent FROM transactions
    WHERE user_id = ? AND is_expense = 1
      AND (created_at AT TIME ZONE 'Asia/Phnom_Penh')::date
        >= date_trunc('month', now() AT TIME ZONE 'Asia/Phnom_Penh')::date
    GROUP BY category
  `).all(req.userId);
  const spentMap = {};
  for (const r of spentRows) spentMap[r.category] = r.spent;
  ok(res, rows.map((b) => ({ ...b, spent: spentMap[b.category] || 0 })));
});

app.post('/budgets', auth, async (req, res) => {
  const { category } = req.body;
  const amount = toMoney(req.body.amount);
  if (!category || !(amount > 0)) return fail(res, 'Invalid');
  try {
    await db.prepare('INSERT INTO budgets (user_id, category, amount) VALUES (?, ?, ?)')
      .run(req.userId, category, amount);
    const count = (await db.prepare('SELECT COUNT(*) AS c FROM budgets WHERE user_id = ?').get(req.userId)).c;
    await unlockAchievement(req.userId, 'budget_set');
    if (count >= 5) await unlockAchievement(req.userId, 'budget_master');
    ok(res, { created: true });
  } catch (e) {
    if (e.code === '23505' || /unique/i.test(e.message)) return fail(res, 'Budget already exists');
    fail(res, e.message, 500);
  }
});

app.patch('/budgets/:id', auth, async (req, res) => {
  const amount = toMoney(req.body.amount);
  if (!(amount > 0)) return fail(res, 'Invalid');
  await db.prepare('UPDATE budgets SET amount = ? WHERE id = ? AND user_id = ?')
    .run(amount, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/budgets/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// STREAK
// ============================================================
app.get('/streak', auth, async (req, res) => {
  const s = await db.prepare('SELECT * FROM streaks WHERE user_id = ?').get(req.userId);
  ok(res, s || { current_days: 0, total_days: 0, last_check_in: null });
});

app.post('/streak/check-in', auth, async (req, res) => {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0]; // ម៉ោងកម្ពុជា
  const s = await db.prepare('SELECT * FROM streaks WHERE user_id = ?').get(req.userId);
  if (!s) {
    await db.prepare('INSERT INTO streaks (user_id, current_days, total_days, last_check_in) VALUES (?, 1, 1, ?)')
      .run(req.userId, today);
    return ok(res, { current_days: 1, total_days: 1, is_new: true });
  }
  if (s.last_check_in === today) return ok(res, { ...s, is_new: false });
  const yesterday = new Date(Date.now() + 7 * 3600 * 1000 - 86400000).toISOString().split('T')[0];
  const newCurrent = s.last_check_in === yesterday ? s.current_days + 1 : 1;
  await db.prepare('UPDATE streaks SET current_days = ?, total_days = ?, last_check_in = ? WHERE user_id = ?')
    .run(newCurrent, s.total_days + 1, today, req.userId);
  if (newCurrent >= 7) await unlockAchievement(req.userId, 'streak_7');
  if (newCurrent >= 30) await unlockAchievement(req.userId, 'streak_30');
  if (newCurrent >= 100) await unlockAchievement(req.userId, 'streak_100');
  ok(res, { current_days: newCurrent, total_days: s.total_days + 1, is_new: true });
});

// ============================================================
// ACHIEVEMENTS
// ============================================================
app.get('/achievements', auth, async (req, res) => {
  const unlocked = await db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id = ?').all(req.userId);
  const map = {};
  for (const u of unlocked) map[u.code] = u.unlocked_at;
  ok(res, ACHIEVEMENTS_DEF.map((a) => ({
    ...a, unlocked: !!map[a.code], unlocked_at: map[a.code] || null,
  })));
});

// ============================================================
// REMINDERS
// ============================================================
app.get('/reminders', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date ASC').all(req.userId));
});

app.post('/reminders', auth, async (req, res) => {
  const { title, due_date, icon_code } = req.body;
  const amount = toMoney(req.body.amount);
  if (!title || !(amount > 0) || !due_date) return fail(res, 'Invalid');
  await db.prepare('INSERT INTO reminders (user_id, title, amount, due_date, icon_code) VALUES (?, ?, ?, ?, ?)')
    .run(req.userId, title, amount, due_date, icon_code || 16);
  ok(res, { created: true });
});

app.patch('/reminders/:id', auth, async (req, res) => {
  await db.prepare('UPDATE reminders SET paid = ? WHERE id = ? AND user_id = ?')
    .run(req.body.paid ? 1 : 0, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/reminders/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// RECURRING
// ============================================================
app.get('/recurring', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM recurring WHERE user_id = ? ORDER BY next_date ASC').all(req.userId));
});

app.post('/recurring', auth, async (req, res) => {
  const { title, category, card_id, next_date, frequency, icon_code } = req.body;
  const amount = toMoney(req.body.amount);
  if (!title || !(amount > 0) || !next_date || !card_id) return fail(res, 'Invalid');
  const card = await db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(card_id, req.userId);
  if (!card) return fail(res, 'Card not found', 404, 'NOT_FOUND');
  if (!['monthly', 'weekly', 'yearly'].includes(frequency || 'monthly')) return fail(res, 'Invalid frequency');
  await db.prepare(`INSERT INTO recurring
    (user_id, title, amount, category, card_id, next_date, frequency, icon_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.userId, title, amount, category || 'វិក្កយបត្រ', card_id, next_date, frequency || 'monthly', icon_code || 16);
  ok(res, { created: true });
});

app.patch('/recurring/:id', auth, async (req, res) => {
  await db.prepare('UPDATE recurring SET active = ? WHERE id = ? AND user_id = ?')
    .run(req.body.active ? 1 : 0, req.params.id, req.userId);
  ok(res, { updated: true });
});

app.delete('/recurring/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM recurring WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

app.post('/recurring/process-due', auth, async (req, res) => {
  const today = new Date().toISOString();
  const due = await db.prepare(
    'SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND next_date <= ?'
  ).all(req.userId, today);
  let processed = 0;
  for (const r of due) {
    const card = await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(r.card_id, req.userId);
    if (!card || card.balance < r.amount || card.frozen) continue;
    const next = new Date();
    if (r.frequency === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (r.frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (r.frequency === 'yearly') next.setFullYear(next.getFullYear() + 1);
    await db.transaction(async () => {
      await db.prepare('UPDATE cards SET balance = ROUND(balance - ?, 2) WHERE id = ?').run(r.amount, r.card_id);
      await db.prepare(`INSERT INTO transactions
        (user_id, card_id, title, category, amount, is_expense, icon_code)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(req.userId, r.card_id, r.title, r.category, r.amount, r.icon_code);
      await db.prepare('UPDATE recurring SET next_date = ? WHERE id = ?')
        .run(next.toISOString().split('T')[0], r.id);
    });
    await notifyUser(req.userId, 'ប្រតិបត្តិការស្វ័យប្រវត្តិ',
      `${r.title} · -$${r.amount.toFixed(2)}`, { type: 'recurring' },
      Number.isInteger(r.icon_code) ? r.icon_code : 0);
    processed++;
  }
  ok(res, { processed });
});

// ============================================================
// SPLITS
// ============================================================
app.get('/splits', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM splits WHERE user_id = ? ORDER BY created_at DESC').all(req.userId));
});

app.post('/splits', auth, async (req, res) => {
  const { title, participants } = req.body;
  const total_amount = toMoney(req.body.total_amount);
  if (!title || !(total_amount > 0) || !Array.isArray(participants) || participants.length < 1)
    return fail(res, 'Invalid');
  const share = Math.round(total_amount / (participants.length + 1) * 100) / 100;
  await db.prepare(`INSERT INTO splits
    (user_id, title, total_amount, your_share, participants) VALUES (?, ?, ?, ?, ?)`)
    .run(req.userId, title, total_amount, share, JSON.stringify(participants));
  ok(res, { your_share: share });
});

// ============================================================
// VIRTUAL CARDS
// ============================================================
app.get('/virtual-cards', auth, async (req, res) => {
  ok(res, await db.prepare('SELECT * FROM virtual_cards WHERE user_id = ?').all(req.userId));
});

app.post('/virtual-cards', auth, async (req, res) => {
  const { name } = req.body;
  const limit = req.body.limit_amount === undefined ? 500 : toMoney(req.body.limit_amount);
  if (!name || !(limit > 0)) return fail(res, 'Invalid');
  const number = '4' + Array.from({ length: 15 }, () => crypto.randomInt(0, 10)).join('');
  const cvv = String(crypto.randomInt(100, 1000));
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const y = String(new Date().getFullYear() + 3).slice(-2);
  await db.prepare(`INSERT INTO virtual_cards
    (user_id, name, number, cvv, expiry, limit_amount) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.userId, name, number, cvv, `${m}/${y}`, limit);
  ok(res, { created: true });
});

app.patch('/virtual-cards/:id', auth, async (req, res) => {
  const { active, frozen } = req.body;
  const updates = [];
  const params = [];
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (frozen !== undefined) { updates.push('frozen = ?'); params.push(frozen ? 1 : 0); }
  if (updates.length === 0) return fail(res, 'Nothing to update');
  params.push(req.params.id, req.userId);
  await db.prepare(`UPDATE virtual_cards SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  ok(res, { updated: true });
});

app.delete('/virtual-cards/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM virtual_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  ok(res, { deleted: true });
});

// ============================================================
// REFERRAL
// ============================================================
app.get('/referral', auth, async (req, res) => {
  let r = await db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  if (!r) {
    const code = 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    await db.prepare('INSERT INTO referrals (user_id, code) VALUES (?, ?)').run(req.userId, code);
    r = await db.prepare('SELECT * FROM referrals WHERE user_id = ?').get(req.userId);
  }
  ok(res, r);
});

app.post('/referral/redeem', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return fail(res, 'Invalid');
  const me = await db.prepare('SELECT referred_by FROM users WHERE id = ?').get(req.userId);
  if (me && me.referred_by) return fail(res, 'អ្នកបានប្រើកូដណែនាំរួចហើយ', 400, 'ALREADY_REDEEMED');

  const referrer = await db.prepare('SELECT user_id FROM referrals WHERE code = ?').get(String(code).toUpperCase());
  if (!referrer) return fail(res, 'Invalid code');
  if (referrer.user_id === req.userId) return fail(res, 'Cannot use own code');

  await db.transaction(async () => {
    const bump = db.prepare(`UPDATE cards SET balance = ROUND(balance + 5, 2)
      WHERE id = (SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1)`);
    await bump.run(referrer.user_id);
    await bump.run(req.userId);
    await db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.user_id, req.userId);
    await db.prepare('UPDATE referrals SET referred_count = referred_count + 1, earnings = earnings + 5 WHERE user_id = ?')
      .run(referrer.user_id);
    await db.prepare('INSERT INTO notifications (user_id, title, body, icon_code) VALUES (?, ?, ?, ?)')
      .run(referrer.user_id, 'ប្រាក់រង្វាន់ Referral', 'ទទួលបាន $5.00', 18);
  });
  await unlockAchievement(referrer.user_id, 'referral_1');
  ok(res, { bonus: 5 });
});

// ============================================================
// CASHBACK
// ============================================================
app.get('/cashback', auth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM cashback WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  ).all(req.userId);
  const total = (await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS s FROM cashback WHERE user_id = ?'
  ).get(req.userId)).s;
  ok(res, { total, history: rows, rates: CASHBACK_RATES });
});

// ============================================================
// INSIGHTS
// ============================================================
app.get('/insights', auth, async (req, res) => {
  const localDate = `(created_at AT TIME ZONE 'Asia/Phnom_Penh')::date`;
  const thisStart = `date_trunc('month', now() AT TIME ZONE 'Asia/Phnom_Penh')::date`;
  const lastStart = `date_trunc('month', (now() AT TIME ZONE 'Asia/Phnom_Penh') - interval '1 month')::date`;

  const thisMonth = await db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE user_id = ? AND is_expense = 1 AND ${localDate} >= ${thisStart}
    GROUP BY category ORDER BY total DESC
  `).all(req.userId);

  const lastMonth = await db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM transactions
    WHERE user_id = ? AND is_expense = 1
      AND ${localDate} >= ${lastStart} AND ${localDate} < ${thisStart}
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

  const budgets = await db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(req.userId);
  for (const b of budgets) {
    const spent = (await db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE user_id = ? AND is_expense = 1 AND category = ?
        AND ${localDate} >= ${thisStart}
    `).get(req.userId, b.category)).s;
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
app.post('/fcm/register', auth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return fail(res, 'Invalid');
  await db.transaction(async () => {
    // Token មួយជាកម្មសិទ្ធិទូរស័ព្ទមួយ: លុបពីអ្នកប្រើផ្សេង ដើម្បីកុំឲ្យ
    // ការជូនដំណឹងរបស់ B ទៅលោតលើទូរស័ព្ទដែល A ធ្លាប់ Login
    await db.prepare('DELETE FROM fcm_tokens WHERE token = ? OR user_id = ?').run(token, req.userId);
    await db.prepare('INSERT INTO fcm_tokens (user_id, token) VALUES (?, ?)').run(req.userId, token);
  });
  console.log(`✅ FCM Token registered for user ${req.userId}`);
  ok(res, { registered: true });
});

// ហៅពេល Logout
app.post('/fcm/unregister', auth, async (req, res) => {
  await db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(req.userId);
  ok(res, { unregistered: true });
});

// ============================================================
// CURRENCY
// ============================================================
app.get('/currency/rates', auth, async (req, res) => {
  ok(res, { USD_KHR: 4100, KHR_USD: 1 / 4100 });
});

// ============================================================
// REGIONS / ទីតាំងភូមិសាស្ត្រ (ខេត្ត/ស្រុក/ឃុំ/ភូមិ)
// ============================================================
let _regionsCache = null;
app.get('/regions', async (req, res) => {
  if (!_regionsCache) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, 'data', 'cambodia_admin.json'), 'utf8');
      _regionsCache = JSON.parse(raw);
    } catch (e) {
      return fail(res, 'Region data not found', 500, 'NO_REGIONS');
    }
  }
  ok(res, _regionsCache);
});

// ============================================================
// ADMIN DASHBOARD (គ្រប់គ្រងទិន្នន័យទាំងអស់)
// ============================================================
const createAdminRouter = require('./admin');
app.use('/admin/api', createAdminRouter({
  db, ok, fail, ApiError, handle, SECRET, sendPushNotification, notifyUser, seedNewUser,
}));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ============================================================
// ERROR HANDLERS & START
// ============================================================
app.use((req, res) => fail(res, 'Not found', 404, 'NOT_FOUND'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 'Invalid JSON', 400, 'BAD_JSON');
  if (err.type === 'entity.too.large')
    return fail(res, 'រូបភាពធំពេក (អតិបរមា 200 KB)', 413, 'AVATAR_TOO_LARGE');
  console.error('❌ Unhandled:', err);
  fail(res, 'Server error', 500, 'SERVER_ERROR');
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => ensureAdminAccount())
  .then(() => {
    const server = http.createServer(app);
    setupWebSocket(server, db, ok, fail, ApiError, handle);
    server.listen(PORT, () => console.log(`🚀 Backend on http://localhost:${PORT} (WebSocket: /device-ws)`));
  })
  .catch((e) => {
    console.error('❌ Database init failed:', e);
    process.exit(1);
  });