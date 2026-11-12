const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const el = {
  note: $('#note'),
  title: $('#title'),
  text: $('#text'),
  saved: $('#saved'),
  syncBtn: $('#syncBtn'),
  syncDot: $('#syncDot'),
  syncLabel: $('#syncLabel'),
  topBtn: $('#topBtn'),
  hideBtn: $('#hideBtn'),
  sheet: $('#sheet'),
  sheetClose: $('#sheetClose'),
  sheetSub: $('#sheetSub'),
  sheetErr: $('#sheetErr'),
  server: $('#server'),
  email: $('#email'),
  password: $('#password'),
  connectBtn: $('#connectBtn'),
  logoutBtn: $('#logoutBtn'),
  grip: $('#grip'),
};

const state = {
  title: '', text: '', color: 'yellow', font: 14, updatedAt: 0,
  connected: false, server: '', alwaysOnTop: true,
  width: 360, height: 430,
};
let saveTimer = 0;
let lastSavedAt = 0;

function paint() {
  el.note.dataset.noteColor = state.color;
  el.note.style.setProperty('--note-font', state.font + 'px');
  $$('.sw').forEach((b) => b.classList.toggle('on', b.dataset.color === state.color));
  document.title = state.title ? state.title + ' — Aura Sticky Note' : 'Aura Sticky Note';
}

function paintSync(kind, label) {
  el.syncBtn.classList.remove('ready', 'busy', 'off');
  if (kind) el.syncBtn.classList.add(kind);
  el.syncLabel.textContent = label;
  el.syncBtn.title = kind === 'ready'
    ? 'ភ្ជាប់រួច — ចុចដើម្បី sync ឥឡូវ'
    : kind === 'off' ? 'ភ្ជាប់មិនបាន — ចុចដើម្បីពិនិត្យ' : 'ចុចដើម្បីភ្ជាប់គណនី (sync)';
}

function applyNote(n, { keepCursor = false } = {}) {
  const titleChanged = n.title !== state.title && document.activeElement !== el.title;
  const textChanged = n.text !== state.text && document.activeElement !== el.text;
  state.title = n.title;
  state.text = n.text;
  state.color = n.color;
  state.font = n.font;
  state.updatedAt = Number(n.updatedAt) || state.updatedAt;
  if (titleChanged) el.title.value = n.title;
  if (textChanged) el.text.value = n.text;
  el.note.dataset.noteColor = n.color;
  el.note.style.setProperty('--note-font', n.font + 'px');
  $$('.sw').forEach((b) => b.classList.toggle('on', b.dataset.color === n.color));
  if (!keepCursor) paint();
}

function flashSaved() {
  el.saved.classList.remove('show');
  void el.saved.offsetWidth;
  el.saved.classList.add('show');
  clearTimeout(lastSavedAt);
  lastSavedAt = setTimeout(() => el.saved.classList.remove('show'), 1400);
}

function queueSave() {
  if (!state.connected) { paintSync('', 'local'); }
  else paintSync('busy', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const res = await window.noteApi.save({
      title: state.title, text: state.text, color: state.color, font: state.font,
    });
    if (res && res.ok && !res.offline) {
      state.updatedAt = res.updatedAt || state.updatedAt;
      paintSync('ready', 'synced');
      flashSaved();
    } else if (res && res.offline) {
      paintSync(state.connected ? 'off' : '', state.connected ? 'offline' : 'local');
      flashSaved();
    }
  }, 450);
}

function openSheet() {
  el.sheet.hidden = false;
  el.sheetErr.textContent = '';
  el.server.value = state.server || el.server.value;
  el.logoutBtn.hidden = !state.connected;
  el.sheetSub.textContent = state.connected
    ? 'ចំណាំនេះ sync ជាមួយផ្ទាំងគ្រប់គ្រង admin។ អ្នកអាចផ្តាច់គណនី ប៉ុន្តែចំណាំនឹងនៅតែរក្សាទុកក្នុងម៉ាស៊ីន។'
    : 'ភ្ជាប់ដើម្បីឱ្យចំណាំនេះ sync ស្វ័យប្រវត្តិជាមួយផ្ទាំងគ្រប់គ្រង admin។ មិនភ្ជាប់ក៏ប្រើបានដែរ — រក្សាទុកក្នុងម៉ាស៊ីនតែម្នាក់។';
  if (!state.connected) setTimeout(() => el.email.focus(), 50);
}

function closeSheet() { el.sheet.hidden = true; }

async function connect() {
  el.sheetErr.textContent = '';
  el.connectBtn.disabled = true;
  el.connectBtn.textContent = 'កំពុងភ្ជាប់…';
  try {
    const data = await window.noteApi.login({
      server: el.server.value.trim(),
      email: el.email.value.trim(),
      password: el.password.value,
    });
    state.connected = true;
    state.server = el.server.value.trim();
    applyNote(data.note);
    el.password.value = '';
    paintSync('ready', 'synced');
    closeSheet();
    flashSaved();
  } catch (err) {
    el.sheetErr.textContent = err && err.message ? err.message : 'ភ្ជាប់មិនបាន';
  } finally {
    el.connectBtn.disabled = false;
    el.connectBtn.textContent = 'ភ្ជាប់';
  }
}

async function boot() {
  const info = await window.noteApi.init();
  state.title = info.note.title;
  state.text = info.note.text;
  state.color = info.note.color;
  state.font = info.note.font;
  state.updatedAt = info.note.updatedAt;
  state.connected = info.connected;
  state.server = info.server;
  state.alwaysOnTop = info.alwaysOnTop;
  if (info.size) { state.width = info.size.width; state.height = info.size.height; }
  el.title.value = state.title;
  el.text.value = state.text;
  el.server.value = state.server;
  paint();
  paintSync(state.connected ? 'ready' : '', state.connected ? 'synced' : 'local');
  el.topBtn.classList.toggle('on', !!state.alwaysOnTop);

  if (!state.connected) setTimeout(openSheet, 400);
}

el.title.addEventListener('input', () => { state.title = el.title.value; queueSave(); });
el.text.addEventListener('input', () => { state.text = el.text.value; queueSave(); });
[el.title, el.text].forEach((node) => node.addEventListener('blur', () => {
  clearTimeout(saveTimer);
  window.noteApi.save({ title: state.title, text: state.text, color: state.color, font: state.font }).then((res) => {
    if (res && res.ok && !res.offline) { state.updatedAt = res.updatedAt || state.updatedAt; paintSync('ready', 'synced'); flashSaved(); }
  });
}));

$$('.sw').forEach((b) => b.addEventListener('click', () => {
  state.color = b.dataset.color;
  paint();
  queueSave();
}));

$$('[data-font]').forEach((b) => b.addEventListener('click', () => {
  state.font = Math.max(12, Math.min(22, state.font + Number(b.dataset.font)));
  paint();
  queueSave();
}));

el.topBtn.addEventListener('click', async () => {
  const on = await window.noteApi.setTop(!el.topBtn.classList.contains('on'));
  state.alwaysOnTop = on;
  el.topBtn.classList.toggle('on', on);
});

el.hideBtn.addEventListener('click', () => window.noteApi.hide());
el.syncBtn.addEventListener('click', async () => {
  if (!state.connected) return openSheet();
  paintSync('busy', 'syncing');
  const n = await window.noteApi.pull();
  if (n) { applyNote(n); paintSync('ready', 'synced'); }
  else paintSync('off', 'offline');
});
el.sheetClose.addEventListener('click', closeSheet);
el.connectBtn.addEventListener('click', connect);
el.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
el.email.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.password.focus(); });
el.logoutBtn.addEventListener('click', async () => {
  await window.noteApi.logout();
  state.connected = false;
  paintSync('', 'local');
  closeSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) closeSheet();
    else window.noteApi.hide();
  }
});

window.noteApi.onRemote((note) => {
  if (!state.connected) return;
  if (!note || Number(note.updatedAt) <= state.updatedAt) return;
  applyNote(note);
  paintSync('ready', 'synced');
  flashSaved();
});
window.noteApi.onTop((on) => {
  state.alwaysOnTop = on;
  el.topBtn.classList.toggle('on', on);
});

let rz = null;
el.grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  rz = { sx: e.screenX, sy: e.screenY, w: state.width, h: state.height };
  try { el.grip.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
});
el.grip.addEventListener('pointermove', async (e) => {
  if (!rz) return;
  const width = Math.max(280, Math.min(900, rz.w + (e.screenX - rz.sx)));
  const height = Math.max(300, Math.min(900, rz.h + (e.screenY - rz.sy)));
  const size = await window.noteApi.resize(width, height);
  if (size) {
    rz.sx = e.screenX; rz.sy = e.screenY;
    rz.w = size.width; rz.h = size.height;
    state.width = size.width; state.height = size.height;
  }
});
el.grip.addEventListener('pointerup', () => { rz = null; });
el.grip.addEventListener('pointercancel', () => { rz = null; });

boot();
