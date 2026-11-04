// ============================================================
// LOAN ADMIN API — សម្រាប់ Admin Dashboard
// Pipeline → វាយតម្លៃ → អនុមត្ត (បង្កើតតារាងសងប្រាក់) → បញ្ចូលស្រាប់ → ប្រមូល → របាយការណ៍
// ============================================================
const express = require('express');
const {
  money, INTEREST_METHODS, LOAN_STATUSES, MAX_LOAN, OPEN_STATUSES,
  buildSchedule, computeScore,
  cbcCheck, syncArrears, applyLoanPayment, runAutoDebit,
  SCORE_BANDS,
} = require('./loan-engine');

module.exports = function createLoanAdminRouter(ctx) {
  const { db, ok, ApiError, handle, adminAuth, audit, bumpVersion, sendPushNotification } = ctx;
  const router = express.Router();

  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  };
  const int = (v, def = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const like = (s) => `%${String(s).toLowerCase().replace(/[%_]/g, '')}%`;

  const loanCols = `l.*, u.name AS user_name, u.email AS user_email,
    u.phone AS user_phone, u.avatar_thumb, u.is_locked`;

  // ---------- បញ្ជីកម្ចី + Pipeline ----------
  router.get('/loans', adminAuth, handle(async (req, res) => {
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();
    const where = [];
    const params = [];
    if (status && status !== 'all') {
      if (LOAN_STATUSES.includes(status)) { where.push('l.status = ?'); params.push(status); }
    }
    if (q) {
      where.push('(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(u.phone) LIKE ?)');
      const l = like(q);
      params.push(l, l, l);
    }
    const sql = `SELECT ${loanCols},
        (SELECT COUNT(*) FROM loan_schedules s WHERE s.loan_id = l.id) AS schedule_count,
        (SELECT COUNT(*) FROM loan_schedules s WHERE s.loan_id = l.id AND s.status = 'paid') AS paid_count,
        (SELECT COUNT(*) FROM loan_schedules s WHERE s.loan_id = l.id AND s.status = 'overdue') AS overdue_count
      FROM loans l JOIN users u ON u.id = l.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.id DESC LIMIT 300`;
    const rows = await db.prepare(sql).all(...params);

    const counts = await db.prepare(
      `SELECT status, COUNT(*) AS n FROM loans GROUP BY status`
    ).all();
    const byStatus = Object.fromEntries(LOAN_STATUSES.map((s) => [s, 0]));
    for (const c of counts) byStatus[c.status] = Number(c.n);

    ok(res, { rows, by_status: byStatus });
  }));

  // ---------- ព័ត៌មានលម្អិត ----------
  router.get('/loans/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare(
      `SELECT ${loanCols} FROM loans l JOIN users u ON u.id = l.user_id WHERE l.id = ?`
    ).get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    const kyc = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?')
      .get(loan.user_id);
    const schedule = await db.prepare(
      'SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY installment_no'
    ).all(id);
    const payments = await db.prepare(
      'SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY id DESC LIMIT 100'
    ).all(id);
    const collections = await db.prepare(
      'SELECT * FROM loan_collections WHERE loan_id = ? ORDER BY id DESC'
    ).all(id);
    let scoreDetail = null;
    try { scoreDetail = loan.score_detail ? JSON.parse(loan.score_detail) : null; } catch {}
    ok(res, { loan, kyc, schedule, payments, collections, score_detail: scoreDetail });
  }));

  // ---------- វាយតម្លៃឥណទិសជាតិ + CBC ----------
  router.post('/loans/:id/score', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    const kyc = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?')
      .get(loan.user_id);
    const user = await db.prepare(`
      SELECT (SELECT COUNT(*) FROM loans WHERE user_id = ? AND id <> ?
                AND status <> 'rejected') AS loan_count,
             (SELECT COUNT(*) FROM loans WHERE user_id = ? AND id <> ?
                AND status = 'closed') AS closed_count
      FROM users WHERE id = ?`).get(loan.user_id, id, loan.user_id, id, loan.user_id);

    const result = computeScore({
      principal: loan.principal, months: loan.months, annualRate: loan.annual_rate,
      method: loan.interest_method, kyc, user,
    });

    let cbc = { status: loan.cbc_status, reference: loan.cbc_reference };
    if (req.body.check_cbc !== false) {
      cbc = await cbcCheck({
        nationalId: kyc?.national_id, phone: kyc?.phone,
      });
    }

    await db.prepare(`UPDATE loans SET score = ?, score_band = ?, score_detail = ?,
      cbc_status = ?, cbc_reference = ?, cbc_checked_at = ?, status = CASE
        WHEN status = 'submitted' THEN 'under_review' ELSE status END,
      updated_at = now() WHERE id = ?`)
      .run(result.score, result.band, JSON.stringify(result.parts),
        cbc.status, cbc.reference, new Date(), id);

    await audit(req, 'score_loan', 'loans', id,
      `score=${result.score} band=${result.band} cbc=${cbc.status}`);
    ok(res, { ...result, cbc, bands: SCORE_BANDS });
  }));

  // ---------- អនុមត្ត → បង្កើតតារាងសងប្រាក់តាមខែ ----------
  router.post('/loans/:id/approve', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    if (!['submitted', 'under_review'].includes(loan.status))
      throw new ApiError('ស្ថានភាពកម្ចីមិនអនុញ្ញាតឲ្យអនុមត្ត', 400, 'BAD_STATUS');

    const months = req.body.months !== undefined
      ? int(req.body.months, loan.months) : loan.months;
    const annualRate = req.body.annual_rate !== undefined
      ? (num(req.body.annual_rate) ?? loan.annual_rate) : loan.annual_rate;
    const method = req.body.interest_method && INTEREST_METHODS.includes(req.body.interest_method)
      ? req.body.interest_method : loan.interest_method;
    const feePercent = req.body.fee_percent !== undefined
      ? money(num(req.body.fee_percent) || 0) : Number(loan.fee_percent || 0);
    const principal = money(loan.principal);

    if (!(months >= 1) || months > 60)
      throw new ApiError('រយៈខែត្រូវតែក្នុងចន្លោះ 1 – 60', 400, 'BAD_MONTHS');
    if (annualRate < 0 || annualRate > 60)
      throw new ApiError('កាន្លោះត្រូវតែក្នុងចន្លោះ 0 – 60%', 400, 'BAD_RATE');
    if (feePercent < 0 || feePercent > 20)
      throw new ApiError('ថ្លៃសេវកម្មត្រូវតែក្នុងចន្លោះ 0 – 20%', 400, 'BAD_FEE');

    const firstDue = req.body.first_due_date
      ? new Date(req.body.first_due_date)
      : new Date(Date.now() + 30 * 86400000);
    if (Number.isNaN(firstDue.getTime()))
      throw new ApiError('កាលបរិច្ឆេទបង់ដំបូងមិនត្រឹមត្រាន', 400, 'BAD_DATE');

    const feeAmount = money(principal * feePercent / 100);
    const quote = buildSchedule({
      principal, months, annualRate, method,
      firstDueDate: firstDue, feeAmount: 0,
    });

    const created = await db.transaction(async () => {
      await db.prepare('DELETE FROM loan_schedules WHERE loan_id = ?').run(id);
      for (const r of quote.rows) {
        await db.prepare(`INSERT INTO loan_schedules
          (loan_id, installment_no, due_date, principal_part, interest_part,
           fee_part, total_due, paid_amount, status)
          VALUES (?, ?, ?, ?, ?, 0, ?, 0, 'pending')`)
          .run(id, r.installment_no, r.due_date, r.principal_part,
            r.interest_part, r.total_due);
      }
      await db.prepare(`UPDATE loans SET status = 'approved', months = ?,
        annual_rate = ?, interest_method = ?, fee_percent = ?, fee_amount = ?,
        monthly_payment = ?, total_interest = ?, total_payable = ?,
        outstanding = ?, first_due_date = ?, approved_at = now(),
        account_verified = ?, auto_debit = ?, reject_reason = NULL, updated_at = now()
        WHERE id = ?`)
        .run(months, annualRate, method, feePercent, feeAmount,
          quote.monthly_payment, quote.total_interest, quote.total_payable,
          quote.total_payable, firstDue, req.body.account_verified ? 1 : 0,
          req.body.auto_debit ? 1 : 0, id);
      return quote.rows.length;
    });

    await bumpVersion(loan.user_id);
    await audit(req, 'approve_loan', 'loans', id,
      `${principal} / ${months} ខែ / ${annualRate}% / ${method} / តារាង ${created} វីនុបទ`);
    sendPushNotification(loan.user_id, 'កម្ចីត្រូវបានអនុមត្ត',
      `តារាងសងប្រាក់តាមខែរបស់អ្នកត្រូវបានបង្កើត (${created} វីនុបទ)`,
      { type: 'loan_approved', id });

    ok(res, {
      id, schedule_count: created, monthly_payment: quote.monthly_payment,
      total_interest: quote.total_interest, total_payable: quote.total_payable,
      fee_amount: feeAmount, first_due_date: firstDue,
    });
  }));

  // ---------- បដិសេធ ----------
  router.post('/loans/:id/reject', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    if (!['submitted', 'under_review'].includes(loan.status))
      throw new ApiError('ស្ថានភាពកម្ចីមិនអនុញ្ញាតឲ្យបដិសេធ', 400, 'BAD_STATUS');
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason)
      throw new ApiError('សូមសម្គាល់មូលហេតុបដិសេធ', 400, 'BAD_INPUT');
    await db.prepare(`UPDATE loans SET status = 'rejected', reject_reason = ?,
      updated_at = now() WHERE id = ?`).run(reason, id);
    await db.prepare('DELETE FROM loan_schedules WHERE loan_id = ?').run(id);
    await bumpVersion(loan.user_id);
    await audit(req, 'reject_loan', 'loans', id, reason);
    sendPushNotification(loan.user_id, 'សាកលកម្មកម្ចីត្រូវបានបដិសេធ',
      reason, { type: 'loan_rejected', id });
    ok(res, { id, status: 'rejected' });
  }));

  // ---------- បញ្ចូលស្រាប់ (កាតថ្លៃសេវកម្ម) ----------
  router.post('/loans/:id/disburse', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    if (loan.status !== 'approved')
      throw new ApiError('ត្រូវអនុមត្តជាមុនសិន', 400, 'BAD_STATUS');
    if (!loan.account_verified && req.body.account_verified !== true)
      throw new ApiError('ត្រូវផ្ទៀងផ្ទាត់គណនីបញ្ចូលប្រាក់ជាមុន', 400, 'ACCOUNT_NOT_VERIFIED');

    const cardId = int(req.body.card_id, 0);
    const card = cardId
      ? await db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(cardId, loan.user_id)
      : await db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(loan.user_id);
    if (!card) throw new ApiError('អ្នកប្រើគ្មានកាតសម្រាប់ទទួលប្រាក់', 400, 'NO_CARD');

    const fee = money(loan.fee_amount);
    const net = money(Number(loan.principal) - fee);
    if (net <= 0)
      throw new ApiError('ចំនួនប្រាក់បញ្ចូលស្រាប់មិនគវ្គ្រាន', 400, 'BAD_AMOUNT');

    await db.transaction(async () => {
      await db.prepare(
        'UPDATE cards SET balance = ROUND(balance + ?, 2) WHERE id = ?'
      ).run(net, card.id);
      await db.prepare(`INSERT INTO transactions
        (user_id, card_id, title, category, amount, is_expense, icon_code)
        VALUES (?, ?, ?, 'បញ្ចូលស្រាប់កម្ចី', ?, 0, 24)`)
        .run(loan.user_id, card.id, `បញ្ចូលស្រាប់កម្ចី #${loan.id}`, net);
      await db.prepare(`UPDATE loans SET status = 'disbursed', active = 1,
        disbursed_at = now(), account_verified = 1, outstanding = total_payable,
        auto_debit_card_id = ?, updated_at = now() WHERE id = ?`).run(card.id, id);
    });

    await bumpVersion(loan.user_id);
    await audit(req, 'disburse_loan', 'loans', id,
      `net=$${net} fee=$${fee} card=${card.id}`);
    sendPushNotification(loan.user_id, 'ស្រាប់កម្ចីបានបញ្ចូល',
      `ប្រាក់ $${net.toFixed(2)} បានបញ្ចូលទៅកាតរបស់អ្នក`, { type: 'loan_disbursed', id });
    ok(res, { id, status: 'disbursed', net_disbursed: net, fee });
  }));

  // ---------- បង់ប្រាក់ (សាច់ការ) ----------
  router.post('/loans/:id/repay', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    if (!['disbursed', 'active'].includes(loan.status))
      throw new ApiError('កម្ចីមិនទាន់បញ្ចូល', 400, 'BAD_STATUS');
    const amount = money(num(req.body.amount) || 0);
    if (!(amount > 0))
      throw new ApiError('ចំនួនលុយត្រូវតែ > 0', 400, 'BAD_AMOUNT');

    const rows = await db.prepare(
      `SELECT * FROM loan_schedules WHERE loan_id = ? AND status IN ('pending','partial','overdue')
       ORDER BY installment_no`
    ).all(id);
    if (!rows.length)
      throw new ApiError('តារាងសងប្រាក់ត្រូវបានបង់គ្រប់រាល់', 400, 'NO_DUE');

    if (!(amount > 0))
      throw new ApiError('ចំនួនលុយត្រូវតែ > 0', 400, 'BAD_AMOUNT');

    const result = await applyLoanPayment({
      db, loan, amount, rows, card: null, method: 'cash',
      reference: 'ADM-' + Date.now(),
    });
    if (result.error)
      throw new ApiError('ចំនួនប្រាក់ត្រូវតែ > 0', 400, 'BAD_AMOUNT');
    const total = result.total;

    await bumpVersion(loan.user_id);
    await audit(req, 'repay_loan', 'loans', id, `$${total}`);
    sendPushNotification(loan.user_id, 'បង់រំលោះកម្ចី',
      `បង់បាន $${total.toFixed(2)}`, { type: 'loan_paid' });
    ok(res, { id, amount: total, paid: result.paidInstallments, outstanding: result.outstanding, closed: result.closed });
  }));

  // ---------- តារាងសងប្រាក់ ----------
  router.get('/loans/:id/schedule', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const rows = await db.prepare(
      'SELECT * FROM loan_schedules WHERE loan_id = ? ORDER BY installment_no'
    ).all(id);
    ok(res, { rows });
  }));

  // ---------- ការប្រមូល (Collections) ----------
  router.get('/collections', adminAuth, handle(async (req, res) => {
    const status = String(req.query.status || '').trim();
    const where = [];
    const params = [];
    if (status && status !== 'all') { where.push('c.status = ?'); params.push(status); }
    const rows = await db.prepare(`
      SELECT c.*, u.name AS user_name, u.phone AS user_phone, u.email AS user_email,
             u.avatar_thumb, l.principal, l.monthly_payment, l.annual_rate,
             t.name AS team_name, t.officer AS team_officer
      FROM loan_collections c
      JOIN users u ON u.id = c.user_id
      JOIN loans l ON l.id = c.loan_id
      LEFT JOIN collection_teams t ON t.id = c.team_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.days_arrears DESC, c.id DESC LIMIT 300
    `).all(...params);
    const counts = await db.prepare(
      'SELECT status, COUNT(*) AS n FROM loan_collections GROUP BY status'
    ).all();
    ok(res, {
      rows,
      by_status: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    });
  }));

  router.patch('/collections/:id', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const task = await db.prepare('SELECT * FROM loan_collections WHERE id = ?').get(id);
    if (!task) throw new ApiError('រកមិនឃើញកាតក្រង់', 404, 'NOT_FOUND');
    const fields = [];
    const values = [];
    const push = (c, v) => { fields.push(`${c} = ?`); values.push(v); };
    if (req.body.status !== undefined) {
      const st = String(req.body.status);
      if (!['open', 'in_progress', 'resolved', 'written_off'].includes(st))
        throw new ApiError('ស្ថានភាពមិនត្រឹមត្រាន', 400, 'BAD_STATUS');
      push('status', st);
    }
    if (req.body.officer !== undefined) push('officer', String(req.body.officer || '').slice(0, 80));
    if (req.body.priority !== undefined) {
      const p = String(req.body.priority);
      if (!['low', 'normal', 'high'].includes(p))
        throw new ApiError('អាទិភាពមិនត្រឹមត្រាន', 400, 'BAD_PRIORITY');
      push('priority', p);
    }
    if (req.body.notes !== undefined) push('notes', String(req.body.notes || '').slice(0, 500));
    if (req.body.next_action_date !== undefined)
      push('next_action_date', req.body.next_action_date ? new Date(req.body.next_action_date) : null);
    if (req.body.team_id !== undefined) {
      const teamId = req.body.team_id === null ? null : int(req.body.team_id);
      if (teamId) {
        const team = await db.prepare('SELECT id FROM collection_teams WHERE id = ?').get(teamId);
        if (!team) throw new ApiError('រកមិនឃើញក្រុមប្រមូល', 404, 'NOT_FOUND');
      }
      push('team_id', teamId);
    }
    if (!fields.length) throw new ApiError('គ្មានអ្វីត្រូវកែប្ដូរ', 400, 'NOTHING_TO_UPDATE');
    push('contact_count', Number(task.contact_count || 0) + 1);
    push('last_action', req.body.last_action || `កែប្ដូរដោយ ${req.admin?.email || 'admin'}`);
    push('updated_at', new Date());
    values.push(id);
    await db.prepare(`UPDATE loan_collections SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
    await audit(req, 'update_collection', 'loan_collections', id, fields.map((f) => f.split(' = ')[0]).join(','));
    ok(res, await db.prepare('SELECT * FROM loan_collections WHERE id = ?').get(id));
  }));

  // ---------- បង់ស្វត្តកម្ម (Auto-debit) ----------
  router.patch('/loans/:id/auto-debit', adminAuth, handle(async (req, res) => {
    const id = int(req.params.id);
    const loan = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
    if (!loan) throw new ApiError('រកមិនឃើញកម្ចី', 404, 'NOT_FOUND');
    if (!['disbursed', 'active'].includes(loan.status))
      throw new ApiError('កម្ចីមិនទាន់បញ្ចូល', 400, 'BAD_STATUS');
    const enabled = req.body.enabled === true;
    await db.prepare('UPDATE loans SET auto_debit = ?, updated_at = now() WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    await audit(req, 'toggle_auto_debit', 'loans', id, enabled ? 'on' : 'off');
    ok(res, { id, auto_debit: enabled ? 1 : 0 });
  }));

  router.post('/loans/run-auto-debit', adminAuth, handle(async (req, res) => {
    const out = await runAutoDebit(db, {
      sendPushNotification, bumpVersion,
    });
    await audit(req, 'run_auto_debit', 'loans', 0,
      `${out.results.filter((r) => r.status === 'paid').length} វីនុបទបានបង់`);
    ok(res, out);
  }));

  // ---------- ទទួលកម្ចីដោយ Credit Officer (CO) ----------
  router.post('/loans/intake', adminAuth, handle(async (req, res) => {
    const b = req.body || {};
    const userId = int(b.user_id);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new ApiError('រកមិនឃើញអ្នកប្រើ', 404, 'USER_NOT_FOUND');

    const kyc = await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?').get(userId);
    if (!kyc || !['submitted', 'verified'].includes(kyc.status))
      throw new ApiError('អ្នកប្រើមិនទាន់ដាក់ KYC', 400, 'KYC_REQUIRED');
    const missing = ['full_name', 'national_id', 'phone', 'address', 'occupation',
      'bank_name', 'bank_account'].filter((k) => !String(kyc[k] || '').trim());
    if (missing.length)
      throw new ApiError('ព័ត៌មាន KYC មិនពេញលេញ (' + missing.join(', ') + ')',
        400, 'KYC_INCOMPLETE');

    const coName = String(b.co_name || '').trim().slice(0, 80);
    if (!coName)
      throw new ApiError('សូមបំពេញឈ្មោះ Credit Officer', 400, 'BAD_INPUT');

    const principal = money(num(b.principal) || 0);
    const months = parseInt(b.months, 10);
    const annualRate = num(b.annual_rate);
    const method = INTEREST_METHODS.includes(b.interest_method) ? b.interest_method : 'annuity';
    if (!(principal > 0) || principal > MAX_LOAN)
      throw new ApiError(`ចំនួនកម្ចីត្រូវតែក្នុងចន្លោះ $0.01 – $${MAX_LOAN}`, 400, 'BAD_AMOUNT');
    if (!(months >= 1) || months > 60)
      throw new ApiError('រយៈខែត្រូវតែក្នុងចន្លោះ 1 – 60', 400, 'BAD_MONTHS');
    if (annualRate === null || annualRate < 0 || annualRate > 60)
      throw new ApiError('កាន្លោះត្រូវតែក្នុងចន្លោះ 0 – 60%', 400, 'BAD_RATE');

    const open = await db.prepare(
      `SELECT id FROM loans WHERE user_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) LIMIT 1`
    ).get(userId, ...OPEN_STATUSES);
    if (open)
      throw new ApiError('អ្នកប្រើមានសាកលកម្មកម្ចីដែលកំពុងដំណើរការ', 400, 'LOAN_EXISTS');

    const addr = ['province', 'district', 'commune', 'village']
      .map((k) => String(b[k] || '').trim().slice(0, 100));
    if (addr.some((s) => !s))
      throw new ApiError('សូមបំពេញទីតាំងខេត្ត ស្រុក ឃុំ ភូមិ', 400, 'BAD_ADDRESS');

    const feePercent = money(num(b.fee_percent) || 0);
    const quote = buildSchedule({ principal, months, annualRate, method });

    const loanId = await db.transaction(async () => {
      const info = await db.prepare(`INSERT INTO loans
        (user_id, principal, months, annual_rate, province, district, commune, village,
         status, channel, co_name, co_phone, co_branch, interest_method, fee_percent, fee_amount,
         monthly_payment, total_interest, total_payable, outstanding,
         purpose, monthly_income, monthly_expense, bank_name, bank_account, account_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'co', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        RETURNING id`)
        .run(userId, principal, months, annualRate, ...addr,
          coName, String(b.co_phone || '').trim().slice(0, 30) || null,
          String(b.co_branch || '').trim().slice(0, 80) || null,
          method, feePercent, 0,
          quote.monthly_payment, quote.total_interest, quote.total_payable, principal,
          String(b.purpose || '').trim().slice(0, 200),
          money(kyc.monthly_income), money(kyc.monthly_expense),
          kyc.bank_name, kyc.bank_account);
      return info.lastInsertRowid;
    });

    await bumpVersion(userId);
    await audit(req, 'intake_loan', 'loans', loanId, `CO ${coName} · ${principal} / ${months} ខែ`);
    ok(res, {
      id: loanId, status: 'submitted', channel: 'co',
      monthly_payment: quote.monthly_payment,
      total_payable: quote.total_payable,
    });
  }));

  // ---------- ក្រុមប្រមូល ----------
  router.get('/collection-teams', adminAuth, handle(async (req, res) => {
    const rows = await db.prepare(
      'SELECT * FROM collection_teams ORDER BY active DESC, name'
    ).all();
    const load = await db.prepare(
      `SELECT team_id, COUNT(*) AS n FROM loan_collections
        WHERE status IN ('open','in_progress') AND team_id IS NOT NULL
        GROUP BY team_id`
    ).all();
    const counts = Object.fromEntries(load.map((l) => [l.team_id, Number(l.n)]));
    ok(res, { rows: rows.map((r) => ({ ...r, open_tasks: counts[r.id] || 0 })) });
  }));

  router.post('/collection-teams', adminAuth, handle(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new ApiError('សូមបំពេញឈ្មោះក្រុម', 400, 'BAD_INPUT');
    const info = await db.prepare(
      'INSERT INTO collection_teams (name, branch, officer, phone) VALUES (?, ?, ?, ?) RETURNING id'
    ).run(name, String(b.branch || '').trim().slice(0, 80) || null,
      String(b.officer || '').trim().slice(0, 80) || null,
      String(b.phone || '').trim().slice(0, 30) || null);
    await audit(req, 'create_collection_team', 'collection_teams', info.lastInsertRowid, name);
    ok(res, await db.prepare('SELECT * FROM collection_teams WHERE id = ?')
      .get(info.lastInsertRowid));
  }));

  // ---------- របាយការណ៍ ----------
  router.get('/reports/portfolio', adminAuth, handle(async (req, res) => {
    const totals = await db.prepare(`
      SELECT COUNT(*) AS n_loans,
             COALESCE(SUM(CASE WHEN status IN ('disbursed','active') THEN principal ELSE 0 END),0) AS disbursed,
             COALESCE(SUM(CASE WHEN status IN ('disbursed','active') THEN outstanding ELSE 0 END),0) AS outstanding,
             COALESCE(SUM(CASE WHEN status IN ('disbursed','active') THEN total_interest ELSE 0 END),0) AS interest_booked,
             COALESCE(AVG(CASE WHEN status IN ('disbursed','active') THEN principal END),0) AS avg_size
      FROM loans`).get();
    const byStatus = await db.prepare(
      'SELECT status, COUNT(*) AS n, COALESCE(SUM(outstanding),0) AS outstanding FROM loans GROUP BY status'
    ).all();
    const byMethod = await db.prepare(`
      SELECT interest_method, COUNT(*) AS n FROM loans
      WHERE status IN ('disbursed','active') GROUP BY interest_method`).all();
    ok(res, { totals, by_status: byStatus, by_method: byMethod });
  }));

  router.get('/reports/income', adminAuth, handle(async (req, res) => {
    const interest = await db.prepare(`
      SELECT COALESCE(SUM(interest_part),0) AS interest,
             COALESCE(SUM(principal_part),0) AS principal,
             COALESCE(SUM(amount),0) AS total
      FROM loan_payments`).get();
    const fees = await db.prepare(`
      SELECT COALESCE(SUM(fee_amount),0) AS fees FROM loans
      WHERE status IN ('disbursed','active','closed')`).get();
    const monthly = await db.prepare(`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COALESCE(SUM(amount),0) AS total
      FROM loan_payments GROUP BY 1 ORDER BY 1 DESC LIMIT 12`).all();
    ok(res, { interest, fees, monthly });
  }));

  router.get('/reports/npl', adminAuth, handle(async (req, res) => {
    await syncArrears(db);
    const npl = await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(outstanding),0) AS outstanding
      FROM loans WHERE npl = 1`).get();
    const buckets = await db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE days_late BETWEEN 1 AND 30) AS d1_30,
        COUNT(*) FILTER (WHERE days_late BETWEEN 31 AND 60) AS d31_60,
        COUNT(*) FILTER (WHERE days_late BETWEEN 61 AND 89) AS d61_89,
        COUNT(*) FILTER (WHERE days_late >= 90) AS d90_plus,
        COALESCE(SUM(total_due - paid_amount) FILTER (WHERE days_late BETWEEN 1 AND 30),0) AS amt_d1_30,
        COALESCE(SUM(total_due - paid_amount) FILTER (WHERE days_late BETWEEN 31 AND 60),0) AS amt_d31_60,
        COALESCE(SUM(total_due - paid_amount) FILTER (WHERE days_late BETWEEN 61 AND 89),0) AS amt_d61_89,
        COALESCE(SUM(total_due - paid_amount) FILTER (WHERE days_late >= 90),0) AS amt_d90_plus
      FROM loan_schedules WHERE status IN ('pending','partial','overdue')`).get();
    const loans = await db.prepare(`
      SELECT l.id, l.principal, l.outstanding, l.arrears_days, l.monthly_payment,
             u.name AS user_name, u.phone AS user_phone
      FROM loans l JOIN users u ON u.id = l.user_id
      WHERE l.npl = 1 ORDER BY l.arrears_days DESC LIMIT 100`).all();
    ok(res, { npl, buckets, loans });
  }));

  // ---------- KYC ការត្រួតពិនិត្យ ----------
  router.get('/kyc', adminAuth, handle(async (req, res) => {
    const rows = await db.prepare(`
      SELECT k.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
             u.avatar_thumb
      FROM loan_kyc k JOIN users u ON u.id = k.user_id
      ORDER BY CASE k.status WHEN 'submitted' THEN 0 ELSE 1 END, k.updated_at DESC
      LIMIT 200`).all();
    ok(res, { rows });
  }));

  router.patch('/kyc/:userId', adminAuth, handle(async (req, res) => {
    const userId = int(req.params.userId);
    const status = String(req.body.status || '');
    if (!['draft', 'submitted', 'verified', 'rejected'].includes(status))
      throw new ApiError('ស្ថានភាពមិនត្រឹមត្រាន', 400, 'BAD_STATUS');
    const notes = String(req.body.notes || '').slice(0, 300);
    await db.prepare(`UPDATE loan_kyc SET status = ?, notes = ?,
      verified_at = CASE WHEN ? = 'verified' THEN now() ELSE verified_at END,
      verified_by = ?, updated_at = now() WHERE user_id = ?`)
      .run(status, notes, status, req.admin?.email || 'admin', userId);
    await bumpVersion(userId);
    await audit(req, 'update_kyc', 'loan_kyc', userId, status);
    ok(res, await db.prepare('SELECT * FROM loan_kyc WHERE user_id = ?').get(userId));
  }));

  return router;
};
