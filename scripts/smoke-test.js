// Local end-to-end smoke test against an embedded Postgres.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const PG_PORT = 55432;
const PORT = 3100;
const DB_DIR = path.join(process.env.TEMP || '.', 'aura-pgtest');
const BASE = `http://127.0.0.1:${PORT}`;

let pg;
let server;

const waitFor = async (fn, ms = 60000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout: ' + label);
};

async function api(method, p, body, token, extraHeaders = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const assert = (cond, label, detail) => {
  if (!cond) {
    console.error('❌ FAIL:', label, detail !== undefined ? JSON.stringify(detail) : '');
    throw new Error('assertion failed: ' + label);
  }
  console.log('✅', label);
};

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/aura_test`,
      JWT_SECRET: 'local-test-secret',
      QR_SECRET: 'local-test-secret:qr',
      ADMIN_EMAILS: 'sokha@test.com',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[srv:err] ' + d));
  await waitFor(
    async () => {
      if (server.exitCode !== null) throw new Error('server exited ' + server.exitCode);
      const r = await fetch(BASE + '/currency/rates');
      return r.status === 401 || r.status === 200;
    },
    60000,
    'server boot'
  );
}

async function stopServer() {
  if (!server) return;
  server.kill();
  await new Promise((r) => server.once('exit', r));
  server = null;
}

async function main() {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: DB_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('aura_test');
  console.log('✅ embedded postgres up');

  await startServer();

  const reg = await api('POST', '/auth/register', {
    name: 'Sokha Test',
    email: 'sokha@test.com',
    phone: '012345678',
    pin: '1234',
  });
  assert(reg.status === 200 && reg.json.data?.token, 'register user A', reg.json);
  const tokenA = reg.json.data.token;
  const idA = reg.json.data.user.id;

  const regB = await api('POST', '/auth/register', {
    name: 'Dara Test',
    email: 'dara@test.com',
    phone: '098765432',
    pin: '4321',
  });
  assert(regB.status === 200, 'register user B', regB.json);
  const tokenB = regB.json.data.token;
  const idB = regB.json.data.user.id;

  const me = await api('GET', '/me', undefined, tokenA);
  assert(me.json.data?.name === 'Sokha Test', 'GET /me');

  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const av = await api('POST', '/me/avatar', { avatar: TINY_PNG }, tokenA);
  assert(av.status === 200, 'POST /me/avatar', av.json);
  const meAv = await api('GET', '/me', undefined, tokenA);
  assert(meAv.json.data?.avatar === TINY_PNG, 'avatar returned by GET /me');
  const avBad = await api('POST', '/me/avatar', { avatar: 'data:image/png;base64,AAAA' }, tokenA);
  assert(avBad.status === 400, 'reject non-image avatar', avBad.json);
  const avClear = await api('POST', '/me/avatar', { avatar: null }, tokenA);
  assert(avClear.status === 200, 'clear avatar', avClear.json);
  const meNoAv = await api('GET', '/me', undefined, tokenA);
  assert(meNoAv.json.data?.avatar === null, 'avatar cleared');

  // 60 KB JPEG → ធំជាង global 10 KB limit, ត្រូវឆ្លងកាត់ parser ពិសេស
  const bigJpeg = 'data:image/jpeg;base64,' +
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60 * 1024)])
      .toString('base64');
  const avBig = await api('POST', '/me/avatar', { avatar: bigJpeg }, tokenA);
  assert(avBig.status === 200, 'avatar up to 200 KB accepted', avBig.json);
  const hugeJpeg = 'data:image/jpeg;base64,' +
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(220 * 1024)])
      .toString('base64');
  const avHuge = await api('POST', '/me/avatar', { avatar: hugeJpeg }, tokenA);
  assert(avHuge.status === 413, 'avatar over 200 KB rejected', avHuge.json);
  await api('POST', '/me/avatar', { avatar: null }, tokenA);

  const cards = await api('GET', '/cards', undefined, tokenA);
  assert(cards.json.data.length === 3, '3 seeded cards', cards.json.data?.length);
  assert(cards.json.data[0].balance === 12450, 'seeded balance is a number', cards.json.data[0].balance);
  const cardA = cards.json.data[0].id;

  const tx = await api(
    'POST',
    '/transactions',
    { card_id: cardA, title: 'អាហារថ្ងៃត្រង់', category: 'អាហារ', amount: 10, is_expense: true, icon_code: 1, pin: '1234' },
    tokenA
  );
  assert(tx.status === 200 && tx.json.data.cashback === 0.2, 'expense creates cashback', tx.json);
  assert(Math.abs(tx.json.data.new_balance - 12440.2) < 1e-6, 'balance decreased (cashback credited)', tx.json.data.new_balance);

  const txs = await api('GET', '/transactions', undefined, tokenA);
  assert(txs.json.data.length === 1, 'transaction listed');
  assert(typeof txs.json.data[0].created_at === 'string', 'created_at serialized', txs.json.data[0].created_at);

  const search = await api('GET', '/transactions/search?q=អាហារ&from=2026-01-01&to=2026-12-31', undefined, tokenA);
  assert(search.status === 200 && search.json.data.length === 1, 'transaction search with date range', search.json);

  const rec = await api('GET', '/recipients?q=dar', undefined, tokenA);
  assert(rec.status === 200 && rec.json.data.length === 1 && rec.json.data[0].name === 'Dara Test', 'recipient directory', rec.json);
  assert(!JSON.stringify(rec.json.data).includes('098765432'), 'recipient phone masked');

  // Thumbnail រូបភាពអ្នកទទួល → ត្រូវមានក្នុង directory និង lookup
  const THUMB = 'data:image/jpeg;base64,' +
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024)])
      .toString('base64');
  const avThumb = await api('POST', '/me/avatar',
    { avatar: TINY_PNG, thumb: THUMB }, tokenB);
  assert(avThumb.status === 200, 'POST /me/avatar with thumb', avThumb.json);
  const thumbB64 = THUMB.split(',')[1];
  const recThumb = await api('GET', '/recipients?q=dar', undefined, tokenA);
  assert(recThumb.json.data[0].avatar_thumb === thumbB64,
    'recipient directory carries avatar_thumb', recThumb.json.data[0]);
  const lookThumb = await api('GET', '/recipients/lookup?q=dara@test.com', undefined, tokenA);
  assert(lookThumb.json.data?.avatar_thumb === thumbB64,
    'recipient lookup carries avatar_thumb', lookThumb.json);
  const avNoThumb = await api('POST', '/me/avatar', { avatar: TINY_PNG }, tokenB);
  assert(avNoThumb.status === 200, 'POST /me/avatar without thumb', avNoThumb.json);
  const recNoThumb = await api('GET', '/recipients?q=dar', undefined, tokenA);
  assert(recNoThumb.json.data[0].avatar_thumb === null,
    'avatar_thumb cleared when not provided', recNoThumb.json.data[0]);

  const lookup = await api('GET', '/recipients/lookup?q=dara%40test.com', undefined, tokenA);
  assert(lookup.json.data?.name === 'Dara Test', 'lookup by email');

  const qr = await api('POST', '/qr/create', { amount: 5 }, tokenB);
  const resolved = await api('POST', '/qr/resolve', { qr_token: qr.json.data.qr_token }, tokenA);
  assert(resolved.json.data?.name === 'Dara Test', 'qr resolve');

  const key = 'idem-test-0001';
  const transfer = await api(
    'POST',
    '/transfers',
    { recipient_id: idB, card_id: cardA, amount: 25, note: 'lunch', pin: '1234' },
    tokenA,
    { 'Idempotency-Key': key }
  );
  assert(transfer.status === 200 && transfer.json.data?.transfer_ref, 'transfer succeeds', transfer.json);
  assert(Math.abs(transfer.json.data.new_balance - 12415.2) < 1e-6, 'sender debited', transfer.json.data.new_balance);

  const replay = await api(
    'POST',
    '/transfers',
    { recipient_id: idB, card_id: cardA, amount: 25, note: 'lunch', pin: '1234' },
    tokenA,
    { 'Idempotency-Key': key }
  );
  assert(replay.json.data.transfer_ref === transfer.json.data.transfer_ref, 'idempotent replay');

  const cardsB = await api('GET', '/cards', undefined, tokenB);
  assert(Math.abs(cardsB.json.data[0].balance - 12475) < 1e-6, 'recipient credited', cardsB.json.data[0].balance);

  const badPin = await api(
    'POST',
    '/transfers',
    { recipient_id: idB, card_id: cardA, amount: 5, pin: '9999' },
    tokenA,
    { 'Idempotency-Key': 'idem-bad-pin' }
  );
  assert(badPin.status === 401 && badPin.json.code === 'WRONG_PIN', 'server verifies PIN', badPin.json);

  const analytics = await api('GET', '/analytics', undefined, tokenA);
  assert(analytics.json.data.expense === 35, 'analytics totals', analytics.json.data);

  const budget = await api('POST', '/budgets', { category: 'អាហារ', amount: 100 }, tokenA);
  assert(budget.status === 200, 'create budget', budget.json);
  const dupBudget = await api('POST', '/budgets', { category: 'អាហារ', amount: 50 }, tokenA);
  assert(dupBudget.status === 400 && /already exists/i.test(dupBudget.json.error), 'duplicate budget rejected', dupBudget.json);
  const budgets = await api('GET', '/budgets', undefined, tokenA);
  assert(budgets.json.data[0].spent === 10, 'budget spent this month', budgets.json.data);

  const streak = await api('POST', '/streak/check-in', {}, tokenA);
  assert(streak.json.data.current_days === 1, 'streak check-in', streak.json);
  const streak2 = await api('POST', '/streak/check-in', {}, tokenA);
  assert(streak2.json.data.current_days === 1 && streak2.json.data.is_new === false, 'same-day check-in idempotent', streak2.json);

  const ach = await api('GET', '/achievements', undefined, tokenA);
  const unlocked = ach.json.data.filter((a) => a.unlocked).map((a) => a.code);
  assert(unlocked.includes('first_tx') && unlocked.includes('budget_set'), 'achievements unlocked', unlocked);

  const insights = await api('GET', '/insights', undefined, tokenA);
  assert(insights.status === 200 && Array.isArray(insights.json.data.insights), 'insights', insights.json);

  const badLoan = await api('POST', '/loan', { principal: 100, months: 3, annual_rate: 12 }, tokenA);
  assert(badLoan.status === 400, 'loan without address rejected', badLoan.json);

  const loan = await api('POST', '/loan', { principal: 100, months: 3, annual_rate: 12,
    province: 'ភ្នំពេញ', district: 'ចំការមន', commune: 'ទន្លេបាសាក់', village: 'ទន្លេបាសាក់' }, tokenA);
  assert(loan.status === 200 && loan.json.data.id, 'loan created', loan.json);
  const pay = await api('POST', '/loan/pay', {}, tokenA);
  assert(pay.status === 200, 'loan payment', pay.json);
  const loanGet = await api('GET', '/loan', undefined, tokenA);
  assert(loanGet.json.data.paid === 1, 'loan paid count', loanGet.json.data);
  assert(loanGet.json.data.province === 'ភ្នំពេញ' &&
    loanGet.json.data.district === 'ចំការមន' &&
    loanGet.json.data.commune === 'ទន្លេបាសាក់' &&
    loanGet.json.data.village === 'ទន្លេបាសាក់', 'loan address persisted', loanGet.json.data);

  const ext = await api('GET', '/transfers/external', undefined, tokenA);
  assert(ext.status === 200, 'external transfer history');

  const banks = await api('GET', '/banks', undefined, tokenA);
  assert(banks.json.data.length === 7, 'bank rails seeded', banks.json.data?.length);

  const cur = await api('GET', '/currency/rates', undefined, tokenA);
  assert(cur.json.data.USD_KHR === 4100, 'currency rates');

  const notifications = await api('GET', '/notifications', undefined, tokenA);
  assert(notifications.json.data.length >= 2, 'notifications created');
  const readAll = await api('POST', '/notifications/read-all', {}, tokenA);
  assert(readAll.status === 200, 'notifications read-all');

  const cashback = await api('GET', '/cashback', undefined, tokenA);
  assert(cashback.json.data.total === 0.2, 'cashback history', cashback.json.data.total);

  const goal = await api('POST', '/goals', { name: 'Test goal', target: 1000, icon_code: 3, color: 0xFF3D5AFE }, tokenA);
  assert(goal.status === 200 && goal.json.data.id, 'goal created', goal.json);
  const dep = await api('POST', `/goals/${goal.json.data.id}/deposit`, { amount: 150 }, tokenA);
  assert(dep.status === 200, 'goal deposit', dep.json);
  const goals = await api('GET', '/goals', undefined, tokenA);
  assert(goals.json.data.length === 4, 'goals listed', goals.json.data.length);

  const rem = await api('POST', '/reminders', { title: 'Electric', amount: 12, due_date: '2026-12-01', icon_code: 4 }, tokenA);
  assert(rem.status === 200, 'reminder created', rem.json);
  const rems = await api('GET', '/reminders', undefined, tokenA);
  const paid = await api('PATCH', `/reminders/${rems.json.data[0].id}`, { paid: true }, tokenA);
  assert(paid.status === 200, 'reminder paid');
  const delRem = await api('DELETE', `/reminders/${rems.json.data[0].id}`, undefined, tokenA);
  assert(delRem.status === 200, 'reminder deleted');

  const recur = await api(
    'POST',
    '/recurring',
    { title: 'Internet', amount: 8, card_id: cardA, next_date: '2026-01-01', frequency: 'monthly' },
    tokenA
  );
  assert(recur.status === 200, 'recurring created', recur.json);
  const due = await api('POST', '/recurring/process-due', {}, tokenA);
  assert(due.json.data.processed === 1, 'recurring processed', due.json.data);
  const recurList = await api('GET', '/recurring', undefined, tokenA);
  assert(recurList.json.data.length === 1, 'recurring listed');

  const split = await api('POST', '/splits', { title: 'Dinner', total_amount: 30, participants: ['a', 'b'] }, tokenA);
  assert(split.json.data.your_share === 10, 'split share', split.json.data);
  const splits = await api('GET', '/splits', undefined, tokenA);
  assert(splits.json.data.length === 1, 'splits listed');

  const vc = await api('POST', '/virtual-cards', { name: 'Online card', limit_amount: 300 }, tokenA);
  assert(vc.status === 200, 'virtual card created', vc.json);
  const vcs = await api('GET', '/virtual-cards', undefined, tokenA);
  assert(vcs.json.data.length === 1 && vcs.json.data[0].limit_amount === 300, 'virtual cards listed', vcs.json.data);
  const vcPatch = await api('PATCH', `/virtual-cards/${vcs.json.data[0].id}`, { frozen: true }, tokenA);
  assert(vcPatch.status === 200, 'virtual card frozen');
  const vcDel = await api('DELETE', `/virtual-cards/${vcs.json.data[0].id}`, undefined, tokenA);
  assert(vcDel.status === 200, 'virtual card deleted');

  const refB = await api('GET', '/referral', undefined, tokenB);
  assert(refB.json.data.code, 'referral code issued', refB.json);
  const redeem = await api('POST', '/referral/redeem', { code: refB.json.data.code }, tokenA);
  assert(redeem.status === 200 && redeem.json.data.bonus === 5, 'referral redeemed', redeem.json);
  const refB2 = await api('GET', '/referral', undefined, tokenB);
  assert(refB2.json.data.referred_count === 1, 'referral counted', refB2.json.data);

  const ext2 = await api(
    'POST',
    '/transfers/external',
    { bank_code: 'ACLEDA', recipient_name: 'Sok Dara', recipient_account: '000123456', card_id: cardA, amount: 10, pin: '1234' },
    tokenA,
    { 'Idempotency-Key': 'idem-ext-0001' }
  );
  assert(ext2.status === 200 && ext2.json.data.fee >= 0, 'external transfer', ext2.json);

  const cardPatch = await api('PATCH', `/cards/${cardA}`, { online: false, daily_limit: 5000 }, tokenA);
  assert(cardPatch.status === 200, 'card settings updated');

  const pinChange = await api('POST', '/auth/change-pin', { old_pin: '1234', new_pin: '5678' }, tokenA);
  assert(pinChange.status === 200, 'pin changed');
  const pinVerify = await api('POST', '/auth/verify-pin', { pin: '5678' }, tokenA);
  assert(pinVerify.json.data.valid === true, 'new pin verified');

  const fcm = await api('POST', '/fcm/register', { token: 'fake-token-123' }, tokenA);
  assert(fcm.status === 200, 'fcm registered');
  const fcmOff = await api('POST', '/fcm/unregister', {}, tokenA);
  assert(fcmOff.status === 200, 'fcm unregistered');

  // persistence: restart the API process only, same database
  await stopServer();
  await startServer();
  const login = await api('POST', '/auth/login', { email: 'sokha@test.com', pin: '5678' });
  assert(login.status === 200 && login.json.data.token, 'login after restart', login.json);
  const txsAfter = await api('GET', '/transactions', undefined, login.json.data.token);
  assert(txsAfter.json.data.length === 4, 'data survived restart', txsAfter.json.data.length);

  // ============ ADMIN DASHBOARD ============
  const adminNoToken = await api('GET', '/admin/api/stats');
  assert(adminNoToken.status === 401, 'admin API rejects anonymous', adminNoToken.json);

  const adminBadPin = await api('POST', '/admin/api/login', { email: 'sokha@test.com', pin: '0000' });
  assert(adminBadPin.status === 401, 'admin login rejects wrong PIN', adminBadPin.json);

  const notAdmin = await api('POST', '/admin/api/login', { email: 'dara@test.com', pin: '4321' });
  assert(notAdmin.status === 403, 'non-admin cannot log into admin', notAdmin.json);

  const adminLogin = await api('POST', '/admin/api/login', { email: 'sokha@test.com', pin: '5678' });
  assert(adminLogin.status === 200 && adminLogin.json.data.token, 'admin login (auto-promote via ADMIN_EMAILS)', adminLogin.json);
  const adminToken = adminLogin.json.data.token;

  const stats = await api('GET', '/admin/api/stats', undefined, adminToken);
  assert(stats.status === 200 && stats.json.data.totals.users >= 2, 'admin stats', stats.json.data?.totals);
  assert(Array.isArray(stats.json.data.daily) && Array.isArray(stats.json.data.categories), 'admin stats charts data');

  const adminUsers = await api('GET', '/admin/api/users?q=sokha', undefined, adminToken);
  assert(adminUsers.status === 200 && adminUsers.json.data.rows.length === 1, 'admin user search', adminUsers.json);
  const adminUserId = adminUsers.json.data.rows[0].id;

  const adminUserDetail = await api('GET', `/admin/api/users/${adminUserId}`, undefined, adminToken);
  assert(adminUserDetail.status === 200 && adminUserDetail.json.data.cards.length === 3, 'admin user detail', Object.keys(adminUserDetail.json.data || {}));

  const adminEdit = await api('PATCH', `/admin/api/users/${adminUserId}`, { name: 'Sokha Admin' }, adminToken);
  assert(adminEdit.status === 200 && adminEdit.json.data.name === 'Sokha Admin', 'admin edits user', adminEdit.json);

  const adminCards = await api('GET', '/admin/api/cards', undefined, adminToken);
  assert(adminCards.status === 200 && adminCards.json.data.rows.length >= 3, 'admin cards list', adminCards.json.data?.rows?.length);
  const ownCard = adminCards.json.data.rows.find((c) => c.user_id === adminUserId);
  const adminCardId = ownCard.id;

  const adminCardPatch = await api('PATCH', `/admin/api/cards/${adminCardId}`, { balance: 5000, frozen: true }, adminToken);
  assert(adminCardPatch.status === 200 && adminCardPatch.json.data.balance === 5000 && adminCardPatch.json.data.frozen === 1,
    'admin adjusts card balance/freezes', adminCardPatch.json);

  const adminTx = await api('POST', '/admin/api/transactions', {
    user_id: adminUserId, card_id: adminCardId, title: 'Admin credit', category: 'ផ្សេងៗ', amount: 25, is_expense: false,
  }, adminToken);
  assert(adminTx.status === 200 && adminTx.json.data.new_balance === 5025, 'admin creates transaction (credits card)', adminTx.json);

  const adminTxList = await api('GET', '/admin/api/transactions?q=Admin credit', undefined, adminToken);
  assert(adminTxList.status === 200 && adminTxList.json.data.total === 1, 'admin transaction search', adminTxList.json.data?.total);

  const adminTxDel = await api('DELETE', `/admin/api/transactions/${adminTx.json.data.id}`, undefined, adminToken);
  assert(adminTxDel.status === 200, 'admin deletes transaction');
  const cardAfter = await api('GET', '/admin/api/cards', undefined, adminToken);
  assert(Number(cardAfter.json.data.rows.find((c) => c.id === adminCardId).balance) === 5000, 'balance restored after delete');

  const adminLoans = await api('GET', '/admin/api/loans', undefined, adminToken);
  assert(adminLoans.status === 200 && Array.isArray(adminLoans.json.data.rows), 'admin loans list');

  const adminNotify = await api('POST', '/admin/api/notify', {
    user_id: adminUserId, title: 'សារពី admin', body: 'សូមពិនិត្យការប្រតិបត្តិការ',
  }, adminToken);
  assert(adminNotify.status === 200, 'admin sends notification', adminNotify.json);

  const adminGoals = await api('GET', '/admin/api/tables/goals', undefined, adminToken);
  assert(adminGoals.status === 200 && adminGoals.json.data.rows.length >= 3, 'admin generic table (goals)', adminGoals.json.data?.rows?.length);

  const adminAudit = await api('GET', '/admin/api/audit', undefined, adminToken);
  assert(adminAudit.status === 200 && adminAudit.json.data.rows.length > 0, 'admin audit log', adminAudit.json.data?.rows?.length);

  const adminSetPin = await api('POST', `/admin/api/users/${adminUserId}/pin`, { pin: '4321' }, adminToken);
  assert(adminSetPin.status === 200, 'admin resets user PIN', adminSetPin.json);
  const relogin = await api('POST', '/auth/login', { email: 'sokha@test.com', pin: '4321' });
  assert(relogin.status === 200, 'user logs in with admin-set PIN', relogin.json);

  // ---------- LIVE STATUS / LOCK / RESET ----------
  const liveList = await api('GET', '/admin/api/users?q=dara', undefined, adminToken);
  assert(liveList.status === 200 && liveList.json.data.rows.length === 1, 'admin finds user to test live status');
  const daraId = liveList.json.data.rows[0].id;
  assert(liveList.json.data.rows[0].last_seen_at, 'last_seen_at recorded after login');
  assert(liveList.json.data.rows[0].online === true, 'user is Live right after login');
  const liveStats = await api('GET', '/admin/api/stats', undefined, adminToken);
  assert(liveStats.json.data.totals.online_users >= 1, 'stats counts live users', liveStats.json.data?.totals);
  assert(Array.isArray(liveStats.json.data.liveUsers), 'stats lists live users');

  const lockDara = await api('PATCH', `/admin/api/users/${daraId}`, { is_locked: true }, adminToken);
  assert(lockDara.status === 200, 'admin locks a user', lockDara.json);
  const lockedLogin = await api('POST', '/auth/login', { email: 'dara@test.com', pin: '4321' });
  assert(lockedLogin.status === 403 && lockedLogin.json.code === 'ACCOUNT_LOCKED',
    'locked user cannot log in', lockedLogin.json);
  const unlockDara = await api('PATCH', `/admin/api/users/${daraId}`, { is_locked: false }, adminToken);
  assert(unlockDara.status === 200, 'admin unlocks a user', unlockDara.json);
  const daraLogin = await api('POST', '/auth/login', { email: 'dara@test.com', pin: '4321' });
  assert(daraLogin.status === 200, 'unlocked user can log in again', daraLogin.json);

  const resetDara = await api('POST', `/admin/api/users/${daraId}/reset`, { reseed: true }, adminToken);
  assert(resetDara.status === 200, 'admin resets a user', resetDara.json);
  const daraAfter = await api('GET', `/admin/api/users/${daraId}`, undefined, adminToken);
  assert(daraAfter.json.data.transactions.length === 0,
    'reset wipes transactions', daraAfter.json.data?.transactions?.length);
  assert(daraAfter.json.data.cards.length === 3,
    'reset re-seeds default cards', daraAfter.json.data?.cards?.length);
  assert(daraAfter.json.data.goals.length === 3,
    'reset re-seeds default goals', daraAfter.json.data?.goals?.length);

  const selfLock = await api('PATCH', `/admin/api/users/${adminUserId}`, { is_locked: true }, adminToken);
  assert(selfLock.status === 400 && selfLock.json.code === 'SELF_LOCK',
    'admin cannot lock their own account', selfLock.json);

  const adminDash = await fetch(BASE + '/admin/');
  const dashHtml = await adminDash.text();
  assert(adminDash.status === 200 && dashHtml.includes('ផ្ទាំងគ្រប់គ្រង'), 'admin dashboard page served', adminDash.status);

  console.log('\n🎉 ALL LOCAL TESTS PASSED');
}

main()
  .catch((e) => {
    console.error('\n💥 TEST FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  });
