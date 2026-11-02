// Postgres access layer.
// Keeps the shape the rest of server.js expects from better-sqlite3
// (db.prepare(sql).get/all/run, db.exec, db.transaction) but is async.
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL must be set');
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => console.error('❌ Postgres idle client error:', err.message));

// BIGINT / NUMERIC arrive as strings by default; the API has always returned numbers.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const als = new AsyncLocalStorage();

// Tables whose primary key is a generated id; INSERTs get "RETURNING id"
// so callers can keep using lastInsertRowid.
const ID_TABLES = new Set([
  'users', 'cards', 'transactions', 'goals', 'notifications', 'loans',
  'budgets', 'achievements', 'reminders', 'recurring', 'splits',
  'virtual_cards', 'referrals', 'cashback', 'external_transfers',
]);

// ? -> $1, $2 ... but leave question marks inside string literals alone.
function translate(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inString = !inString;
      out += ch;
      continue;
    }
    if (ch === '?' && !inString) {
      n++;
      out += '$' + n;
      continue;
    }
    out += ch;
  }
  return out;
}

function addReturningId(sql) {
  if (!/^\s*insert\s+into\b/i.test(sql)) return sql;
  if (/\breturning\b/i.test(sql)) return sql;
  const m = sql.match(/^\s*insert\s+into\s+"?(\w+)"?/i);
  if (!m || !ID_TABLES.has(m[1].toLowerCase())) return sql;
  return sql.replace(/;?\s*$/, '') + ' RETURNING id';
}

const normalize = (v) =>
  v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

const client = () => als.getStore() || pool;

function prepare(sql) {
  const text = translate(addReturningId(sql));
  const query = (params) => client().query(text, params.map(normalize));
  return {
    async get(...params) {
      const r = await query(params);
      return r.rows[0];
    },
    async all(...params) {
      const r = await query(params);
      return r.rows;
    },
    async run(...params) {
      const r = await query(params);
      return {
        changes: r.rowCount,
        lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined,
      };
    },
  };
}

async function exec(sql) {
  await client().query(sql);
}

// Runs fn inside a single transaction on one connection. Nested calls reuse
// the outer transaction.
async function transaction(fn) {
  if (als.getStore()) return fn();
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const result = await als.run(conn, fn);
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await conn.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { prepare, exec, transaction, pool };
