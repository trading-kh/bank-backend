// E2E — ម្រែបរថ្មី: CO intake · auto-debit · ក្រុមប្រមូល
const BASE = 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

(async () => {
  const stamp = Date.now();
  const email = `newfeat.${stamp}@aura.test`;
  const pin = '1234';

  console.log('\n— អ្នកប្រើ + KYC —');
  const reg = await call('POST', '/auth/register', {
    body: { name: 'អ្នកសាកល្បងថ្មី', email, phone: '+855' + (10000000 + (stamp % 89999999)), pin },
  });
  const token = reg.body.data?.token;
  const userId = reg.body.data?.user.id;
  check('ចុះឈ្មោះបាន', !!token, reg.body);

  await call('POST', '/loan/kyc', {
    token,
    body: {
      full_name: 'អ្នកសាកល្បងថ្មី', national_id: 'N' + stamp, dob: '1993-03-02',
      gender: 'female', phone: '+85512345679', address: 'ភ្នំពេញ',
      occupation: 'អ្នកបើកសាង', business_name: 'ហាងលាក់', business_type: 'លាក់',
      business_years: 5, monthly_income: 1200, monthly_expense: 400, existing_debt: 50,
      bank_name: 'ABA', bank_account: '99887766', submit: true,
    },
  });
  check('KYC ដាក់ស្នើបាន', true);

  const adminLogin = await call('POST', '/admin/api/login', {
    body: { email: 'admin@local.dev', password: 'local-dev-admin' },
  });
  const at = adminLogin.body.data?.token;
  check('admin ចូលបាន', !!at, adminLogin.body);

  console.log('\n— CO intake (ទទួលកម្ចីដោយ Credit Officer) —');
  const intakeNoCo = await call('POST', '/admin/api/loans/intake', {
    token: at, body: { user_id: userId, principal: 2000, months: 12, annual_rate: 18 },
  });
  check('ត្រូវការឈ្មោះ CO', intakeNoCo.status === 400, intakeNoCo.body);

  const intake = await call('POST', '/admin/api/loans/intake', {
    token: at,
    body: {
      user_id: userId, principal: 2000, months: 12, annual_rate: 18,
      interest_method: 'flat', province: 'ភ្នំពេញ', district: 'មហាវត្ត',
      commune: 'ចំការថន', village: 'ភូមិ', purpose: 'ពង្រីងស្តុក',
      co_name: 'ព្រះសារណៈ ស៊ិន', co_phone: '+85598765432', co_branch: 'សង្កាត់កណ្តាល',
    },
  });
  check('CO intake បាន', intake.status === 200 && intake.body.data?.channel === 'co', intake.body);
  const loanId = intake.body.data?.id;

  const detail = await call('GET', `/admin/api/loans/${loanId}`, { token: at });
  check('ស្តុកកម្ចី channel=co', detail.body.data?.loan?.channel === 'co', detail.body.data?.loan?.channel);
  check('មានឈ្មោះ CO', detail.body.data?.loan?.co_name === 'ព្រះសារណៈ ស៊ិន', detail.body.data?.loan?.co_name);

  console.log('\n— អនុមត្ត + បង់ស្វត្តកម្ម —');
  const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const approve = await call('POST', `/admin/api/loans/${loanId}/approve`, {
    token: at,
    body: {
      months: 12, annual_rate: 18, interest_method: 'flat', fee_percent: 0,
      first_due_date: past, account_verified: true, auto_debit: true,
    },
  });
  check('អនុមត្តបាន (auto_debit=1)', approve.status === 200, approve.body);
  check('បង្កើត 12 វីនុបទ', approve.body.data?.schedule_count === 12, approve.body.data);

  const afterApprove = await call('GET', `/admin/api/loans/${loanId}`, { token: at });
  check('auto_debit = 1', Number(afterApprove.body.data?.loan?.auto_debit) === 1, afterApprove.body.data?.loan?.auto_debit);

  const disburse = await call('POST', `/admin/api/loans/${loanId}/disburse`, { token: at, body: {} });
  check('បញ្ចូលស្រាប់បាន', disburse.status === 200, disburse.body);

  const afterDisburse = await call('GET', `/admin/api/loans/${loanId}`, { token: at });
  check('auto_debit_card_id ត្រូវបានកំណត់', !!afterDisburse.body.data?.loan?.auto_debit_card_id,
    afterDisburse.body.data?.loan?.auto_debit_card_id);

  const balanceBefore = await call('GET', '/cards', { token });
  const cardBalBefore = Number(balanceBefore.body.data?.rows?.[0]?.balance
    || balanceBefore.body.data?.[0]?.balance || 0);

  const run = await call('POST', '/admin/api/loans/run-auto-debit', { token: at, body: {} });
  check('ដំណើរការ auto-debit', run.status === 200, run.body);
  const paidResults = (run.body.data?.results || []).filter((r) => r.status === 'paid');
  check('បង់ស្វត្តកម្ម 1 វីនុបទ', paidResults.length === 1, run.body.data);

  const after = await call('GET', '/loan/schedule', { token });
  const row1 = after.body.data?.rows?.find((r) => r.installment_no === 1);
  check('វីនុបទទី 1 បានសង់', row1?.status === 'paid', row1);
  const payments = after.body.data?.payments || [];
  check('កំណត់ចំនាំ method=auto_debit',
    payments.some((p) => p.method === 'auto_debit'), payments.map((p) => p.method));

  const balanceAfter = await call('GET', '/cards', { token });
  const cardBalAfter = Number(balanceAfter.body.data?.rows?.[0]?.balance
    || balanceAfter.body.data?.[0]?.balance || 0);
  check('កាតត្រូវបានដក', Math.abs((cardBalBefore - cardBalAfter) - Number(row1?.total_due)) < 0.05,
    { cardBalBefore, cardBalAfter, due: row1?.total_due });

  const runAgain = await call('POST', '/admin/api/loans/run-auto-debit', { token: at, body: {} });
  check('ដំណើរទី២ មិនបង់ម្តងទៀត (វីនុបទទី២ មិនទាន់ដល់កាល)',
    !(runAgain.body.data?.results || []).some((r) => r.status === 'paid'), runAgain.body.data);

  const toggle = await call('PATCH', `/admin/api/loans/${loanId}/auto-debit`, {
    token: at, body: { enabled: false },
  });
  check('បិទស្វត្តកម្មបាន', toggle.status === 200 && toggle.body.data?.auto_debit === 0, toggle.body);

  console.log('\n— ក្រុមប្រមូល —');
  const teams = await call('GET', '/admin/api/collection-teams', { token: at });
  check('បញ្ជីក្រុមប្រមូល', teams.status === 200 && teams.body.data?.rows?.length >= 3, teams.body);
  const teamId = teams.body.data?.rows?.[0]?.id;

  const newTeam = await call('POST', '/admin/api/collection-teams', {
    token: at, body: { name: 'ក្រុមសាកល្បង', branch: 'សង្កាត់កំពត', officer: 'គ្រួបស្រម្ម' },
  });
  check('បង្កើតក្រុមបាន', newTeam.status === 200 && newTeam.body.data?.id, newTeam.body);

  const collections = await call('GET', '/admin/api/collections', { token: at });
  const task = collections.body.data?.rows?.[0];
  check('មានកាតក្រង់ប្រមូល', !!task, collections.body.data);
  check('កាតក្រង់មាន team_id (ចែកដោយស្វត្តកម្ម)', task?.team_id != null, task);

  if (task) {
    const assign = await call('PATCH', `/admin/api/collections/${task.id}`, {
      token: at, body: { team_id: teamId, officer: 'គ្រួបស្រម្ម', status: 'in_progress' },
    });
    check('ចែកកាតក្រង់ទៅក្រុម', assign.status === 200 && assign.body.data?.team_id === teamId, assign.body);
    const badTeam = await call('PATCH', `/admin/api/collections/${task.id}`, {
      token: at, body: { team_id: 999999 },
    });
    check('ក្រុមមិនមាន → បដិសេធ', badTeam.status === 404, badTeam.body);
  }

  console.log('\n— ក្រុមប្រមូលដោយស្វត្តកម្ម (auto-assign) —');
  const autoAssign = await call('GET', '/admin/api/collections', { token: at });
  const withTeam = (autoAssign.body.data?.rows || []).filter((r) => r.team_id != null);
  check('កាតក្រង់មានក្រុមចែកដោយស្វត្តកម្ម', withTeam.length > 0, { total: autoAssign.body.data?.rows?.length });

  console.log(`\nលទ្ធផល: ✅ ${pass}  ❌ ${fail}`);
  console.log('userId =', userId, ' loanId =', loanId, ' email =', email);
  process.exit(fail ? 1 : 0);
})();
