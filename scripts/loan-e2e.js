// E2E សម្រាប់កម្មវិធីកម្ចី — ដំណើរពេញ: KYC → សាកលកម្ម → វាយតម្លៃ → អនុមត្ត → បញ្ចូល → បង់ → របាយការណ៍
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
  const email = `loan.tester.${stamp}@aura.test`;
  const pin = '1234';

  console.log('\n— អ្នកប្រើ + KYC —');
  const reg = await call('POST', '/auth/register', {
    body: { name: 'អ្នកសាកល្បងកម្ចី', email, phone: '+855' + (10000000 + (stamp % 89999999)), pin },
  });
  check('ចុះឈ្មោះបាន', reg.status === 200 && reg.body.data?.token, reg.body);
  const token = reg.body.data?.token;
  if (!token) { console.log('stop'); process.exit(1); }
  const userId = reg.body.data.user.id;

  const kycMissing = await call('POST', '/loan/kyc', {
    token, body: { full_name: 'x', submit: true },
  });
  check('KYC មិនពេញត្រូវបដិសេធ', kycMissing.status === 400, kycMissing.body);

  const kyc = await call('POST', '/loan/kyc', {
    token,
    body: {
      full_name: 'អ្នកសាកល្បងកម្ចី', national_id: 'N123456789', dob: '1995-05-10',
      gender: 'male', phone: '+85512345678', address: 'ភ្នំពេញ',
      occupation: 'អ្នកបើកសាង', business_name: 'ហាងលាក់', business_type: 'លាក់',
      business_years: 4, monthly_income: 900, monthly_expense: 400, existing_debt: 100,
      bank_name: 'ABA', bank_account: '12345678', submit: true,
    },
  });
  check('KYC ដាក់ស្នើបាន', kyc.status === 200 && kyc.body.data?.status === 'submitted', kyc.body);

  console.log('\n— សាកលកម្ម —');
  const applyNoKyc = await call('POST', '/loan/apply', { token, body: {} });
  check('អ្នកប្រើដែលគ្មាន KYC ត្រូវបដិសេធ', applyNoKyc.status === 400, applyNoKyc.body);

  const quote = await call('POST', '/loan/quote', {
    token, body: { principal: 3000, months: 12, annual_rate: 18, interest_method: 'annuity' },
  });
  check('quote គណនាបាន', quote.status === 200 && quote.body.data?.rows?.length === 12, quote.body);
  const quoteMonthly = quote.body.data?.monthly_payment;
  console.log('     ប្រាក់ប្រចាំខែ =', quoteMonthly, '| សរុប =', quote.body.data?.total_payable);

  const apply = await call('POST', '/loan/apply', {
    token,
    body: {
      principal: 3000, months: 12, annual_rate: 18, interest_method: 'annuity',
      province: 'ភ្នំពេញ', district: 'មហាវត្ត', commune: 'ចំការថន', village: 'ភូមិ',
      purpose: 'ពង្រីងស្តុក',
    },
  });
  check('សាកលកម្មបាន', apply.status === 200 && apply.body.data?.status === 'submitted', apply.body);
  const loanId = apply.body.data?.id;

  const dup = await call('POST', '/loan/apply', {
    token, body: { principal: 1000, months: 6, annual_rate: 18, province: 'a', district: 'b', commune: 'c', village: 'd' },
  });
  check('សាកលកម្មទី២ត្រូវបដិសេធ (LOAN_EXISTS)', dup.status === 400 && dup.body.code === 'LOAN_EXISTS', dup.body);

  console.log('\n— Admin —');
  const adminLogin = await call('POST', '/admin/api/login', {
    body: { email: 'admin@local.dev', password: 'local-dev-admin' },
  });
  check('admin ចូលបាន', adminLogin.status === 200 && adminLogin.body.data?.token, adminLogin.body);
  const at = adminLogin.body.data?.token;
  if (!at) { process.exit(1); }

  const list1 = await call('GET', '/admin/api/loans', { token: at });
  check('បញ្ជីកម្ចីមានសាកលកម្ម', list1.body.data?.rows?.some((r) => r.id === loanId), list1.body);

  const score = await call('POST', `/admin/api/loans/${loanId}/score`, { token: at });
  check('វាយតម្លៃបាន', score.status === 200 && typeof score.body.data?.score === 'number', score.body);
  console.log('     score =', score.body.data?.score, 'band =', score.body.data?.band, '| cbc =', score.body.data?.cbc?.status);

  const approve = await call('POST', `/admin/api/loans/${loanId}/approve`, {
    token: at,
    body: { months: 12, annual_rate: 18, interest_method: 'annuity', fee_percent: 2, account_verified: true },
  });
  check('អនុមត្តបាន', approve.status === 200, approve.body);
  check('បង្កើតតារាង 12 វីនុបទ', approve.body.data?.schedule_count === 12, approve.body.data);

  const schedule = await call('GET', `/admin/api/loans/${loanId}/schedule`, { token: at });
  check('តារាងសងប្រាក់មាន 12 ជួរ', schedule.body.data?.rows?.length === 12, schedule.body);
  const rows = schedule.body.data?.rows || [];
  if (rows.length) {
    const sumDue = rows.reduce((s, r) => s + Number(r.total_due), 0);
    const sumPrincipal = rows.reduce((s, r) => s + Number(r.principal_part), 0);
    check('សរុបប្រាក់ធ្នាក់ = ប្រាក់ដាក់', Math.abs(sumPrincipal - 3000) < 0.05, { sumPrincipal });
    check('សរុបតារាង = total_payable', Math.abs(sumDue - Number(approve.body.data?.total_payable || 0)) < 0.05, { sumDue, payable: approve.body.data?.total_payable });
    console.log('     វីនុបទទី 1:', rows[0].total_due, '| កាលបរិច្ឆេទ:', String(rows[0].due_date).slice(0, 10));
  }

  const appSchedule = await call('GET', '/loan/schedule', { token });
  check('app ឃើញតារាងសងប្រាក់', appSchedule.body.data?.rows?.length === 12, appSchedule.body);

  console.log('\n— បញ្ចូលស្រាប់ —');
  const disburse = await call('POST', `/admin/api/loans/${loanId}/disburse`, { token: at, body: {} });
  check('បញ្ចូលស្រាប់បាន', disburse.status === 200, disburse.body);
  const fee = Number(approve.body.data?.fee_amount || 0);
  check('ប្រាក់បញ្ចូល = ប្រាក់ដាក់ − ថ្លៃ', Math.abs(Number(disburse.body.data?.net_disbursed) - (3000 - fee)) < 0.05, disburse.body.data);

  console.log('\n— បង់ប្រាក់ —');
  const pay = await call('POST', '/loan/pay', { token, body: {} });
  check('បង់វីនុបទទី 1 បាន', pay.status === 200 && pay.body.data?.paid === 1, pay.body);
  check('ប្រាក់ដាក់ធ្លាក់ត្រូវ 1', pay.body.data?.amount === Number(rows[0]?.total_due), pay.body.data);

  const payTooMuch = await call('POST', '/loan/pay', { token, body: { amount: 99999 } });
  check('បង់ច្រើនជាងវីនុបទត្រូវបដិសេធ', payTooMuch.status === 400, payTooMuch.body);

  const after = await call('GET', '/loan/schedule', { token });
  const paidRow = after.body.data?.rows?.find((r) => r.installment_no === 1);
  check('វីនុបទទី 1 បានសង់', paidRow?.status === 'paid', paidRow);

  console.log('\n— របាយការណ៍ —');
  const portfolio = await call('GET', '/admin/api/reports/portfolio', { token: at });
  check('របាយ portfolio', portfolio.status === 200 && portfolio.body.data?.totals, portfolio.body);
  const income = await call('GET', '/admin/api/reports/income', { token: at });
  check('របាយ income', income.status === 200 && income.body.data?.interest, income.body);
  const npl = await call('GET', '/admin/api/reports/npl', { token: at });
  check('របាយ NPL', npl.status === 200 && npl.body.data?.buckets, npl.body);
  const collections = await call('GET', '/admin/api/collections', { token: at });
  check('បញ្ជី Collections', collections.status === 200 && Array.isArray(collections.body.data?.rows), collections.body);

  console.log(`\nលទ្ធផល: ✅ ${pass}  ❌ ${fail}`);
  console.log('userId =', userId, ' loanId =', loanId, ' email =', email);
  process.exit(fail ? 1 : 0);
})();
