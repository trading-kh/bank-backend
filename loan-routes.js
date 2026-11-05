// ============================================================
// LOAN APP API — សម្រាប់ App ទូរសែព្យ
// KYC → សាកលកម្ម → រង់ចាំអនុមត្ត → បង់តារាងសងប្រាក់
// mount: app.use(createLoanAppRouter(ctx))
// ============================================================
const express = require('express');
const crypto = require('crypto');
const {
  money, INTEREST_METHODS, MAX_LOAN, OPEN_STATUSES, buildSchedule, computeScore,
  cbcCheck, syncArrears, applyLoanPayment,
} = require('./loan-engine');

const MAX_MONTHS = 60;
const KYC_REQUIRED = [
  'full_name', 'national_id', 'phone', 'province', 'district', 'commune', 'village',
];

module.exports = function createLoanAppRouter(ctx) {
  const { db, ok, ApiError, handle, auth, sendPushNotification, unlockAchievement } = ctx;
  const router = express.Router();

  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  };
  const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);

  // ---------- KYC ----------
  router.get('/loan/kyc', auth, handle(async (req, res) => {
    const kyc = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?')
      .get(req.userId);
    ok(res, kyc || null);
  }));

  router.post('/loan/kyc', auth, handle(async (req, res) => {
    const b = req.body || {};
    const existing = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?')
      .get(req.userId);
    if (existing?.status === 'verified')
      throw new ApiError('ព័ត៌មាន KYC ត្រូវបានផ្ទៀងផ្ទាត់រួចហើយ', 400, 'KYC_LOCKED');

    const fields = {
      full_name: str(b.full_name, 80),
      national_id: str(b.national_id, 30),
      dob: str(b.dob, 20) || null,
      gender: str(b.gender, 10) || null,
      phone: str(b.phone, 30),
      province: str(b.province, 80),
      district: str(b.district, 80),
      commune: str(b.commune, 80),
      village: str(b.village, 80),
      birth_place: str(b.birth_place, 200),
      occupation: str(b.occupation, 60),
      business_name: str(b.business_name, 100),
      business_type: str(b.business_type, 60),
      business_years: money(num(b.business_years) || 0),
      monthly_income: money(num(b.monthly_income) || 0),
      monthly_expense: money(num(b.monthly_expense) || 0),
      existing_debt: money(num(b.existing_debt) || 0),
      bank_name: str(b.bank_name, 80),
      bank_account: str(b.bank_account, 40),
      doc_type: str(b.doc_type, 40),
      doc_number: str(b.doc_number, 40),
    };
    const submit = b.submit === true;
    if (submit) {
      const missing = KYC_REQUIRED.filter((k) => !fields[k]);
      if (missing.length)
        throw new ApiError('សូមបំពេញព័ត៌មានមុនចំនួន៖ ' + missing.join(', '),
          400, 'KYC_INCOMPLETE');
    }
    const status = submit ? 'submitted' : 'draft';
    const values = Object.values(fields);
    const cols = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    if (existing) {
      await db.prepare(`UPDATE loan_kyc SET ${cols}, status = ?,
        submitted_at = CASE WHEN ? = 'submitted' THEN now() ELSE submitted_at END,
        updated_at = now() WHERE user_id = ?`)
        .run(...values, status, status, req.userId);
    } else {
      await db.prepare(`INSERT INTO loan_kyc
        (${Object.keys(fields).join(', ')}, status, submitted_at, user_id)
        VALUES (${Object.keys(fields).map(() => '?').join(', ')}, ?, ?, ?)`)
        .run(...values, status, submit ? new Date() : null, req.userId);
    }
    ok(res, await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?').get(req.userId));
  }));

  // ---------- QUOTE (មិនរក្សាទុក) ----------
  router.post('/loan/quote', auth, handle(async (req, res) => {
    const principal = money(num(req.body.principal) || 0);
    const months = parseInt(req.body.months, 10) || 12;
    const annualRate = num(req.body.annual_rate) ?? 12;
    const method = INTEREST_METHODS.includes(req.body.interest_method)
      ? req.body.interest_method : 'annuity';
    const feePercent = money(num(req.body.fee_percent) || 0);
    if (!(principal > 0) || principal > MAX_LOAN)
      throw new ApiError('ចំនួនកម្ចីមិនត្រឹមត្រាន', 400, 'BAD_AMOUNT');
    const fee = money(principal * feePercent / 100);
    const quote = buildSchedule({
      principal, months, annualRate, method, feeAmount: fee,
    });
    ok(res, {
      ...quote,
      net_disbursed: money(principal - fee),
      rows: quote.rows.slice(0, 12),
      row_count: quote.rows.length,
    });
  }));

  // ---------- សាកលកម្ម ----------
  const applyHandler = handle(async (req, res) => {
    const b = req.body || {};
    const kyc = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?')
      .get(req.userId);
    if (!kyc || !['submitted', 'verified'].includes(kyc.status))
      throw new ApiError('សូមបំពេញ KYC ជាមុនសិន', 400, 'KYC_REQUIRED');
    const missing = KYC_REQUIRED.filter((k) => !String(kyc[k] || '').trim());
    if (missing.length)
      throw new ApiError('ព័ត៌មាន KYC មិនពេញលេញ (' + missing.join(', ') + ')',
        400, 'KYC_INCOMPLETE');

    const principal = money(num(b.principal) || 0);
    const months = parseInt(b.months, 10);
    const annualRate = num(b.annual_rate);
    const method = INTEREST_METHODS.includes(b.interest_method) ? b.interest_method : 'annuity';
    const addr = ['province', 'district', 'commune', 'village'].map((k) => str(b[k], 100));
    if (!(principal > 0) || principal > MAX_LOAN)
      throw new ApiError(`ចំនួនកម្ចីត្រូវក្នុងចន្លោះ $0.01 – $${MAX_LOAN}`, 400, 'BAD_AMOUNT');
    if (!(months >= 1) || months > MAX_MONTHS)
      throw new ApiError(`រយៈខែត្រូវក្នុងចន្លោះ 1 – ${MAX_MONTHS}`, 400, 'BAD_MONTHS');
    if (annualRate === null || annualRate < 0 || annualRate > 60)
      throw new ApiError('កាន្លោះត្រូវក្នុងចន្លោះ 0 – 60%', 400, 'BAD_RATE');
    if (addr.some((s) => !s))
      throw new ApiError('សូមជ្រើសរើសទីតាំងខេត្ត ស្រុក ឃុំ ភូមិ', 400, 'BAD_ADDRESS');

    const open = await db.prepare(
      `SELECT id FROM loans WHERE user_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) LIMIT 1`
    ).get(req.userId, ...OPEN_STATUSES);
    if (open)
      throw new ApiError('អ្នកមានសាកលកម្មកម្ចីដែលកំពុងដំណើរការ', 400, 'LOAN_EXISTS');

    const feePercent = money(num(b.fee_percent) || 0);
    const channel = 'online';   // តែតែចូលបន្ថែមដោយ Credit Officer (admin) ទេដែលកំណត់ channel='co'
    const quote = buildSchedule({ principal, months, annualRate, method });

    const loanId = await db.transaction(async () => {
      const info = await db.prepare(`INSERT INTO loans
        (user_id, principal, months, annual_rate, province, district, commune, village, birth_place,
         status, channel, co_name, co_phone, interest_method, fee_percent, fee_amount,
         monthly_payment, total_interest, total_payable, outstanding,
         purpose, monthly_income, monthly_expense, bank_name, bank_account, account_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`)
        .run(req.userId, principal, months, annualRate, ...addr, str(kyc.birth_place, 200),
          channel, null, null,
          method, feePercent, 0,
          quote.monthly_payment, quote.total_interest, quote.total_payable, principal,
          str(b.purpose, 200), money(kyc.monthly_income), money(kyc.monthly_expense),
          kyc.bank_name, kyc.bank_account, 0);
      return info.lastInsertRowid;
    });

    await db.prepare('UPDATE users SET data_version = data_version + 1 WHERE id = ?')
      .run(req.userId);
    ok(res, {
      id: loanId, status: 'submitted',
      monthly_payment: quote.monthly_payment,
      total_payable: quote.total_payable,
    });
  });

  router.post('/loan/apply', auth, applyHandler);
  // តាមដែលជា API ចាស់ (POST /loan) → ប្រើការដាក់សាកលកម្មដូចខាងលើ
  router.post('/loan', auth, applyHandler);

  // ---------- បញ្ជីកម្ចី ----------
  router.get('/loans', auth, handle(async (req, res) => {
    const rows = await db.prepare(
      `SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC LIMIT 50`
    ).all(req.userId);
    ok(res, { rows });
  }));

  router.get('/loan', auth, handle(async (req, res) => {
    const loan = await db.prepare(
      `SELECT * FROM loans WHERE user_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       ORDER BY id DESC LIMIT 1`
    ).get(req.userId, ...OPEN_STATUSES);
    ok(res, loan || null);
  }));

  router.get('/loan/schedule', auth, handle(async (req, res) => {
    const loan = await db.prepare(
      `SELECT * FROM loans WHERE user_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
       ORDER BY id DESC LIMIT 1`
    ).get(req.userId, ...OPEN_STATUSES);
    if (!loan) return ok(res, { loan: null, rows: [], payments: [] });
    const rows = await db.prepare(
      'SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY installment_no'
    ).all(loan.id);
    const payments = await db.prepare(
      'SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY id DESC LIMIT 100'
    ).all(loan.id);
    ok(res, { loan, rows, payments });
  }));

  // ---------- បង់ប្រាក់ ----------
  router.post('/loan/pay', auth, handle(async (req, res) => {
    const loan = await db.prepare(
      `SELECT * FROM loans WHERE user_id = ? AND status IN ('disbursed', 'active')
       ORDER BY id DESC LIMIT 1`
    ).get(req.userId);
    if (!loan)
      throw new ApiError('មិនមានកម្ចីដែលអាចបង់បាន', 400, 'NO_ACTIVE_LOAN');

    const rows = await db.prepare(
      `SELECT * FROM loan_schedules WHERE loan_id = ? AND status IN ('pending', 'partial', 'overdue')
       ORDER BY installment_no`
    ).all(loan.id);
    if (!rows.length)
      throw new ApiError('តារាងសងប្រាក់ត្រូវបានបង់គ្រប់រាល់', 400, 'NO_DUE');

    const next = rows[0];
    const remaining = money(next.total_due - next.paid_amount);
    const requested = num(req.body.amount);
    const amount = money(requested === null || requested === undefined
      ? remaining : requested);
    if (!(amount > 0))
      throw new ApiError('ចំនួនបង់ត្រូវជាចំនួនលុយ', 400, 'BAD_AMOUNT');
    if (amount > remaining + 0.009)
      throw new ApiError(`វីនុបទទី ${next.installment_no} ត្រូវបង់តែ $${remaining.toFixed(2)}`,
        400, 'AMOUNT_TOO_LARGE');

    const cardId = parseInt(req.body.card_id, 10);
    const card = Number.isInteger(cardId)
      ? await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, req.userId)
      : await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(req.userId);
    if (!card) throw new ApiError('រកមិនឃើញកាតសម្រាប់បង់ប្រាក់', 400, 'NO_CARD');
    if (Number(card.balance) < amount)
      throw new ApiError('សម្រាកលុយក្នុងកាតមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');

    const ref = crypto.randomUUID();
    let result;
    try {
      result = await applyLoanPayment({
        db, loan, amount, card, method: 'card', reference: ref,
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_FUNDS')
        throw new ApiError('សម្រាកលុយមិនគ្រប់គ្រាន់', 400, 'INSUFFICIENT_FUNDS');
      throw e;
    }
    if (result.error === 'NO_DUE')
      throw new ApiError('តារាងសងប្រាក់ត្រូវបានបង់គ្រប់រាល់', 400, 'NO_DUE');
    if (result.error)
      throw new ApiError('ចំនួនបង់ត្រូវជាចំនួនលុយ', 400, 'BAD_AMOUNT');

    const totalApplied = result.total;
    const applied = result.applied;

    await db.prepare('UPDATE users SET data_version = data_version + 1 WHERE id = ?')
      .run(req.userId);

    await unlockAchievement(req.userId, 'first_loan');
    sendPushNotification(req.userId, 'បង់រំលោះកម្ចី',
      `បង់បាន $${totalApplied.toFixed(2)}`, { type: 'loan_paid' });

    ok(res, {
      paid: result.paidInstallments,
      months: loan.months,
      amount: totalApplied,
      outstanding: result.outstanding,
      closed: result.closed,
      installments: applied.map((a) => ({
        installment_no: a.installment_no, amount: a.amount, status: a.status,
      })),
    });
  }));

  // ---------- បង់ស្វត្តកម្ម (Auto-debit) ----------
  router.post('/loan/auto-debit', auth, handle(async (req, res) => {
    const loan = await db.prepare(
      `SELECT * FROM loans WHERE user_id = ? AND status IN ('disbursed', 'active')
       ORDER BY id DESC LIMIT 1`
    ).get(req.userId);
    if (!loan)
      throw new ApiError('មិនមានកម្ចីដែលអាចកំណត់ស្វត្តកម្ម', 400, 'NO_ACTIVE_LOAN');
    const enabled = req.body.enabled === true;
    await db.prepare('UPDATE loans SET auto_debit = ?, updated_at = now() WHERE id = ?')
      .run(enabled ? 1 : 0, loan.id);
    ok(res, { id: loan.id, auto_debit: enabled ? 1 : 0 });
  }));

  // ---------- ស្ទង់ភាពការបង់យឺតពេក ----------
  router.post('/loan/sync', auth, handle(async (req, res) => {
    await syncArrears(db);
    ok(res, { synced: true });
  }));

  return router;
};

module.exports.LOAN_STATUSES = OPEN_STATUSES;
module.exports.MAX_LOAN = MAX_LOAN;
