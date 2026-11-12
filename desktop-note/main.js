const {
  app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut,
  nativeImage, screen, safeStorage, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const DEFAULT_SERVER = 'https://bank-backend-f6ay.onrender.com';
const MIN_W = 280;
const MIN_H = 300;

let win = null;
let tray = null;
let pollTimer = 0;
let saveTimer = 0;
let state = {
  server: DEFAULT_SERVER,
  token: '',
  note: { title: '', text: '', color: 'yellow', font: 14, updatedAt: 0 },
  bounds: { width: 360, height: 430, x: null, y: null },
  alwaysOnTop: true,
};

const statePath = () => path.join(app.getPath('userData'), 'note-state.json');

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state = { ...state, ...raw, note: { ...state.note, ...(raw.note || {}) }, bounds: { ...state.bounds, ...(raw.bounds || {}) } };
    if (raw.tokenEnc && safeStorage.isEncryptionAvailable()) {
      try { state.token = safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64')); } catch { state.token = ''; }
    }
    delete state.tokenEnc;
  } catch { /* first run */ }
}

function saveState() {
  try {
    const { tokenEnc, ...rest } = state;
    const out = { ...rest, token: '' };
    if (state.token && safeStorage.isEncryptionAvailable()) {
      out.tokenEnc = safeStorage.encryptString(state.token).toString('base64');
    } else if (state.token) {
      out.tokenEnc = '';
    }
    fs.writeFileSync(statePath(), JSON.stringify(out));
  } catch (e) { console.error('save state', e.message); }
}

const queueState = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); };

function visibleBounds(b) {
  const area = screen.getPrimaryDisplay().workArea;
  const displays = screen.getAllDisplays();
  const w = Math.max(MIN_W, Math.min(Number(b.width) || 360, 900));
  const h = Math.max(MIN_H, Math.min(Number(b.height) || 430, 900));
  let x = Number.isFinite(b.x) ? b.x : Math.round(area.x + area.width - w - 32);
  let y = Number.isFinite(b.y) ? b.y : Math.round(area.y + 40);
  const onScreen = displays.some((d) => {
    const a = d.workArea;
    return x + w > a.x + 40 && x < a.x + a.width - 40 && y + h > a.y + 20 && y < a.y + a.height - 40;
  });
  if (!onScreen) {
    x = Math.round(area.x + area.width - w - 32);
    y = Math.round(area.y + 40);
  }
  return { x, y, width: w, height: h };
}

function apiUrl(p) {
  return String(state.server || DEFAULT_SERVER).replace(/\/+$/, '') + p;
}

async function apiFetch(p, opts = {}) {
  const res = await fetch(apiUrl(p), {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non json */ }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json && json.data !== undefined ? json.data : json;
}

function normalizeNote(n) {
  return {
    title: String((n && n.title) || '').slice(0, 200),
    text: String((n && n.text) || '').slice(0, 20000),
    color: ['yellow', 'pink', 'mint', 'sky'].includes(n && n.color) ? n.color : 'yellow',
    font: Math.max(12, Math.min(22, Math.round(Number(n && n.font) || 14))),
    updatedAt: Number((n && n.updatedAt) || 0),
  };
}

function pushNote(n) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('note:remote', normalizeNote(n));
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!state.token || !win || win.isDestroyed()) return;
    try {
      const n = normalizeNote(await apiFetch('/admin/api/note'));
      if (n.updatedAt > state.note.updatedAt) {
        state.note = n;
        queueState();
        pushNote(n);
      }
    } catch { /* offline — keep working locally */ }
  }, 20000);
  connectNoteStream();
}

/* live channel — the web panel saves the note and it lands here at once */
let noteWs = null;
let noteWsTimer = 0;
let noteWsTry = 0;

function connectNoteStream() {
  if (!state.token || noteWs) return;
  const base = apiUrl('').replace(/^http/, 'ws');
  let ws;
  try {
    ws = new WebSocket(`${base}/note-ws?token=${encodeURIComponent(state.token)}`);
  } catch { return; }
  noteWs = ws;
  let handshake = 0;
  const settle = () => { clearTimeout(handshake); handshake = 0; };
  // proxies can swallow close frames, so give up on a socket that never gets ready
  handshake = setTimeout(() => { settle(); try { ws.close(); } catch (_) {} }, 10000);
  ws.on('open', () => { noteWsTry = 0; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'ready') { settle(); pullNow(); return; }
    if (m.type === 'auth_error') {
      settle();
      noteWs = null;
      try { ws.close(); } catch (_) {}
      return;
    }
    if (m.type !== 'note' || !m.note) return;
    const n = normalizeNote(m.note);
    if (!(n.updatedAt > state.note.updatedAt)) return;
    state.note = n;
    queueState();
    pushNote(n);
  });
  const retry = () => {
    settle();
    if (noteWs !== ws) return;
    noteWs = null;
    clearTimeout(noteWsTimer);
    noteWsTry = Math.min(noteWsTry + 1, 5);
    noteWsTimer = setTimeout(connectNoteStream, 1000 * 2 ** (noteWsTry - 1));
  };
  ws.on('close', retry);
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

function closeNoteStream() {
  clearTimeout(noteWsTimer);
  const ws = noteWs;
  noteWs = null;
  if (ws) { ws.removeAllListeners(); try { ws.close(); } catch (_) {} }
}

function createWindow() {
  const b = visibleBounds(state.bounds);
  win = new BrowserWindow({
    ...b,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'Aura Sticky Note',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(!!state.alwaysOnTop, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const { x, y, width, height } = win.getBounds();
    state.bounds = { x, y, width, height };
    queueState();
  };
  // 'moved'/'resized' are macOS-only; Windows fires 'move'/'resize' continuously
  win.on('move', remember);
  win.on('resize', remember);
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function buildTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Aura Sticky Note');
  const refresh = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'បង្ហាញចំណាំ', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      {
        label: 'នៅលើគេជានិច្ច (Always on top)',
        type: 'checkbox',
        checked: !!state.alwaysOnTop,
        click: (item) => applyAlwaysOnTop(item.checked),
      },
      {
        label: 'បើកដោយស្វ័យប្រវត្តិពេលចាប់ផ្តើម Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: [] }),
      },
      { type: 'separator' },
      { label: state.token ? 'ភ្ជាប់រួច — sync ស្វ័យប្រវត្តិ' : 'មិនទាន់ភ្ជាប់គណនី', enabled: false },
      { label: 'Sync ឥឡូវ', click: () => { pullNow(); } },
      { type: 'separator' },
      { label: 'បើកផ្ទាំងគ្រប់គ្រង', click: () => shell.openExternal(apiUrl('/admin')) },
      { label: 'ចាកចេញ', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };
  refresh();
  tray.on('click', () => { if (win.isVisible()) win.hide(); else { win.show(); win.focus(); } });
  tray.on('right-click', refresh);
  return refresh;
}

function applyAlwaysOnTop(on) {
  state.alwaysOnTop = !!on;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!on, 'floating');
  queueState();
  if (win && !win.isDestroyed()) win.webContents.send('win:top', state.alwaysOnTop);
}

async function pullNow() {
  if (!state.token) return null;
  try {
    const n = normalizeNote(await apiFetch('/admin/api/note'));
    if (n.updatedAt >= state.note.updatedAt) {
      state.note = n;
      queueState();
      pushNote(n);
    }
    return n;
  } catch { return null; }
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    note: state.note,
    connected: !!state.token,
    server: state.server,
    alwaysOnTop: !!state.alwaysOnTop,
    version: app.getVersion(),
    size: win && !win.isDestroyed() ? { width: win.getBounds().width, height: win.getBounds().height } : null,
  }));

  ipcMain.handle('auth:login', async (_e, { server, email, password }) => {
    const base = String(server || DEFAULT_SERVER).trim().replace(/\/+$/, '');
    state.server = base || DEFAULT_SERVER;
    const data = await apiFetch('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: String(email || '').trim(), password: String(password || '') }),
    });
    state.token = data.token || '';
    if (!state.token) throw new Error('មិនបានទទួល token');
    queueState();
    // adopt the shared note unless this machine holds a newer one (it may have
    // been edited while the app pointed at another server or was offline)
    try {
      const n = normalizeNote(await apiFetch('/admin/api/note'));
      if (n.updatedAt && n.updatedAt >= state.note.updatedAt) {
        state.note = n;
      } else if (state.note.title || state.note.text) {
        const saved = normalizeNote(await apiFetch('/admin/api/note', {
          method: 'PUT',
          body: JSON.stringify({ title: state.note.title, text: state.note.text, color: state.note.color, font: state.note.font }),
        }));
        state.note = saved;
      }
    } catch { /* keep local */ }
    queueState();
    startPolling();
    return { ok: true, note: state.note, admin: data.admin || null };
  });

  ipcMain.handle('auth:logout', () => {
    state.token = '';
    queueState();
    clearInterval(pollTimer);
    closeNoteStream();
    return { ok: true };
  });

  ipcMain.handle('note:save', async (_e, payload) => {
    const local = normalizeNote({ ...payload, updatedAt: state.note.updatedAt });
    state.note = local;
    queueState();
    if (!state.token) return { ok: true, offline: true, updatedAt: local.updatedAt };
    try {
      const saved = normalizeNote(await apiFetch('/admin/api/note', {
        method: 'PUT',
        body: JSON.stringify({ title: local.title, text: local.text, color: local.color, font: local.font }),
      }));
      state.note = saved;
      queueState();
      return { ok: true, updatedAt: saved.updatedAt };
    } catch (err) {
      return { ok: false, offline: true, error: err.message, updatedAt: local.updatedAt };
    }
  });

  ipcMain.handle('note:pull', async () => pullNow());
  ipcMain.handle('win:top', (_e, on) => { applyAlwaysOnTop(on); return state.alwaysOnTop; });
  ipcMain.handle('win:hide', () => { win.hide(); return true; });
  // transparent frameless windows lose the native resize border on Windows,
  // so the renderer drives the size from its own corner grip
  ipcMain.handle('win:resize', (_e, { width, height }) => {
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    const w = Math.max(MIN_W, Math.min(900, Math.round(Number(width) || b.width)));
    const h = Math.max(MIN_H, Math.min(900, Math.round(Number(height) || b.height)));
    if (w !== b.width || h !== b.height) win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    return { width: w, height: h };
  });
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); return true; });
  ipcMain.handle('app:openAdmin', () => { shell.openExternal(apiUrl('/admin')); return true; });
  ipcMain.handle('app:status', () => ({
    connected: !!state.token, alwaysOnTop: !!state.alwaysOnTop, server: state.server,
    autostart: app.getLoginItemSettings().openAtLogin,
    hotkey: globalShortcut.isRegistered('Alt+N'),
    visible: !!win && !win.isDestroyed() && win.isVisible(),
  }));
  ipcMain.handle('app:autostart', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, args: [] });
    return app.getLoginItemSettings().openAtLogin;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    loadState();
    registerIpc();
    createWindow();
    buildTray();
    startPolling();
    globalShortcut.register('Alt+N', () => {
      if (!win) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else { win.show(); win.focus(); }
    }) || console.warn('⚠️ Alt+N hotkey is taken by another app');
    app.on('activate', () => { if (win) win.show(); });
  });

  app.on('window-all-closed', (e) => { e.preventDefault(); });
  app.on('before-quit', () => { app.isQuitting = true; saveState(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
