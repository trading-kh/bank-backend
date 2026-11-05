// ============================================================
// LOAN ENGINE — កម្មវិធីកម្ចីវីក្រុយ (Microfinance)
// រួមមាន: គំរូកម្ចី (schema), កាល្បងបុព្វប្បតិច (interest engine),
// ក្រុមវាយតម្លៃឥណទិសជាតិ (scorecard), CBC adapter, ការតាមដានកង់បង់យឺតពេក (arrears/NPL)
// ============================================================
const money = (v) => Math.round(Number(v) * 100) / 100;

const INTEREST_METHODS = ['flat', 'annuity', 'reducing'];
const LOAN_STATUSES = [
  'submitted', 'under_review', 'approved', 'rejected',
  'disbursed', 'active', 'closed',
];
const SCORE_BANDS = [
  { band: 'A', min: 80, max: 100, label: 'A — ល្អណាស់' },
  { band: 'B', min: 65, max: 79, label: 'B — ល្អ' },
  { band: 'C', min: 50, max: 64, label: 'C — មិនទេ' },
  { band: 'D', min: 0, max: 49, label: 'D — មិនមានសមត្ថភាព' },
];

const NPL_DAYS = 90;          // ≥ 90 ថ្ងៃកុនជា NPL
const D1_D4_DAYS = 30;        // ការព្យាយាមបង់យឺត 1–30 ថ្ងៃ
const D5_PLUS_DAYS = 60;      // ការព្យាយាមបង់យឺត 31–60 ថ្ងៃ
const MAX_LOAN = 50000;
const OPEN_STATUSES = ['submitted', 'under_review', 'approved', 'disbursed', 'active'];

// ============================================================
// SCHEMA
// ============================================================
async function initLoanSchema(db) {
  await db.exec(`
    -- កម្ចីអនុញ្ញាតបន្ថែម (ALTER មានតែពេលក្រុមចូលដែលមាន column ទាំងអស់)
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'online';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS co_name TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS co_phone TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS co_branch TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_method TEXT NOT NULL DEFAULT 'annuity';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS fee_percent DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS fee_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_payment DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_interest DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_payable DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS outstanding DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS score INTEGER;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS score_band TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS score_detail TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS cbc_status TEXT NOT NULL DEFAULT 'unavailable';
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS cbc_reference TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS cbc_checked_at TIMESTAMPTZ;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS bank_name TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS bank_account TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS account_verified INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS purpose TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_income DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_expense DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS reject_reason TEXT;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS first_due_date TIMESTAMPTZ;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS auto_debit_card_id INTEGER;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS arrears_days INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS npl INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE loans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    -- KYC / CRM
    CREATE TABLE IF NOT EXISTS loan_kyc (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      national_id TEXT NOT NULL DEFAULT '',
      dob TEXT,
      gender TEXT,
      phone TEXT,
      province TEXT,
      district TEXT,
      commune TEXT,
      village TEXT,
      occupation TEXT,
      business_name TEXT,
      business_type TEXT,
      business_years DOUBLE PRECISION NOT NULL DEFAULT 0,
      monthly_income DOUBLE PRECISION NOT NULL DEFAULT 0,
      monthly_expense DOUBLE PRECISION NOT NULL DEFAULT 0,
      existing_debt DOUBLE PRECISION NOT NULL DEFAULT 0,
      bank_name TEXT,
      bank_account TEXT,
      doc_type TEXT,
      doc_number TEXT,
      id_front TEXT,
      id_back TEXT,
      selfie TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      submitted_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      verified_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id)
    );

    -- តារាងសងប្រាក់តាមខែ (បង្កើតពេលអនុមត្តដោយជោគជ័យ)
    CREATE TABLE IF NOT EXISTS loan_schedules (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      installment_no INTEGER NOT NULL,
      due_date TIMESTAMPTZ NOT NULL,
      principal_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      interest_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_due DOUBLE PRECISION NOT NULL DEFAULT 0,
      paid_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      paid_at TIMESTAMPTZ,
      days_late INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(loan_id, installment_no)
    );

    -- កំណត់ចំនាំការបង់ប្រាក់
    CREATE TABLE IF NOT EXISTS loan_payments (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER,
      amount DOUBLE PRECISION NOT NULL,
      principal_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      interest_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_part DOUBLE PRECISION NOT NULL DEFAULT 0,
      method TEXT NOT NULL DEFAULT 'card',
      installment_no INTEGER,
      status TEXT NOT NULL DEFAULT 'paid',
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ការគ្រប់គ្រងការប្រមូលស្តុក
    CREATE TABLE IF NOT EXISTS loan_collections (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      schedule_id INTEGER,
      officer TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      days_arrears INTEGER NOT NULL DEFAULT 0,
      amount_due DOUBLE PRECISION NOT NULL DEFAULT 0,
      contact_count INTEGER NOT NULL DEFAULT 0,
      last_action TEXT,
      next_action_date TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ក្រុមប្រមូល (Collection team) — សម្រាប់ចែកកាតក្រង់ទៅក្រុម
    CREATE TABLE IF NOT EXISTS collection_teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      branch TEXT,
      officer TEXT,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE loan_collections ADD COLUMN IF NOT EXISTS team_id INTEGER
      REFERENCES collection_teams(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_schedules_loan ON loan_schedules(loan_id, installment_no);
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON loan_schedules(status, due_date);
    CREATE INDEX IF NOT EXISTS idx_payments_loan ON loan_payments(loan_id);
    CREATE INDEX IF NOT EXISTS idx_collections_status ON loan_collections(status, priority);
  `);

  // ក្រុមប្រមូលដែលមានស្រាប់ទុកជាការព្រាង
  const teams = await db.prepare('SELECT COUNT(*) AS n FROM collection_teams').get();
  if (Number(teams.n) === 0) {
    for (const t of [
      { name: 'ក្រុមប្រមូលទី១', branch: 'សង្កាត់កណ្តាល' },
      { name: 'ក្រុមប្រមូលទី២', branch: 'សង្កាត់ចំការដ្ឋាន' },
      { name: 'ក្រុមប្រមូលទី៣', branch: 'សង្កាត់កំពត' },
    ]) {
      await db.prepare('INSERT INTO collection_teams (name, branch) VALUES (?, ?)')
        .run(t.name, t.branch);
    }
  }
}

// ============================================================
// INTEREST ENGINE
// ============================================================
// គណនាតារាងសងប្រាក់តាមខែ។
function buildSchedule({
  principal, months, annualRate, method = 'annuity',
  firstDueDate = null, feeAmount = 0,
}) {
  const P = money(principal);
  const n = Math.max(1, Math.min(120, parseInt(months, 10) || 1));
  const rate = Math.max(0, Number(annualRate) || 0) / 100 / 12;
  const m = INTEREST_METHODS.includes(method) ? method : 'annuity';

  // ថ្ងៃបង់ដំបូង = កាលបរិច្ឆេទវីនុបទទី១ ផ្ទាល់ (លុយបង់ដំបូងក្នុង 30 ថ្ងៃ)
  const start = firstDueDate
    ? new Date(firstDueDate) : new Date(Date.now() + 30 * 86400000);
  const dueDate = (i) => {
    const d = new Date(start.getTime());
    d.setMonth(d.getMonth() + (i - 1));
    return d;
  };

  const rows = [];
  let balance = P;
  let totalInterest = 0;

  if (m === 'annuity') {
    const pmt = rate === 0
      ? P / n
      : (P * rate) / (1 - Math.pow(1 + rate, -n));
    for (let i = 1; i <= n; i++) {
      const interest = money(balance * rate);
      let principalPart = money(pmt - interest);
      if (i === n) principalPart = money(balance);       // សម្រុបការដល់កន្លែង
      principalPart = Math.min(principalPart, balance);
      balance = money(balance - principalPart);
      totalInterest += interest;
      rows.push({
        installment_no: i, due_date: dueDate(i),
        principal_part: principalPart, interest_part: interest,
        fee_part: 0, total_due: money(principalPart + interest),
      });
    }
  } else if (m === 'flat') {
    const interestPer = money(P * rate);
    const principalPer = money(P / n);
    for (let i = 1; i <= n; i++) {
      const principalPart = i === n ? money(balance) : principalPer;
      balance = money(balance - principalPart);
      totalInterest += interestPer;
      rows.push({
        installment_no: i, due_date: dueDate(i),
        principal_part: principalPart, interest_part: interestPer,
        fee_part: 0, total_due: money(principalPart + interestPer),
      });
    }
  } else {
    // reducing — ប្រាក់ដាក់ថ្នាក់គិតលើ សម្រាប់តុលាន់នៅសម្រាប់
    const principalPer = money(P / n);
    for (let i = 1; i <= n; i++) {
      const interest = money(balance * rate);
      const principalPart = i === n ? money(balance) : principalPer;
      balance = money(balance - principalPart);
      totalInterest += interest;
      rows.push({
        installment_no: i, due_date: dueDate(i),
        principal_part: principalPart, interest_part: interest,
        fee_part: 0, total_due: money(principalPart + interest),
      });
    }
  }

  // កែកំណត់ត្រូវងាកលើសចុងក្រោយ ឲ្យសមាញាងជារួមត្រូវស្មើរាងដល់ចុងក្រោយ
  if (rows.length) {
    const sum = rows.reduce((s, r) => s + r.principal_part + r.interest_part, 0);
    const diff = money(P + totalInterest - sum);
    const last = rows[rows.length - 1];
    last.principal_part = money(last.principal_part + diff);
    last.total_due = money(last.principal_part + last.interest_part);
    totalInterest = money(totalInterest);
  }

  // ថ្លៃសេវកម្ម បន្ថែមទៅ វីនុបទទី១ (បើកម្មជាម៉ាស៊ីន)
  const fee = money(feeAmount || 0);
  if (fee > 0 && rows.length) {
    rows[0].fee_part = fee;
    rows[0].total_due = money(rows[0].total_due + fee);
  }

  const totalPayable = money(rows.reduce((s, r) => s + r.total_due, 0));
  return {
    method: m, rows,
    monthly_payment: rows.length ? rows[0].total_due : 0,
    total_interest: totalInterest,
    total_payable: totalPayable,
    fee_amount: fee,
  };
}

// ============================================================
// CREDIT SCORECARD (rule-based, 0–100)
// ============================================================
function scoreBand(score) {
  const s = SCORE_BANDS.find((b) => score >= b.min && score <= b.max) || SCORE_BANDS[3];
  return s.band;
}

function computeScore({ principal, months, annualRate, method, kyc, user }) {
  const parts = [];
  let score = 0;

  const income = money(kyc?.monthly_income || 0);
  const expense = money(kyc?.monthly_expense || 0);
  const debt = money(kyc?.existing_debt || 0);

  const quote = buildSchedule({ principal, months, annualRate, method });
  const monthly = quote.monthly_payment || 0;

  // 1) សមត្ថភាពសង្គ្រាប់ការបង់ប្រាក់ (អតិបរមាន 30)
  let p = 0;
  if (income > 0 && monthly > 0) {
    const ratio = monthly / income;
    if (ratio <= 0.2) p = 30;
    else if (ratio <= 0.3) p = 26;
    else if (ratio <= 0.4) p = 21;
    else if (ratio <= 0.5) p = 14;
    else if (ratio <= 0.6) p = 7;
    else p = 0;
  } else {
    p = 10;   // គ្មានប្រាក់ចូល បញ្ជាក់មិនបាន
  }
  parts.push({ key: 'capacity', label: 'សមត្ថភាពសង្គ្រាប់ការបង់', points: p, max: 30 });
  score += p;

  // 2) ចំនួនឥណទិសជាតិ (DTI) (អតិបរមាន 20)
  p = 0;
  if (income > 0) {
    const dti = (expense + debt) / income;
    if (dti <= 0.3) p = 20;
    else if (dti <= 0.5) p = 15;
    else if (dti <= 0.7) p = 9;
    else if (dti <= 0.9) p = 4;
    else p = 0;
  } else {
    p = 6;
  }
  parts.push({ key: 'dti', label: 'ចំនួនឥណទិសជាតិ', points: p, max: 20 });
  score += p;

  // 3) ភាពពេញលេញនៃ KYC (អតិបរមាន 20)
  const need = ['full_name', 'national_id', 'phone', 'address', 'occupation',
    'bank_name', 'bank_account', 'business_name'];
  const filled = need.filter((k) => String(kyc?.[k] || '').trim().length > 1).length;
  p = Math.round((filled / need.length) * 20);
  if (kyc?.status === 'verified') p = Math.min(20, p + 3);
  parts.push({ key: 'kyc', label: 'ភាពពេញលេញនៃ KYC', points: p, max: 20 });
  score += p;

  // 4) ប្រវត្តិសម្រាប់អាជីវណ៍ (អតិបរមាន 15)
  p = 0;
  const years = Number(kyc?.business_years || 0);
  if (years >= 3) p = 15;
  else if (years >= 2) p = 12;
  else if (years >= 1) p = 8;
  else if (years > 0) p = 4;
  parts.push({ key: 'business', label: 'ប្រវត្តិសម្រាប់អាជីវណ៍', points: p, max: 15 });
  score += p;

  // 5) ប្រវត្តិការបង់កម្ចីមុន (អតិបរមាន 15)
  p = user?.loan_count ? 15
    : (user?.closed_count || user?.has_closed_loan) ? 10 : 0;
  parts.push({ key: 'history', label: 'ប្រវត្តិការបង់កម្ចី', points: p, max: 15 });
  score += p;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = scoreBand(score);
  return {
    score, band,
    recommendation:
      score >= 65 ? 'approve' :
      score >= 50 ? 'review' : 'reject',
    parts,
    monthly_payment: monthly,
  };
}

// ============================================================
// CBC ADAPTER (Credit Bureau Cambodia)
// ============================================================
async function cbcCheck({ nationalId, phone }) {
  const url = process.env.CBC_API_URL;
  const key = process.env.CBC_API_KEY;
  if (!url || !key) {
    return { status: 'unavailable', reference: null, raw: null };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ national_id: nationalId, phone }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { status: 'error', reference: null, raw: null };
    }
    const data = await res.json().catch(() => ({}));
    const raw = data.score ?? data.risk_score ?? null;
    const hit = Number(raw) >= 60;
    return {
      status: hit ? 'hit' : 'clear',
      reference: data.reference || data.report_id || null,
      raw,
    };
  } catch (e) {
    console.error('❌ CBC check failed:', e.message);
    return { status: 'error', reference: null, raw: null };
  }
}

// ============================================================
// ARREARS / NPL SYNC
// ============================================================
// សម្គាល់វីនុបទផុតកំណត់ និងបង្កើតកាតក្រង់សម្រាប់ការប្រមូល
async function syncArrears(db) {
  const rows = await db.prepare(`
    SELECT s.id, s.loan_id, s.due_date, s.total_due, s.paid_amount,
           l.user_id, l.npl, l.arrears_days
    FROM loan_schedules s JOIN loans l ON l.id = s.loan_id
    WHERE s.status IN ('pending', 'partial')
      AND s.due_date < now()
  `).all();

  let worst = 0;
  for (const s of rows) {
    const days = Math.floor(
      (Date.now() - new Date(s.due_date).getTime()) / 86400000
    );
    const status = s.paid_amount >= s.total_due ? 'paid' : 'overdue';
    await db.prepare(
      'UPDATE loan_schedules SET status = ?, days_late = ? WHERE id = ?'
    ).run(status, days, s.id);
    if (status === 'overdue' && days > worst) worst = days;

    if (status === 'overdue') {
      const existing = await db.prepare(
        'SELECT id FROM loan_collections WHERE schedule_id = ? AND status IN (?, ?)'
      ).get(s.id, 'open', 'in_progress');
      if (!existing) {
        const priority = days >= D5_PLUS_DAYS ? 'high'
          : days >= D1_D4_DAYS ? 'normal' : 'low';
        // ចែកកាតក្រង់ទៅក្រុមប្រមូលដែលមានការងារបន្ថែមតិចបំផុត
        const team = await db.prepare(`
          SELECT t.id FROM collection_teams t WHERE t.active = 1
           ORDER BY (SELECT COUNT(*) FROM loan_collections c
                      WHERE c.team_id = t.id AND c.status IN ('open','in_progress')) ASC,
                    t.id LIMIT 1`).get();
        await db.prepare(`
          INSERT INTO loan_collections
            (loan_id, user_id, schedule_id, team_id, status, priority, days_arrears, amount_due, notes)
          VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
        `).run(s.loan_id, s.user_id, s.id, team?.id ?? null, priority, days,
          money(s.total_due - s.paid_amount),
          `វីនុបទទី ${s.id} ផុតកំណត់ ${days} ថ្ងៃ`);
      }
    }
  }

  // ធ្វើបច្ចុប្បន្នភាព arrears_days / NPL សម្រាប់កម្ចីទាំងអស់
  const loans = await db.prepare(`
    SELECT l.id, l.npl,
      COALESCE(MAX(s.days_late), 0) AS worst_days,
      COALESCE(SUM(s.total_due - s.paid_amount) FILTER (
        WHERE s.status IN ('pending', 'partial', 'overdue')), 0) AS outstanding
    FROM loans l LEFT JOIN loan_schedules s ON s.loan_id = l.id
    WHERE l.status IN ('approved', 'disbursed', 'active')
    GROUP BY l.id
  `).all();

  for (const l of loans) {
    const days = Math.max(0, Number(l.worst_days) || 0);
    const npl = days >= NPL_DAYS ? 1 : 0;
    const outstanding = money(l.outstanding);
    if (days !== l.arrears_days || npl !== l.npl ||
        Math.abs(outstanding - (l.outstanding ?? 0)) > 0.009) {
      await db.prepare(
        'UPDATE loans SET arrears_days = ?, npl = ?, outstanding = ?, updated_at = now() WHERE id = ?'
      ).run(days, npl, outstanding, l.id);
    }
  }
  return { scanned: rows.length, worst };
}

// ============================================================
// PAYMENT ALLOCATION
// ============================================================
// ចែកលុយបង់ទៅវីនុបទតាមក្រុម (FIFO) តាមមុន→ក្រោយ
function allocatePayment(rows, amount) {
  let left = money(amount);
  const applied = [];
  const ordered = [...rows].sort((a, b) =>
    a.installment_no - b.installment_no);
  for (const r of ordered) {
    if (left <= 0) break;
    const due = money(r.total_due - r.paid_amount);
    if (due <= 0) continue;
    const use = money(Math.min(due, left));
    left = money(left - use);
    const paid = money(r.paid_amount + use);
    const principalPart = money(
      Math.min(r.principal_part, use + (r.paid_amount - r.interest_part - r.fee_part))
    );
    const interestPart = money(use - principalPart);
    applied.push({
      schedule_id: r.id, installment_no: r.installment_no,
      amount: use, principal_part: principalPart,
      interest_part: interestPart, fee_part: 0,
      paid_amount: paid,
      status: paid >= money(r.total_due) ? 'paid'
        : paid > 0 ? 'partial' : 'pending',
    });
  }
  return { applied, remaining: left };
}

// ============================================================
// APPLY PAYMENT — ប្រើរួមដោយ App (បង់ដោយដៃ) និង auto-debit
// ============================================================
// បង់ប្រាក់ទៅវីនុបទតាមក្រុម (FIFO) — កាតក្រង់ត្រូវបានបញ្ចូលក្នុង transaction តែមួយ
async function applyLoanPayment({ db, loan, amount, card = null, method = 'card', reference, rows: preRows = null }) {
  const rows = preRows || await db.prepare(
    `SELECT * FROM loan_schedules
      WHERE loan_id = ? AND status IN ('pending', 'partial', 'overdue')
      ORDER BY installment_no`
  ).all(loan.id);
  if (!rows.length) return { error: 'NO_DUE' };

  const { applied, remaining } = allocatePayment(rows, amount);
  const total = money(amount - remaining);
  if (!(total > 0)) return { error: 'BAD_AMOUNT' };

  const ref = reference || ('ADM-' + Date.now());
  const result = await db.transaction(async () => {
    if (card) {
      const dec = await db.prepare(
        'UPDATE cards SET balance = ROUND(balance - ?, 2) WHERE id = ? AND balance >= ?'
      ).run(total, card.id, total);
      if (dec.changes !== 1) {
        const e = new Error('INSUFFICIENT_FUNDS');
        e.code = 'INSUFFICIENT_FUNDS';
        throw e;
      }
    }

    for (const a of applied) {
      await db.prepare(`UPDATE loan_schedules
        SET paid_amount = ?, status = ?, days_late = 0,
            paid_at = CASE WHEN ? = 'paid' THEN now() ELSE paid_at END
        WHERE id = ?`)
        .run(a.paid_amount, a.status, a.status, a.schedule_id);
      await db.prepare(`INSERT INTO loan_payments
        (loan_id, user_id, card_id, amount, principal_part, interest_part, fee_part,
         method, installment_no, status, reference)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`)
        .run(loan.id, loan.user_id, card ? card.id : null, a.amount, a.principal_part,
          a.interest_part, a.fee_part, method, a.installment_no, ref);
    }

    if (card) {
      await db.prepare(`INSERT INTO transactions
        (user_id, card_id, title, category, amount, is_expense, icon_code, transfer_ref)
        VALUES (?, ?, ?, 'សងប្រាក់កម្ចី', ?, 1, 24, ?)`)
        .run(loan.user_id, card.id, `បង់កម្ចីវីនុបទទី ${applied[0].installment_no}`, total, ref);
    }

    const totals = await db.prepare(
      `SELECT COALESCE(SUM(total_due), 0) AS total,
              COALESCE(SUM(paid_amount), 0) AS paid
       FROM loan_schedules WHERE loan_id = ?`
    ).get(loan.id);
    const paidInstallments = await db.prepare(
      `SELECT COUNT(*) AS n FROM loan_schedules
       WHERE loan_id = ? AND status = 'paid'`
    ).get(loan.id);
    const outstanding = money(Number(totals.total) - Number(totals.paid));
    const closed = paidInstallments.n >= loan.months && outstanding <= 0.009;
    await db.prepare(
      'UPDATE loans SET paid = ?, outstanding = ?, active = ?, status = ?, updated_at = now() WHERE id = ?'
    ).run(paidInstallments.n, outstanding, closed ? 0 : 1,
      closed ? 'closed' : 'active', loan.id);

    return {
      outstanding, closed, paidInstallments: paidInstallments.n,
      applied, total, reference: ref,
    };
  });
  return result;
}

// ============================================================
// AUTO-DEBIT — បង់ស្វត្តកម្មពេលវីនុបទដល់កាល
// ============================================================
// ដកកាតដាក់ស្វត្តកម្មដោយស្វាស្ត្រាប់វីនុបទដែលដល់កាលហើយ —
// បើសម្រាកលុយមិនគ្រប់គ្រាន់ វីនុបទត្រូវបានទុកឱ្យការប្រមូលដោយស្វត្តកម្ម
async function runAutoDebit(db, ctx = {}) {
  const { sendPushNotification, bumpVersion } = ctx;
  const loans = await db.prepare(`
    SELECT * FROM loans
     WHERE auto_debit = 1 AND status IN ('disbursed', 'active')
     ORDER BY id`).all();

  const results = [];
  for (const loan of loans) {
    const rows = await db.prepare(
      `SELECT * FROM loan_schedules
        WHERE loan_id = ? AND status IN ('pending', 'partial', 'overdue')
        ORDER BY installment_no`
    ).all(loan.id);
    if (!rows.length) {
      results.push({ loan_id: loan.id, status: 'no_due' });
      continue;
    }

    const next = rows[0];
    const due = money(next.total_due - next.paid_amount);
    if (!(due > 0)) {
      results.push({ loan_id: loan.id, status: 'no_due' });
      continue;
    }
    if (new Date(next.due_date).getTime() > Date.now()) {
      results.push({
        loan_id: loan.id, status: 'not_due',
        installment_no: next.installment_no, due_date: next.due_date,
      });
      continue;
    }

    const card = loan.auto_debit_card_id
      ? await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?')
        .get(loan.auto_debit_card_id, loan.user_id)
      : await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id LIMIT 1')
        .get(loan.user_id);
    if (!card) {
      results.push({ loan_id: loan.id, status: 'no_card' });
      continue;
    }
    if (Number(card.balance) < due) {
      results.push({ loan_id: loan.id, status: 'insufficient_funds', amount: due });
      continue;
    }

    const ref = 'AD-' + Date.now() + '-' + loan.id;
    const res = await applyLoanPayment({
      db, loan, amount: due, card, method: 'auto_debit', reference: ref,
    });
    if (res.error) {
      results.push({ loan_id: loan.id, status: res.error.toLowerCase() });
      continue;
    }

    await db.prepare('UPDATE users SET data_version = data_version + 1 WHERE id = ?')
      .run(loan.user_id);
    if (bumpVersion) await bumpVersion(loan.user_id);
    if (sendPushNotification) {
      sendPushNotification(loan.user_id, 'បង់កម្ចីដោយស្វត្តកម្ម',
        `បង់វីនុបទទី ${next.installment_no} ចំនួន $${due.toFixed(2)}`,
        { type: 'loan_paid' });
    }
    results.push({
      loan_id: loan.id, status: 'paid', amount: res.total,
      installment_no: next.installment_no, outstanding: res.outstanding,
    });
  }
  return { scanned: loans.length, results };
}

module.exports = {
  money, INTEREST_METHODS, LOAN_STATUSES, SCORE_BANDS, MAX_LOAN, OPEN_STATUSES,
  NPL_DAYS, D1_D4_DAYS, D5_PLUS_DAYS,
  initLoanSchema, buildSchedule, computeScore, scoreBand,
  cbcCheck, syncArrears, allocatePayment, applyLoanPayment, runAutoDebit,
};
