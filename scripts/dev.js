// ដំឡើងសម្រាប់អភិវឌ្ឍន៍ — Postgres ក្នុងមូលដ្ឋាន + restart ភ្លាមពេលកែកូដ
// ប្រើ: npm run dev   →  http://127.0.0.1:3100  (ទិន្នន័យទុកក្នុង %TEMP%\aura-pgdev ដូច្នេះ restart មិនបាត់)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const ROOT = path.join(__dirname, '..');
const PG_DIR = path.join(process.env.TEMP || '.', 'aura-pgdev');
const PG_PORT = Number(process.env.DEV_PG_PORT || 55433);
const PORT = Number(process.env.DEV_PORT || 3100);
const DB_NAME = 'aura_dev';

let child = null;
let restarting = false;
let stopping = false;

function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`,
      JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
      QR_SECRET: process.env.QR_SECRET || 'dev-secret:qr',
      PORT: String(PORT),
    },
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    if (!restarting && !stopping) console.log(`\n🛑 Server stopped (${code})`);
  });
}

function restart() {
  if (restarting || stopping) return;
  restarting = true;
  console.log('\n🔄 កែកូដ → restart server…');
  const old = child;
  child = null;
  if (old) {
    old.once('exit', () => {
      restarting = false;
      startServer();
    });
    old.kill();
  } else {
    restarting = false;
    startServer();
  }
}

async function waitForPort(port, timeoutMs) {
  const net = require('net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.on('connect', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(true));
      setTimeout(() => { s.destroy(); resolve(true); }, 500);
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  const hasCluster = fs.existsSync(path.join(PG_DIR, 'PG_VERSION'));
  if (!hasCluster) {
    console.log('🗄️ បង្កើត Postgres ថ្មី…');
    await pg.initialise();
  }

  let ownsServer = true;
  const portBusy = !(await waitForPort(PG_PORT, 800));
  if (portBusy) {
    // មាន Postgres ដំណើរការរួចនៅ port នេះ → ព្យាយាមប្រើវា (មិនចាំបាច់បង្កើតទៀត)
    try {
      const client = pg.getPgClient(DB_NAME);
      await client.connect();
      await client.end();
      console.log(`♻️ ប្រើ Postgres ដែលកំពុងដំណើរការនៅ port ${PG_PORT}`);
      ownsServer = false;
    } catch (_) {
      console.error(`❌ Port ${PG_PORT} ជាការងារ ដែលមិនមែនជា Postgres របស់ dev — សូមផ្លាស់ port តាម DEV_PG_PORT`);
      process.exit(1);
    }
  } else {
    await pg.start();
  }

  if (ownsServer) {
    try {
      await pg.createDatabase(DB_NAME);
    } catch (_) {
      // មានរួចហើយ — បង្កើតមិនចាំបាច់
    }
  }

  console.log(`✅ Postgres ready on ${PG_PORT} (${DB_NAME})`);
  console.log(`🌐 API: http://127.0.0.1:${PORT}   ផ្ទាំងគ្រប់គ្រង: http://127.0.0.1:${PORT}/admin/`);
  startServer();

  let timer = null;
  fs.watch(ROOT, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const f = String(filename).replace(/\\/g, '/');
    if (f.startsWith('node_modules') || f.startsWith('.git') || f.startsWith('scripts')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(restart, 120);
  });

  const shutdown = async () => {
    stopping = true;
    if (child) child.kill();
    if (ownsServer) await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error('❌ Dev server failed:', (e && e.message) || e);
  process.exit(1);
});
