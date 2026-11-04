/* ===== Aura Bank Admin — ផ្ទាំងគ្រប់គ្រង ===== */
const API = '/admin/api';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let token = localStorage.getItem('aura_admin_token');
let admin = null;
let page = 'dashboard';
let search = '';
let offset = 0;
const LIMIT = 25;
const userFilters = { status: 'all', sort: 'created', order: 'desc', showAll: false };


/* ---------- utils ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const money0 = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
};
const dt = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return esc(s);
  return d.toLocaleString('km-KH', { dateStyle: 'short', timeStyle: 'short' });
};
const dateOnly = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? esc(s) : d.toLocaleDateString('km-KH', { dateStyle: 'medium' });
};
const initials = (name) => String(name || '?').trim().charAt(0).toUpperCase();

// រូបភាពតូចជា base64 (ដកផ្លូវមិនមាន data: prefix) — រកឃើញប្រភេទដោយស្តាប់ពិត
const thumbSrc = (b64) => {
  if (!b64) return '';
  let mime = 'jpeg';
  try {
    const head = atob(String(b64).slice(0, 16));
    if (head.startsWith('\x89PNG')) mime = 'png';
    else if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') mime = 'webp';
  } catch (_) { /* ប្រើ jpeg ធម្មតា */ }
  return `data:image/${mime};base64,${b64}`;
};

const avatarHtml = (name, thumb, status) => {
  const img = thumb
    ? `<img class="avatar" src="${thumbSrc(thumb)}" alt="">`
    : `<span class="avatar">${esc(initials(name))}</span>`;
  if (status === undefined || status === null) return img;
  return `<span class="avatar-wrap">${img}<span class="dot ${status ? 'on' : 'off'}"></span></span>`;
};

/* ---------- live / offline ---------- */
const liveBadge = (r) => r.online
  ? '<span class="live on"><i></i>Live</span>'
  : '<span class="live off"><i></i>Offline</span>';

const ago = (s) => {
  if (!s) return '—';
  const ms = Date.now() - new Date(s).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'ឥឡូវនេះ';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} វិនាទីមុន`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} នាទីមុន`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ម៉ោងមុន`;
  return `${Math.floor(hr / 24)} ថ្ងៃមុន`;
};

const lastSeenHtml = (r) => r.last_seen_at
  ? `<div class="last-seen">ចុងចាស់ ${ago(r.last_seen_at)}</div>
     <div class="last-seen">${dt(r.last_seen_at)}</div>`
  : '<div class="last-seen">មិនដែលចូលកម្ម</div>';


function toast(msg, type = '') {
  const el = $('#toast');
  el.className = `toast ${type}`;
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401 && token) { logout(); }
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json?.data;
}

/* ---------- modal ---------- */
let modalSaveHandler = null;
function openModal({ title, body, onSave, wide, saveLabel }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  modalSaveHandler = onSave || null;
  $('#modalSave').style.display = onSave ? '' : 'none';
  $('#modalSave').textContent = saveLabel || 'រក្សាទុក';
  $('.modal-box').classList.toggle('wide', !!wide);
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  modalSaveHandler = null;
}
$('#modalClose').onclick = closeModal;
$('#modalCancel').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
$('#modalSave').onclick = async () => {
  if (!modalSaveHandler) return closeModal();
  const btn = $('#modalSave');
  btn.disabled = true;
  try { await modalSaveHandler(); closeModal(); }
  catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; }
};

function confirmDelete(text, fn) {
  openModal({
    title: 'បញ្ជាក់ការលុប',
    body: `<p>${esc(text)}</p><p class="muted">សកម្មនេះមិនអាចត្រឡប់វិញបាន។</p>`,
    onSave: fn,
    saveLabel: 'បញ្ជាក់',
  });
}

function confirmAction(title, text, fn) {
  openModal({
    title,
    body: `<p>${esc(text)}</p>`,
    onSave: fn,
    saveLabel: 'បញ្ជាក់',
  });
}

/* ---------- table ---------- */
function tableHtml(cols, rows, opts = {}) {
  if (!rows.length) return `<div class="empty">${esc(opts.empty || 'មិនទាន់មានទិន្នន័យ')}</div>`;
  const head = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => `<tr ${opts.rowAttr ? opts.rowAttr(r, i) : ''}>${cols
    .map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(r, i)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function pagerHtml(total, currentOffset, limit) {
  const from = total === 0 ? 0 : currentOffset + 1;
  const to = Math.min(currentOffset + limit, total);
  return `<div class="pager">
    <span>បង្ហាញ ${from}–${to} ក្នុងចំនួន ${total}</span>
    <button class="btn ghost sm" data-page-btn="prev" ${currentOffset <= 0 ? 'disabled' : ''}>‹ មុន</button>
    <button class="btn ghost sm" data-page-btn="next" ${to >= total ? 'disabled' : ''}>បន្ទាប់ ›</button>
  </div>`;
}

/* ---------- charts ---------- */
function drawLine(canvas, points, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;

  const padL = 46, padR = 12, padT = 14, padB = 26;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i) => padL + (w - padL - padR) * (points.length === 1 ? .5 : i / (points.length - 1));
  const y = (v) => h - padB - (h - padT - padB) * (v / max);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
  ctx.fillStyle = '#8fa6c4'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (h - padT - padB) * (g / 3);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.fillText(money0(max * (1 - g / 3)), padL - 6, gy + 3);
  }
  // area + line
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, 'rgba(59,154,217,.45)');
  grad.addColorStop(1, 'rgba(59,154,217,0)');
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
  ctx.lineTo(x(points.length - 1), h - padB); ctx.lineTo(x(0), h - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
  ctx.strokeStyle = opts.color || '#3b9ad9'; ctx.lineWidth = 2.2; ctx.stroke();
  // dots + labels
  ctx.fillStyle = opts.color || '#3b9ad9';
  points.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(x(i), y(p.value), 3, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#8fa6c4'; ctx.textAlign = 'center';
  points.forEach((p, i) => {
    if (points.length > 8 && i % 2) return;
    ctx.fillText(p.label, x(i), h - 8);
  });
}

/* ============================================================
   PAGES
   ============================================================ */
const TITLES = {
  dashboard: 'ផ្ទាំងដើម', users: 'អ្នកប្រើ', cards: 'កាត',
  transactions: 'ប្រតិបត្តិការ', loans: 'កម្ចី', notifications: 'សេចក្តីសារ',
  data: 'ទិន្នថយផ្សេង', audit: 'កំណត់ត្រាក្របរបុប',
};

async function renderDashboard() {
  const s = await api('/stats');
  const t = s.totals;
  $('#content').innerHTML = `
    <div class="grid k3">
      <div class="card kpi accent">
        <div class="kpi-label">អ្នកប្រើសរុប</div>
        <div class="kpi-value">${t.users}</div>
        <div class="kpi-sub">ថ្មី ${t.new_users_7d} នាក់ (7 ថ្ងៃ)</div>
      </div>
      <div class="card kpi ok">
        <div class="kpi-label">🟢 កំពុងប្រើឥឡូវ (Live)</div>
        <div class="kpi-value">${t.online_users || 0}</div>
        <div class="kpi-sub">បន្ថែមពេលវេលា ${s.online_minutes || 5} នាទី</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">សម្រាប់ការទាក់ទង</div>
        <div class="kpi-value">${money0(t.total_balance)}</div>
        <div class="kpi-sub">${t.cards} កាត</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">ប្រតិបត្តិការ</div>
        <div class="kpi-value">${t.transactions}</div>
        <div class="kpi-sub">${t.tx_24h} នៅថ្ងៃនេះ</div>
      </div>
      <div class="card kpi warn">
        <div class="kpi-label">កម្ចីកំពុងបញ្ចាស់</div>
        <div class="kpi-value">${money0(t.loan_outstanding)}</div>
        <div class="kpi-sub">${t.active_loans} កម្ចី · ${t.external_transfers} ផ្ទេរក្រៅបទេស</div>
        </div>
      <div class="card kpi">
        <div class="kpi-label">🔒 ត្រូវបានផ្អាក</div>
        <div class="kpi-value">${t.locked_users || 0}</div>
        <div class="kpi-sub">គណនីដែលត្រូវបានផ្អាក</div>

      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>🟢 អ្នកប្រើកំពុងប្រើឥឡូវ</h3>
        <span class="muted">${s.liveUsers.length} នាក់ · បន្ថែមពេលវេលា ${s.online_minutes || 5} នាទី</span></div>
      ${s.liveUsers.length ? `<div class="live-list">${s.liveUsers.map((u) => `
        <span class="live-chip" data-user-view="${u.id}" style="cursor:pointer">
          ${avatarHtml(u.name, u.avatar_thumb, true)}
          <span><b>${esc(u.name)}</b><br><span class="t">ចុងចាស់ ${ago(u.last_seen_at)}</span></span>
        </span>`).join('')}</div>`
        : '<div class="empty">គ្មានអ្នកប្រើកំពុងប្រើឥឡូវ</div>'}
    </div>

    <div class="grid k2">
      <div class="card">
        <div class="card-head"><h3>ចំនួនប្រតិបត្តិការ 14 ថ្ងៃ</h3>
          <span class="muted">ចំនួន ${t.tx_24h} ថ្ងៃនេះ · ចំនួនប្រាក់ ${money0(t.spend_30d)} (30 ថ្ងៃ)</span>
        </div>
        <div class="chart-box"><canvas id="txChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>ប្រតិបត្តិការដែលចំណាយច្រើនបំផុត</h3></div>
        <div class="bars" id="catBars"></div>
      </div>
    </div>

    <div class="grid k2">
      <div class="card">
        <div class="card-head"><h3>អ្នកប្រើថ្មីៗ</h3></div>
        ${tableHtml([
    { label: 'ឈ្មោះ', render: (r) => `<div class="cell-user">${avatarHtml(r.name, r.avatar_thumb)}<span>${esc(r.name)}</span></div>` },
    { label: 'អ៊ីមែល', render: (r) => `<span class="muted">${esc(r.email)}</span>` },
    { label: 'ចូលថ្ងៃ', num: true, render: (r) => dateOnly(r.created_at) },
  ], s.recentUsers)}
      </div>
      <div class="card">
        <div class="card-head"><h3>ប្រតិបត្តិការថ្មីៗ</h3></div>
        ${tableHtml([
    { label: 'អ្នកប្រើ', render: (r) => esc(r.user_name) },
    { label: 'ប្រតិបត្តិការ', render: (r) => esc(r.title) },
    { label: 'ប្រាក់', num: true, render: (r) => `<span style="color:${r.is_expense ? '#ff9b9b' : '#7ee2a8'}">${r.is_expense ? '-' : '+'}${money(r.amount)}</span>` },
    { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
  ], s.recentTx, { empty: 'មិនទាន់មានប្រតិបត្តិការ' })}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>អ្នកប្រើមានសម្រាប្រាប់ការទាក់ទងច្រើនបំផុត</h3></div>
      ${tableHtml([
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.name, r.avatar_thumb)}<span>${esc(r.name)}</span></div>` },
    { label: 'អ៊ីមែល', render: (r) => `<span class="muted">${esc(r.email)}</span>` },
    { label: 'ប្រតិបត្តិការ', num: true, render: (r) => r.tx_count },
    { label: 'សម្រាប្រាប់', num: true, render: (r) => money(r.balance) },
  ], s.topUsers)}
    </div>`;

  const days = s.daily.map((d) => ({
    label: new Date(d.day).toLocaleDateString('km-KH', { day: 'numeric', month: 'numeric' }),
    value: Number(d.tx),
  }));
  const cv = $('#txChart');
  if (cv) {
    const draw = () => drawLine(cv, days);
    draw();
    window.addEventListener('resize', draw, { once: true });
  }
  const maxCat = Math.max(...s.categories.map((c) => Number(c.total)), 1);
    $$('[data-user-view]').forEach((b) => b.onclick = () => showUser(b.dataset.userView));
$('#catBars').innerHTML = s.categories.length ? s.categories.map((c) => `
    <div class="bar-row">
      <span>${esc(c.category)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(Number(c.total) / maxCat * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${money0(c.total)}</span>
    </div>`).join('') : '<div class="empty">មិនទាន់មានទិន្នន័យ</div>';
}

async function renderUsers() {
  const limit = userFilters.showAll ? 1000 : LIMIT;
  const d = await api(`/users?limit=${limit}&offset=${offset}&q=${encodeURIComponent(search)}&sort=${userFilters.sort}&order=${userFilters.order}`);

  let rows = d.rows;
  if (userFilters.status === 'live') rows = rows.filter((r) => r.online);
  else if (userFilters.status === 'offline') rows = rows.filter((r) => !r.online);
  else if (userFilters.status === 'locked') rows = rows.filter((r) => r.is_locked);
  else if (userFilters.status === 'admin') rows = rows.filter((r) => r.is_admin);

  const onlineCount = d.rows.filter((r) => r.online).length;
  const lockedCount = d.rows.filter((r) => r.is_locked).length;
  const sortOpts = [
    ['created', 'ថ្មីដែរ'], ['name', 'ឈ្មោះ'], ['balance', 'សម្រាប្រាប់'],
    ['tx', 'ប្រតិបត្តិការ'], ['seen', 'ចុងចាស់ប្រើថ្មី'], ['id', 'ID'],
  ].map(([v, n]) => `<option value="${v}" ${userFilters.sort === v ? 'selected' : ''}>${n}</option>`).join('');

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>អ្នកប្រើ ${d.total} នាក់</h3>
        <span class="muted">🟢 Live ${onlineCount} · 🔒 ត្រូវបានផ្អាក ${lockedCount} · បន្ថែមពេលវេលា ${d.online_minutes} នាទី</span>
      </div>
      <div class="toolbar" style="margin-bottom:14px">
        <div class="seg">
          <button class="${userFilters.status === 'all' ? 'active' : ''}" data-ustatus="all">ទាំងអស់</button>
          <button class="${userFilters.status === 'live' ? 'active' : ''}" data-ustatus="live">Live</button>
          <button class="${userFilters.status === 'offline' ? 'active' : ''}" data-ustatus="offline">Offline</button>
          <button class="${userFilters.status === 'locked' ? 'active' : ''}" data-ustatus="locked">ត្រូវបានផ្អាក</button>
          <button class="${userFilters.status === 'admin' ? 'active' : ''}" data-ustatus="admin">Admin</button>
        </div>
        <select id="u_sort">${sortOpts}</select>
        <button class="btn ghost sm" id="u_order">${userFilters.order === 'desc' ? '↓ ចុះ' : '↑ ឡើង'}</button>
        <div class="spacer"></div>
        <button class="btn ghost sm" id="u_all">${userFilters.showAll ? 'បង្ហាញ 25 នាក់ក្នុងមួយទំព័រ' : 'បង្ហាញទាំងអស់'}</button>
      </div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    {
      label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user"><span data-user-view="${r.id}" style="cursor:pointer" title="មើលព័ត៌មាន">${avatarHtml(r.name, r.avatar_thumb, r.online)}</span><div>
        <div>${esc(r.name)} ${r.is_admin ? '<span class="pill info">admin</span>' : ''} ${r.is_locked ? '<span class="pill bad">ផ្អាក</span>' : ''}</div>
        <div class="muted" style="font-size:11.5px">${esc(r.email)} · ${esc(r.phone || '—')}</div></div></div>`
    },
    { label: 'ស្ថានភាព', render: (r) => `<div>${liveBadge(r)}</div>${lastSeenHtml(r)}` },
    { label: 'កាត', num: true, render: (r) => r.card_count },
    { label: 'សម្រាប្រាប់', num: true, render: (r) => money(r.balance) },
    { label: 'ប្រតិបត្តិការ', num: true, render: (r) => r.tx_count },
    { label: 'ចុលថ្ងៃ', num: true, render: (r) => `<span class="muted">${dateOnly(r.created_at)}</span>` },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-user-view="${r.id}" title="មើលព័ត៌មាន">លម្អិត</button><button class="btn ghost sm" data-user-edit="${r.id}" title="កែសម្រួល">កែ</button>
        <button class="btn ghost sm" data-user-lock="${r.id}" data-locked="${r.is_locked ? 1 : 0}" title="${r.is_locked ? 'ដោះសោ' : 'ផ្អាកគណនី'}">${r.is_locked ? '🔓' : '🔒'}</button>
        <button class="btn ghost sm" data-user-reset="${r.id}" title="Reset ទិន្នន័យ">⟲</button>
        <button class="btn danger sm" data-user-del="${r.id}" title="លុបគណនី">🗑</button>
      </div>`
    },
  ], rows, { empty: 'រកមិនឃើញអ្នកប្រើ' })}
      ${pagerHtml(d.total, offset, limit)}
    </div>`;

  bindPager(d.total);
  $$('[data-ustatus]').forEach((b) => b.onclick = () => {
    userFilters.status = b.dataset.ustatus; offset = 0; render();
  });
  $('#u_sort').onchange = (e) => { userFilters.sort = e.target.value; offset = 0; render(); };
  $('#u_order').onclick = () => {
    userFilters.order = userFilters.order === 'desc' ? 'asc' : 'desc'; offset = 0; render();
  };
  $('#u_all').onclick = () => { userFilters.showAll = !userFilters.showAll; offset = 0; render(); };
  $$('[data-user-view]').forEach((b) => b.onclick = () => showUser(b.dataset.userView));
  $$('[data-user-edit]').forEach((b) => b.onclick = () => editUser(b.dataset.userEdit));
  $$('[data-user-lock]').forEach((b) => b.onclick = async () => {
    const lock = b.dataset.locked !== '1';
    try {
      await api(`/users/${b.dataset.userLock}`, { method: 'PATCH', body: { is_locked: lock } });
      toast(lock ? 'បានផ្អាកគណនី' : 'បានដោះសោ', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-user-reset]').forEach((b) => b.onclick = () => {
    confirmAction('Reset ទិន្នន័យអ្នកប្រើ',
      'លុបទិន្នន័យទាំងអស់របស់អ្នកប្រើនេះ (កាត, ប្រតិបត្តិការ, កម្ចី, គោលបំណង, ថវិកា, សេចក្តីសារ, ប្រាក់វិញ, កំណត់ត្រា) ហើយបង្កើតកាត + គោលបំណងថ្មីវិញ។ សម្រាប្រាប់កាតនឹងត្រូវបានកំណត់ជា 0។',
      async () => {
        await api(`/users/${b.dataset.userReset}/reset`, { method: 'POST', body: { reseed: true } });
        toast('បានកំណត់ទិន្នន័យឡើងវិញ', 'ok');
        render();
      });
  });
  $$('[data-user-del]').forEach((b) => b.onclick = () => {
    confirmAction('បញ្ជាក់ការលុប',
      `លុបគណនី "${b.closest('tr')?.querySelector('[data-user-edit]')?.textContent || ''}"? ទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី) នឹងត្រូវបានលុបផង។`,
      async () => {
        await api(`/users/${b.dataset.userDel}`, { method: 'DELETE' });
        toast('បានលុបគណនី', 'ok');
        render();
      });
  });
}

async function editUser(id) {
  const d = await api(`/users/${id}`);
  const u = d.user;
  openModal({
    title: `កែសម្រួលគណនី · ${u.name}`,
    body: `
      <div style="display:flex;gap:14px;align-items:center">
        ${avatarHtml(u.name, u.avatar_thumb, u.online)}
        <div>
          <div>${liveBadge(u)}</div>
          ${lastSeenHtml(u)}
        </div>
      </div>
      <label class="field"><span>ឈ្មោះ</span><input id="f_name" value="${esc(u.name)}"></label>
      <label class="field"><span>អ៊ីមែល</span><input id="f_email" value="${esc(u.email)}"></label>
      <label class="field"><span>លេខទូរស័ព្ទ</span><input id="f_phone" value="${esc(u.phone || '')}"></label>
      <label class="field"><span>PIN ថ្មី (4 ខ្ទង់ — ទុកទទេដើម្បីមិនប្ដូរ)</span><input id="f_pin" maxlength="4" inputmode="numeric" placeholder="••••"></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="f_admin" ${u.is_admin ? 'checked' : ''} style="width:18px;height:18px">
        <span>សិទ្ធិ Admin (គ្រប់គ្រងទិន្នថយទាំងអស់)</span></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="f_locked" ${u.is_locked ? 'checked' : ''} style="width:18px;height:18px">
        <span>🔒 ផ្អាកគណនី (មិនអាចចូលប្រើប្រើវិញ)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ok sm" id="f_unlock">🔓 ដោះសោ (unlock)</button>
        <button class="btn ghost sm" id="f_reset">⟲ Reset ទិន្នន័យ</button>
        <button class="btn danger sm" id="f_delete">🗑 លុបគណនី</button>
      </div>`,
    onSave: async () => {
      const body = {
        name: $('#f_name').value.trim(),
        email: $('#f_email').value.trim(),
        phone: $('#f_phone').value.trim(),
        is_admin: $('#f_admin').checked,
        is_locked: $('#f_locked').checked,
      };
      await api(`/users/${id}`, { method: 'PATCH', body });
      const pin = $('#f_pin').value.trim();
      if (pin) await api(`/users/${id}/pin`, { method: 'POST', body: { pin } });
      toast('បានរក្សាទុកកែសម្រួល', 'ok');
      render();
    },
  });
  $('#f_unlock').onclick = async () => {
    await api(`/users/${id}`, { method: 'PATCH', body: { unlock: true, is_locked: false } });
    toast('បានដោះសោ', 'ok');
    closeModal();
    render();
  };
  $('#f_reset').onclick = () => {
    closeModal();
    confirmAction('Reset ទិន្នន័យអ្នកប្រើ',
      'លុបទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី, គោលបំណង, ថវិកា, សេចក្តីសារ, ប្រាក់វិញ, កំណត់ត្រា) ហើយបង្កើតកាត + គោលបំណងថ្មីវិញ។',
      async () => {
        await api(`/users/${id}/reset`, { method: 'POST', body: { reseed: true } });
        toast('បានកំណត់ទិន្នន័យឡើងវិញ', 'ok');
        render();
      });
  };
  $('#f_delete').onclick = () => {
    closeModal();
    confirmAction('បញ្ជាក់ការលុប',
      `លុបគណនី "${u.name}"? ទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី) នឹងត្រូវបានលុបផង។`,
      async () => {
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('បានលុបគណនី', 'ok');
        render();
      });
  };
}

async function showUser(id) {
  const d = await api(`/users/${id}`);
  const u = d.user;
  const tabs = [
    ['cards', `កាត (${d.cards.length})`],
    ['transactions', `ប្រតិបត្តិការ (${d.transactions.length})`],
    ['loans', `កម្ចី (${d.loans.length})`],
    ['goals', `គោលបំណង (${d.goals.length})`],
    ['budgets', `ថវិកា (${d.budgets.length})`],
    ['notifications', `សេចក្តីសារ (${d.notifications.length})`],
  ];
  const bodyFor = (key) => {
    if (key === 'cards') return tableHtml([
      { label: 'កាត', render: (r) => esc(r.name) },
      { label: 'លេខ', render: (r) => `<span class="muted">${esc(r.number)}</span>` },
      { label: 'សម្រាប្រាប់', num: true, render: (r) => money(r.balance) },
      { label: 'ដីហទិត/ថ្ងៃ', num: true, render: (r) => money(r.daily_limit) },
      { label: 'ស្ថានភាព', render: (r) => r.frozen ? '<span class="pill bad">បានផ្អាក</span>' : '<span class="pill ok">ធម្មតា</span>' },
    ], d.cards);
    if (key === 'transactions') return tableHtml([
      { label: 'ចំណាង', render: (r) => esc(r.title) },
      { label: 'ប្រភេទ', render: (r) => esc(r.category) },
      { label: 'ប្រាក់', num: true, render: (r) => `<span style="color:${r.is_expense ? '#ff9b9b' : '#7ee2a8'}">${r.is_expense ? '-' : '+'}${money(r.amount)}</span>` },
      { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
    ], d.transactions);
    if (key === 'loans') return tableHtml([
      { label: 'ចំនួន', num: true, render: (r) => money(r.principal) },
      { label: 'បានបង់', num: true, render: (r) => money(r.paid) },
      { label: 'ខែ', num: true, render: (r) => r.months },
      { label: 'កាន្លោះ', num: true, render: (r) => r.annual_rate + '%' },
      { label: 'ស្ថានភាព', render: (r) => r.active ? '<span class="pill ok">កំពុង</span>' : '<span class="pill bad">បានបញ្ចប់</span>' },
    ], d.loans);
    if (key === 'goals') return tableHtml([
      { label: 'ឈ្មោះ', render: (r) => esc(r.name) },
      { label: 'គោលបំណង', num: true, render: (r) => money(r.target) },
      { label: 'បានរក្សា', num: true, render: (r) => money(r.saved) },
    ], d.goals);
    if (key === 'budgets') return tableHtml([
      { label: 'ប្រភេទ', render: (r) => esc(r.category) },
      { label: 'ថវិកា', num: true, render: (r) => money(r.amount) },
    ], d.budgets);
    return tableHtml([
      { label: 'ចំណាង', render: (r) => esc(r.title) },
      { label: 'អត្ថបទ', render: (r) => `<span class="muted">${esc(r.body)}</span>` },
      { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
    ], d.notifications);
  };

  openModal({
    title: `${u.name} · ព័ត៌មានលម្អិត`,
    wide: true,
    body: `
      <div style="display:flex;gap:16px;align-items:center">
        ${avatarHtml(u.name, u.avatar_thumb, u.online)}
        <div>
          <div style="font-size:17px;font-weight:700;margin-bottom:4px">${esc(u.name)}</div>
          <div>${liveBadge(u)}</div>
          ${lastSeenHtml(u)}
        </div>
      </div>
      <div class="detail-grid" style="margin-top:12px">
        <div class="detail-item"><div class="k">ID</div><div class="v">#${u.id}</div></div>
        <div class="detail-item"><div class="k">អ៊ីមែល</div><div class="v">${esc(u.email)}</div></div>
        <div class="detail-item"><div class="k">ទូរស័ព្ទ</div><div class="v">${esc(u.phone || '—')}</div></div>
        <div class="detail-item"><div class="k">ចូលដោយ</div><div class="v">${esc(u.auth_provider || 'email')}</div></div>
        <div class="detail-item"><div class="k">សិទ្ធិ</div><div class="v">${u.is_admin ? 'Admin' : 'អ្នកប្រើ'}</div></div>
        <div class="detail-item"><div class="k">ស្ថានភាព</div><div class="v">${u.is_locked ? '<span class="pill bad">ត្រូវបានផ្អាក</span>' : '<span class="pill ok">ធម្មតា</span>'}</div></div>
        <div class="detail-item"><div class="k">ចុលថ្ងៃ</div><div class="v">${dateOnly(u.created_at)}</div></div>
        <div class="detail-item"><div class="k">ចុងចាស់ប្រើ</div><div class="v">${u.last_seen_at ? dt(u.last_seen_at) : '—'}</div></div>
      </div>
      <div class="toolbar" style="margin:14px 0">
        <button class="btn ghost sm" id="u_edit">✎ កែសម្រួល</button>
        <button class="btn ghost sm" id="u_lock">${u.is_locked ? '🔓 ដោះសោ' : '🔒 ផ្អាកគណនី'}</button>
        <button class="btn ghost sm" id="u_reset">⟲ Reset ទិន្នន័យ</button>
        <button class="btn danger sm" id="u_del">🗑 លុបគណនី</button>
      </div>
      <div class="tabs" id="dTabs">${tabs.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
      <div id="dPanel" class="sub-table"></div>`,
  });
  const panel = $('#dPanel');
  panel.innerHTML = bodyFor(tabs[0][0]);
  $$('#dTabs .tab').forEach((b) => b.onclick = () => {
    $$('#dTabs .tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    panel.innerHTML = bodyFor(b.dataset.tab);
  });
  $('#u_edit').onclick = () => { closeModal(); editUser(id); };
  $('#u_lock').onclick = async () => {
    const lock = !u.is_locked;
    await api(`/users/${id}`, { method: 'PATCH', body: { is_locked: lock } });
    toast(lock ? 'បានផ្អាកគណនី' : 'បានដោះសោ', 'ok');
    closeModal();
    render();
  };
  $('#u_reset').onclick = () => {
    closeModal();
    confirmAction('Reset ទិន្នន័យអ្នកប្រើ',
      'លុបទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី, គោលបំណង, ថវិកា, សេចក្តីសារ, ប្រាក់វិញ, កំណត់ត្រា) ហើយបង្កើតកាត + គោលបំណងថ្មីវិញ។',
      async () => {
        await api(`/users/${id}/reset`, { method: 'POST', body: { reseed: true } });
        toast('បានកំណត់ទិន្នន័យឡើងវិញ', 'ok');
        render();
      });
  };
  $('#u_del').onclick = () => {
    closeModal();
    confirmAction('បញ្ជាក់ការលុប',
      `លុបគណនី "${u.name}"? ទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី) នឹងត្រូវបានលុបផង។`,
      async () => {
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('បានលុបគណនី', 'ok');
        render();
      });
  };
}

async function renderCards() {
  const d = await api(`/cards?limit=${LIMIT}&offset=${offset}&q=${encodeURIComponent(search)}`);
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>កាត ${d.total} សន្លាក់</h3></div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'ម្មាន', render: (r) => esc(r.name) },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<span>${esc(r.user_name)}</span></div>` },
    { label: 'លេខកាត', render: (r) => `<span class="muted">${esc(r.number)}</span>` },
    { label: 'សម្រាប្រាប់', num: true, render: (r) => money(r.balance) },
    { label: 'ដីហទិត/ថ្ងៃ', num: true, render: (r) => money(r.daily_limit) },
    {
      label: 'ស្ថានភាព', render: (r) => [
        r.frozen ? '<span class="pill bad">បានផ្អាក</span>' : '<span class="pill ok">ធម្មតា</span>',
        r.online ? '' : '<span class="pill warn">កែប្ដូរក្រៅអន្តប្រវេស</span>',
      ].join(' ')
    },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-card-edit="${r.id}">កែសម្រាប់/សម្រាប់</button>
        <button class="btn danger sm" data-card-del="${r.id}">លុប</button></div>`
    },
  ], d.rows, { empty: 'រកមិនឃើញកាត' })}
      ${pagerHtml(d.total, offset, LIMIT)}
    </div>`;
  bindPager(d.total);
  $$('[data-card-edit]').forEach((b) => b.onclick = () => editCard(b.dataset.cardEdit));
  $$('[data-card-del]').forEach((b) => b.onclick = () => {
    confirmDelete('លុបកាតនេះ? ប្រតិបត្តិការដែលជាកាតនេះនឹងត្រូវបានលុបផង។', async () => {
      await api(`/cards/${b.dataset.cardDel}`, { method: 'DELETE' });
      toast('បានលុបកាត', 'ok');
      render();
    });
  });
}

async function editCard(id) {
  const d = await api(`/cards?limit=300`);
  const card = d.rows.find((c) => String(c.id) === String(id));
  if (!card) return toast('រកមិនឃើញកាត', 'err');
  openModal({
    title: `កែសម្រួលកាត · ${card.name}`,
    body: `
      <label class="field"><span>ឈ្មោះកាត</span><input id="c_name" value="${esc(card.name)}"></label>
      <label class="field"><span>សម្រាប្រាប់</span><input id="c_balance" type="number" step="0.01" value="${card.balance}"></label>
      <label class="field"><span>ដីហទិតប្រចាំថ្ងៃ</span><input id="c_limit" type="number" step="0.01" value="${card.daily_limit}"></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="c_frozen" ${card.frozen ? 'checked' : ''} style="width:18px;height:18px"><span>ផ្អាកកាត (frozen)</span></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="c_online" ${card.online ? 'checked' : ''} style="width:18px;height:18px"><span>អនុញ្ញាតប្រើអន្តប្រវេស</span></label>
      <p class="muted" style="margin:0">ម្មាន: ${esc(card.user_name)} · ${esc(card.number)} · ${esc(card.expiry)}</p>`,
    onSave: async () => {
      await api(`/cards/${id}`, {
        method: 'PATCH',
        body: {
          name: $('#c_name').value.trim(),
          balance: Number($('#c_balance').value),
          daily_limit: Number($('#c_limit').value),
          frozen: $('#c_frozen').checked,
          online: $('#c_online').checked,
        },
      });
      toast('បានរក្សាទុកកាត', 'ok');
      render();
    },
  });
}

let txFilters = { q: '', from: '', to: '', user_id: '' };

async function renderTransactions() {
  const p = new URLSearchParams({
    limit: LIMIT, offset, q: txFilters.q, from: txFilters.from, to: txFilters.to,
  });
  if (txFilters.user_id) p.set('user_id', txFilters.user_id);
  const d = await api('/transactions?' + p.toString());
  $('#content').innerHTML = `
    <div class="card">
      <div class="filters">
        <label class="field"><span>ស្វែងរក</span><input id="f_q" value="${esc(txFilters.q)}" placeholder="ចំណាង, ប្រភេទ, អ្នកប្រើ…"></label>
        <label class="field"><span>ពីថ្ងៃ</span><input id="f_from" type="date" value="${esc(txFilters.from)}"></label>
        <label class="field"><span>ដល់ថ្ងៃ</span><input id="f_to" type="date" value="${esc(txFilters.to)}"></label>
        <button class="btn primary" id="f_apply">អនុវត្ត</button>
        <button class="btn ghost" id="f_clear">សម្អាត</button>
      </div>
    </div>
    <div class="grid k3">
      <div class="card kpi"><div class="kpi-label">ចំនួនប្រតិបត្តិការ</div><div class="kpi-value">${d.total}</div></div>
      <div class="card kpi warn"><div class="kpi-label">ចំនួនប្រាក់ចំណាយ</div><div class="kpi-value">${money0(d.spent)}</div></div>
      <div class="card kpi ok"><div class="kpi-label">ចំនួនប្រាក់ចូល</div><div class="kpi-value">${money0(d.income)}</div></div>
    </div>
    <div class="card">
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<span>${esc(r.user_name)}</span></div>` },
    { label: 'ចំណាង', render: (r) => esc(r.title) },
    { label: 'ប្រភេទ', render: (r) => `<span class="pill">${esc(r.category)}</span>` },
    { label: 'កាត', render: (r) => `<span class="muted">${esc(r.card_name || '—')}</span>` },
    { label: 'ប្រាក់', num: true, render: (r) => `<span style="color:${r.is_expense ? '#ff9b9b' : '#7ee2a8'}">${r.is_expense ? '-' : '+'}${money(r.amount)}</span>` },
    { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
    {
      label: 'សកម្ម', render: (r) => `<button class="btn danger sm" data-tx-del="${r.id}">លុប</button>`
    },
  ], d.rows, { empty: 'រកមិនឃើញប្រតិបត្តិការ' })}
      ${pagerHtml(d.total, offset, LIMIT)}
    </div>`;
  bindPager(d.total);
  $('#f_apply').onclick = () => {
    txFilters.q = $('#f_q').value.trim();
    txFilters.from = $('#f_from').value;
    txFilters.to = $('#f_to').value;
    offset = 0; render();
  };
  $('#f_clear').onclick = () => {
    txFilters = { q: '', from: '', to: '', user_id: '' };
    offset = 0; render();
  };
  $$('[data-tx-del]').forEach((b) => b.onclick = () => {
    confirmDelete('លុបប្រតិបត្តិការនេះ? សម្រាប្រាប់កាតនឹងត្រឡប់វិញដែរ។', async () => {
      await api(`/transactions/${b.dataset.txDel}`, { method: 'DELETE' });
      toast('បានលុបប្រតិបត្តិការ', 'ok');
      render();
    });
  });
}

async function createTransaction() {
  const cards = (await api('/cards?limit=300')).rows;
  if (!cards.length) return toast('មិនទាន់មានកាតសម្រាប់បញ្ចូលប្រតិបត្តិការ', 'err');
  const users = [...new Set(cards.map((c) => `${c.user_id}|${c.user_name}`))];
  openModal({
    title: 'បង្កើតប្រតិបត្តិការដោយដៃ',
    body: `
      <label class="field"><span>អ្នកប្រើ</span>
        <select id="t_user">${users.map((u) => { const [id, n] = u.split('|'); return `<option value="${id}">${esc(n)}</option>`; }).join('')}</select></label>
      <label class="field"><span>កាត</span><select id="t_card"></select></label>
      <label class="field"><span>ចំណាង</span><input id="t_title" placeholder="ឧ. កែសម្រួលប្រាក់"></label>
      <label class="field"><span>ប្រភេទ</span><input id="t_category" value="ផ្សេងៗ"></label>
      <label class="field"><span>ចំនួនប្រាក់</span><input id="t_amount" type="number" step="0.01" min="0.01"></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="t_expense" checked style="width:18px;height:18px"><span>ចំណាយ (បើកកំណត់សិទ្ធិ ចំណាយ)</span></label>`,
    onSave: async () => {
      const body = {
        user_id: Number($('#t_user').value),
        card_id: Number($('#t_card').value),
        title: $('#t_title').value.trim(),
        category: $('#t_category').value.trim() || 'ផ្សេងៗ',
        amount: Number($('#t_amount').value),
        is_expense: $('#t_expense').checked,
      };
      if (!body.title) throw new Error('សូមបញ្ចូលចំណាង');
      if (!(body.amount > 0)) throw new Error('ចំនួនប្រាក់ត្រូវតែ > 0');
      await api('/transactions', { method: 'POST', body });
      toast('បានបង្កើតប្រតិបត្តិការ', 'ok');
      render();
    },
  });
  const fillCards = () => {
    const uid = $('#t_user').value;
    const list = cards.filter((c) => String(c.user_id) === String(uid));
    $('#t_card').innerHTML = list.map((c) =>
      `<option value="${c.id}">${esc(c.name)} · ${money(c.balance)}</option>`).join('');
  };
  fillCards();
  $('#t_user').onchange = fillCards;
}

async function renderLoans() {
  const d = await api('/loans');
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>កម្ចី ${d.rows.length} សំបុត្រ</h3></div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<div>
      <div>${esc(r.user_name)}</div><div class="muted" style="font-size:11.5px">${esc(r.user_phone || '')}</div></div></div>` },
    { label: 'ចំនួន', num: true, render: (r) => money(r.principal) },
    { label: 'បានបង់', num: true, render: (r) => money(r.paid) },
    { label: 'នៅសល់', num: true, render: (r) => money(Number(r.principal) - Number(r.paid)) },
    { label: 'ខែ', num: true, render: (r) => r.months },
    { label: 'កាន្លោះ', num: true, render: (r) => r.annual_rate + '%' },
    { label: 'ទីតាំង', render: (r) => `<span class="muted" style="font-size:11.5px">${[r.province, r.district, r.commune, r.village].filter(Boolean).join(' / ') || '—'}</span>` },
    { label: 'ស្ថានភាព', render: (r) => r.active ? '<span class="pill ok">កំពុង</span>' : '<span class="pill bad">បានបញ្ចប់</span>' },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-loan-edit="${r.id}">កែ</button>
        <button class="btn ghost sm" data-loan-pay="${r.id}">បង់</button>
        <button class="btn danger sm" data-loan-del="${r.id}">លុប</button></div>`
    },
  ], d.rows, { empty: 'រកមិនឃើញកម្ចី' })}
    </div>`;
  $$('[data-loan-edit]').forEach((b) => b.onclick = () => {
    const loan = d.rows.find((l) => String(l.id) === b.dataset.loanEdit);
    openModal({
      title: `កែសម្រួលកម្ចី #${loan.id}`,
      body: `
        <label class="field"><span>ចំនួនប្រាក់</span><input id="l_principal" type="number" step="0.01" value="${loan.principal}"></label>
        <label class="field"><span>រយៈខែ</span><input id="l_months" type="number" min="1" max="120" value="${loan.months}"></label>
        <label class="field"><span>កាន្លោះ (%/ឆ្នាំ)</span><input id="l_rate" type="number" step="0.01" value="${loan.annual_rate}"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:10px">
          <input type="checkbox" id="l_active" ${loan.active ? 'checked' : ''} style="width:18px;height:18px"><span>កំពុងបញ្ចាស់</span></label>`,
      onSave: async () => {
        await api(`/loans/${loan.id}`, {
          method: 'PATCH',
          body: {
            principal: Number($('#l_principal').value),
            months: Number($('#l_months').value),
            annual_rate: Number($('#l_rate').value),
            active: $('#l_active').checked,
          },
        });
        toast('បានរក្សាទុកកម្ចី', 'ok');
        render();
      },
    });
  });
  $$('[data-loan-pay]').forEach((b) => b.onclick = () => {
    const loan = d.rows.find((l) => String(l.id) === b.dataset.loanPay);
    openModal({
      title: `បង់កម្ចី #${loan.id}`,
      body: `<label class="field"><span>ចំនួនប្រាក់</span><input id="l_amount" type="number" step="0.01" value="${(Number(loan.principal) - Number(loan.paid)).toFixed(2)}"></label>
        <p class="muted" style="margin:0">បានបង់ ${money(loan.paid)} នៃ ${money(loan.principal)}</p>`,
      onSave: async () => {
        await api(`/loans/${loan.id}/repay`, {
          method: 'POST', body: { amount: Number($('#l_amount').value) },
        });
        toast('បានកត់ត្រាការបង់ប្រាក់', 'ok');
        render();
      },
    });
  });
  $$('[data-loan-del]').forEach((b) => b.onclick = () => {
    confirmDelete('លុបកម្ចីនេះ?', async () => {
      await api(`/loans/${b.dataset.loanDel}`, { method: 'DELETE' });
      toast('បានលុបកម្ចី', 'ok');
      render();
    });
  });
}

async function renderNotifications() {
  const d = await api('/notifications?limit=100');
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>សេចក្តីសារថ្មីៗ ${d.rows.length}</h3>
        <button class="btn primary sm" id="n_new">+ ផ្ញើសេចក្តីសារ</button></div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<span>${esc(r.user_name)}</span></div>` },
    { label: 'ចំណាង', render: (r) => esc(r.title) },
    { label: 'អត្ថបទ', render: (r) => `<span class="muted">${esc(r.body)}</span>` },
    { label: 'បានអាន', render: (r) => r.read ? '<span class="pill ok">អាន</span>' : '<span class="pill">ថ្មី</span>' },
    { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
  ], d.rows, { empty: 'មិនទាន់មានសេចក្តីសារ' })}
    </div>`;
  $('#n_new').onclick = async () => {
    const users = await api('/users?limit=200');
    openModal({
      title: 'ផ្ញើសេចក្តីសារ',
      body: `
        <label class="field"><span>អ្នកប្រើ</span><select id="m_user">${users.rows.map((u) => `<option value="${u.id}">${esc(u.name)} — ${esc(u.email)}</option>`).join('')}</select></label>
        <label class="field"><span>ចំណាង</span><input id="m_title"></label>
        <label class="field"><span>អត្ថបទ</span><textarea id="m_body" rows="3"></textarea></label>`,
      onSave: async () => {
        await api('/notify', {
          method: 'POST',
          body: { user_id: Number($('#m_user').value), title: $('#m_title').value.trim(), body: $('#m_body').value.trim() },
        });
        toast('បានផ្ញើសេចក្តីសារ', 'ok');
        render();
      },
    });
  };
}

const DATA_TABLES = [
  ['goals', 'គោលបំណង'], ['budgets', 'ថវិកា'], ['reminders', 'កំណត់ត្រា'],
  ['recurring', 'ប្រតិបត្តិការក្រោយ'], ['splits', 'បែកចែកការចំណាយ'],
  ['virtual_cards', 'កាតនិម្យោ'], ['cashback', 'ប្រាក់វិញ'],
  ['referrals', 'មនុស្សណែនាំ'], ['external_transfers', 'ផ្ទេរក្រៅបទេស'],
  ['banks', 'បង្កើតធនាគារ'], ['achievements', 'សម្គាល់ជោគជ័យ'],
  ['streaks', 'ស្មាត្របន្តថ្ងៃ'], ['fcm_tokens', 'ឧបកប្រុងពន្ធនាយ'],
];
let dataTable = 'goals';

async function renderData() {
  const d = await api(`/tables/${dataTable}?limit=100`);
  const cols = d.columns.length
    ? d.columns
    : Object.keys(d.rows[0] || {}).filter((k) => !['id', 'user_id', 'created_at'].includes(k));
  $('#content').innerHTML = `
    <div class="card">
      <div class="tabs">${DATA_TABLES.map(([k, n]) =>
    `<button class="tab ${k === dataTable ? 'active' : ''}" data-table="${k}">${n}</button>`).join('')}</div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id ?? r.user_id ?? '—'}` },
    { label: 'អ្នកប្រើ', render: (r) => r.user_name ? `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<span>${esc(r.user_name)}</span></div>` : '—' },
    ...cols.map((c) => ({
      label: c, render: (r) => {
        const v = r[c];
        if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
        if (typeof v === 'number') return money(v);
        if (typeof v === 'object') return `<span class="muted">${esc(JSON.stringify(v))}</span>`;
        const s = String(v);
        return s.length > 40 ? `<span title="${esc(s)}">${esc(s.slice(0, 40))}…</span>` : esc(s);
      },
    })),
    ...(d.editable ? [{
      label: 'សកម្ម', render: (r) => `<button class="btn danger sm" data-row-del="${r.id}">លុប</button>`,
    }] : []),
  ], d.rows, { empty: 'មិនទាន់មានទិន្នន័យ' })}
    </div>`;
  $$('[data-table]').forEach((b) => b.onclick = () => { dataTable = b.dataset.table; render(); });
  $$('[data-row-del]').forEach((b) => b.onclick = () => {
    confirmDelete(`លុបកំណត់ត្រា #${b.dataset.rowDel} ក្នុងតារាងនេះ?`, async () => {
      await api(`/tables/${dataTable}/${b.dataset.rowDel}`, { method: 'DELETE' });
      toast('បានលុប', 'ok');
      render();
    });
  });
}

async function renderAudit() {
  const d = await api('/audit?limit=200');
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>កំណត់ត្រាក្របរបុប · ចុងចាស់លើកទេ</h3></div>
      ${tableHtml([
    { label: 'ពេល', render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
    { label: 'Admin', render: (r) => esc(r.admin_email) },
    { label: 'សកម្ម', render: (r) => `<span class="pill info">${esc(r.action)}</span>` },
    { label: 'គោលប្រភេទ', render: (r) => esc(r.target_type || '—') },
    { label: 'ID', render: (r) => esc(r.target_id || '—') },
    { label: 'ព័ត៌មាន', render: (r) => `<span class="muted">${esc(r.detail || '')}</span>` },
  ], d.rows, { empty: 'មិនទាន់មានកំណត់ត្រា' })}
    </div>`;
}

/* ============================================================
   ROUTER
   ============================================================ */
const RENDERERS = {
  dashboard: renderDashboard, users: renderUsers, cards: renderCards,
  transactions: renderTransactions, loans: renderLoans,
  notifications: renderNotifications, data: renderData, audit: renderAudit,
};

function bindPager(total) {
  $$('[data-page-btn]').forEach((b) => b.onclick = () => {
    offset = b.dataset.pageBtn === 'next' ? offset + LIMIT : Math.max(0, offset - LIMIT);
    render();
  });
}

async function render() {
  $('#pageTitle').textContent = TITLES[page];
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#search').classList.toggle('hidden', !['users', 'cards'].includes(page));
  const action = $('#actionBtn');
  if (page === 'transactions') {
    action.hidden = false; action.textContent = '+ ប្រតិបត្តិការ';
  } else if (page === 'notifications') {
    action.hidden = false; action.textContent = '+ ផ្ញើសេចក្តីសារ';
  } else {
    action.hidden = true;
  }
  const el = $('#content');
  el.innerHTML = '<div class="empty">កំពុងផ្ទុក…</div>';
  try {
    await RENDERERS[page]();
  } catch (e) {
    el.innerHTML = `<div class="empty">បរាជ័យ: ${esc(e.message)}</div>`;
  }
}

/* ---------- auth ---------- */
async function boot() {
  if (!token) { $('#login').classList.remove('hidden'); return; }
  try {
    admin = await api('/me');
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#adminName').textContent = admin.name || admin.email;
    $('#adminMail').textContent = admin.email;
    render();
  } catch (_) {
    token = null;
    localStorage.removeItem('aura_admin_token');
    $('#login').classList.remove('hidden');
  }
}

function logout() {
  token = null;
  admin = null;
  localStorage.removeItem('aura_admin_token');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  $('#loginBtn').disabled = true;
  try {
    const d = await api('/login', {
      method: 'POST',
      body: { email: $('#loginEmail').value.trim(), pin: $('#loginPin').value.trim() },
    });
    token = d.token;
    admin = d.admin;
    localStorage.setItem('aura_admin_token', token);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#adminName').textContent = admin.name;
    $('#adminMail').textContent = admin.email;
    render();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
};

$('#logoutBtn').onclick = logout;
$('#refreshBtn').onclick = () => render();

// ផ្អាសស្ថានភាព Live/Offline ជាភាពត្រឹមតែគេ ដូចវាឯករាងៗ
setInterval(() => {
  if (!token) return;
  if (!$('#modal').classList.contains('hidden')) return;
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
  if (page === 'users' || page === 'dashboard') render();
}, 20000);


$('#menuBtn').onclick = () => $('.sidebar').classList.toggle('open');
$$('.nav-item').forEach((b) => b.onclick = () => {
  page = b.dataset.page;
  offset = 0;
  $('.sidebar').classList.remove('open');
  render();
});
$('#search').oninput = (e) => {
  clearTimeout(window._st);
  const v = e.target.value.trim();
  window._st = setTimeout(() => { search = v; offset = 0; render(); }, 320);
};
$('#actionBtn').onclick = () => {
  if (page === 'transactions') createTransaction();
  else if (page === 'notifications') renderNotifications();
};

boot();
