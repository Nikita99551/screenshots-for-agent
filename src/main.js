// Главный процесс: трей, горячие клавиши, захват экрана, очередь снимков, буфер обмена, голосовой ввод.
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session,
  desktopCapturer, nativeImage, Notification, shell, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HOTKEY_CAPTURE = 'CommandOrControl+Shift+S';
const HOTKEY_PANEL = 'CommandOrControl+Shift+D';
const APP_TITLE = 'Скриншоты для агента';
// В установленной программе скрипты, сервер распознавания и Python лежат в resources/, при разработке — рядом с src/.
const RES_DIR = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(RES_DIR, 'scripts');
const STT_DIR = path.join(RES_DIR, 'stt');
const STT_PYTHON = app.isPackaged ? path.join(RES_DIR, 'python', 'python.exe') : path.join(STT_DIR, '.venv', 'Scripts', 'python.exe');
const STT_SCRIPT = path.join(STT_DIR, 'stt_server.py');

// Одна папка данных и для разработки, и для установленной программы (иначе имя папки взялось бы из productName).
app.setPath('userData', path.join(app.getPath('appData'), 'screenshots-for-agent'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const dataDir = app.getPath('userData');
const shotsDir = path.join(dataDir, 'shots');
const exportDir = path.join(dataDir, 'export');
const queueFile = path.join(dataDir, 'queue.json');
const settingsFile = path.join(dataDir, 'settings.json');
const rawShotFile = path.join(dataDir, 'capture.raw');
const preload = path.join(__dirname, 'preload.js');

let queue = [];
let panelWin = null;
let captureWin = null;
let captureOpen = false;
let captureShowTimer = null;
let tray = null;
let quitting = false;
let panelExpanded = false;
const PANEL_COMPACT = { width: 120, height: 40 };
const PANEL_FULL = { width: 400, height: 620 };

// постоянный помощник (снимок экрана GDI, перехват Ctrl+V, нажатие Ctrl+V)
let helper = null;
let helperReady = false;
let shotSeq = 0;
const shotWaiters = new Map();
let pendingText = null;
let pendingTimer = null;

function log(msg) {
  try { fs.appendFileSync(path.join(dataDir, 'app.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* нет доступа */ }
}
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${(e && e.stack) || e}`));
const now = () => Number(process.hrtime.bigint() / 1000000n);

// ---------- настройки ----------
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { settings = {}; }
}
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); }

// ---------- очередь ----------
function shotPath(id) { return path.join(shotsDir, `${id}.png`); }

function loadQueue() {
  try { queue = JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch { queue = []; }
  queue = queue.filter((it) => it && it.id && fs.existsSync(shotPath(it.id)));
}

function saveQueue() {
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

function publicItem(it) {
  return { ...it, thumb: `file:///${shotPath(it.id).replace(/\\/g, '/')}?v=${it.updatedAt || 0}` };
}

function broadcastQueue() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('queue:changed', queue.map(publicItem));
  }
}

function readShotDataUrl(id) {
  return 'data:image/png;base64,' + fs.readFileSync(shotPath(id)).toString('base64');
}

// ---------- иконка (рисуем программно, без файлов) ----------
function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const i = (y * size + x) * 4;
      let col = null; // BGRA
      if (d <= c * 0.42) col = [255, 255, 255, 255];
      else if (d <= c * 0.58) col = [40, 30, 20, 255];
      else if (d <= c - 0.5) col = [40, 90, 255, 255]; // оранжевый (B,G,R)
      if (col) { buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = col[3]; }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ---------- помощник ----------
function startHelper() {
  if (helper) return;
  const script = path.join(SCRIPTS_DIR, 'helper.ps1');
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  let buf = '';
  helper.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      onHelperLine(line);
    }
  });
  helper.stderr.on('data', (d) => log(`helper stderr: ${d}`));
  helper.on('exit', (code) => {
    log(`helper exit ${code}`);
    helper = null; helperReady = false;
    for (const [, w] of shotWaiters) w.reject(new Error('helper exited'));
    shotWaiters.clear();
    if (!quitting) setTimeout(startHelper, 2000);
  });
}

function onHelperLine(line) {
  if (line === 'READY') { helperReady = true; log('helper ready'); return; }
  if (line === 'HOOK_FAILED') { log('helper: hook failed'); return; }
  if (line === 'CTRLV') { onUserPaste(); return; }
  if (line.startsWith('SHOT ')) {
    const [, id, status, ...rest] = line.split(' ');
    const w = shotWaiters.get(id);
    if (!w) return;
    shotWaiters.delete(id);
    if (status === 'ok') w.resolve({ width: Number(rest[0]), height: Number(rest[1]), ms: Number(rest[2]) });
    else w.reject(new Error(rest.join(' ')));
    return;
  }
  if (line) log(`helper: ${line}`);
}

function helperSend(cmd) {
  if (!helper) return false;
  try { helper.stdin.write(`${cmd}\n`); return true; } catch (e) { log(`helper send: ${e.message}`); return false; }
}

function helperShot(rect) {
  return new Promise((resolve, reject) => {
    if (!helperReady) { reject(new Error('helper not ready')); return; }
    const id = String(++shotSeq);
    const timer = setTimeout(() => { shotWaiters.delete(id); reject(new Error('timeout')); }, 1500);
    shotWaiters.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    helperSend(`shot ${id} ${rect.x} ${rect.y} ${rect.width} ${rect.height} ${rawShotFile}`);
  });
}

// Снимок экрана как сырые пиксели BGRA. Сначала быстрый помощник, при сбое — средства Electron.
async function grabDisplay(display) {
  const t0 = now();
  try {
    const p = screen.dipToScreenRect(null, display.bounds);
    const sf = display.scaleFactor || 1;
    const phys = { x: p.x, y: p.y, width: Math.floor(display.size.width * sf), height: Math.floor(display.size.height * sf) };
    // GDI-снимок не учитывает защиту окна, поэтому панель на мгновение делаем прозрачной
    const hidePanel = panelWin && !panelWin.isDestroyed() && panelWin.isVisible();
    if (hidePanel) { panelWin.setOpacity(0); await new Promise((r) => setTimeout(r, 40)); }
    let r;
    try { r = await helperShot(phys); } finally { if (hidePanel) panelWin.setOpacity(1); }
    const raw = fs.readFileSync(rawShotFile);
    log(`grab helper ${r.width}x${r.height} blt=${r.ms}ms total=${now() - t0}ms`);
    return { raw, width: r.width, height: r.height };
  } catch (e) {
    log(`grab helper failed (${e.message}), fallback`);
  }
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
  });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) throw new Error('нет источника экрана');
  const size = src.thumbnail.getSize();
  log(`grab fallback total=${now() - t0}ms`);
  return { raw: src.thumbnail.toBitmap(), width: size.width, height: size.height };
}

// ---------- окна ----------
function createPanel() {
  const { workArea } = screen.getPrimaryDisplay();
  const { width: w, height: h } = PANEL_COMPACT;
  panelWin = new BrowserWindow({
    width: w,
    height: h,
    minWidth: PANEL_COMPACT.width,
    minHeight: PANEL_COMPACT.height,
    x: workArea.x + workArea.width - w - 16,
    y: workArea.y + workArea.height - h - 16,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    title: APP_TITLE,
    icon: makeIcon(64),
    backgroundColor: '#17171a',
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  // Панель не попадает в снимки: её не нужно прятать перед захватом.
  panelWin.setContentProtection(true);
  panelWin.loadFile(path.join(__dirname, 'panel', 'panel.html'));
  panelWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); panelWin.hide(); }
  });
  panelWin.webContents.on('did-finish-load', broadcastQueue);
}

// Меняет размер панели, сохраняя правый нижний угол на месте.
function setPanelExpanded(on) {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelExpanded = Boolean(on);
  const b = panelWin.getBounds();
  const size = panelExpanded ? PANEL_FULL : PANEL_COMPACT;
  const right = b.x + b.width; const bottom = b.y + b.height;
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.max(wa.x, Math.min(right - size.width, wa.x + wa.width - size.width));
  const y = Math.max(wa.y, Math.min(bottom - size.height, wa.y + wa.height - size.height));
  panelWin.setBounds({ x, y, width: size.width, height: size.height });
  panelWin.webContents.send('panel:expanded', panelExpanded);
}

function showPanel(focus = true) {
  if (!panelWin || panelWin.isDestroyed()) createPanel();
  const doShow = () => { if (focus) { panelWin.show(); panelWin.focus(); } else panelWin.showInactive(); };
  // показывать до загрузки нельзя: Windows не отрисует окно, пока по нему не кликнут
  if (panelWin.webContents.isLoading()) panelWin.once('ready-to-show', doShow); else doShow();
}

function togglePanel() {
  if (panelWin && panelWin.isVisible()) panelWin.hide();
  else showPanel();
}

// Окно захвата создаётся один раз и потом только показывается/прячется.
function createCaptureWin() {
  const d = screen.getPrimaryDisplay();
  captureWin = new BrowserWindow({
    ...d.bounds,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Снимок',
    backgroundColor: '#000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.setMenuBarVisibility(false);
  captureWin.loadFile(path.join(__dirname, 'capture', 'capture.html'));
  captureWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); closeCapture(); }
  });
  captureWin.on('closed', () => { captureWin = null; captureOpen = false; });
}

function closeCapture() {
  clearTimeout(captureShowTimer);
  captureOpen = false;
  if (!captureWin || captureWin.isDestroyed()) return;
  captureWin.setOpacity(0);
  captureWin.hide();
  captureWin.webContents.send('capture:reset');
}

function revealCapture() {
  clearTimeout(captureShowTimer);
  if (!captureWin || captureWin.isDestroyed() || !captureOpen) return;
  captureWin.setOpacity(1);
  captureWin.focus();
  captureWin.webContents.focus();
}

// Запуск захвата: editItem — редактировать существующий снимок, иначе новый.
let captureT0 = 0;
async function startCapture(editItem) {
  captureT0 = now();
  if (captureOpen) { if (captureWin) captureWin.focus(); return; }
  if (!captureWin || captureWin.isDestroyed()) createCaptureWin();
  captureOpen = true;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  let payload;
  try {
    if (editItem) {
      payload = { mode: 'edit', item: editItem, image: readShotDataUrl(editItem.id) };
    } else {
      const g = await grabDisplay(display);
      payload = { mode: 'select', raw: g.raw, width: g.width, height: g.height, scaleFactor: display.scaleFactor || 1 };
    }
  } catch (e) {
    captureOpen = false;
    log(`capture failed: ${e.message}`);
    notify('Не удалось получить изображение экрана');
    return;
  }

  // Показываем прозрачным, рисуем, потом проявляем: без мелькания старого кадра.
  captureWin.setOpacity(0);
  captureWin.setBounds(display.bounds);
  captureWin.show();
  captureWin.webContents.send('capture:init', payload);
  captureShowTimer = setTimeout(revealCapture, 1200); // страховка, если окно не ответило
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: APP_TITLE, body, icon: makeIcon(64) }).show();
}

// ---------- буфер обмена: файлы + текст через PowerShell ----------
function copyToClipboard(filePaths, text) {
  return new Promise((resolve) => {
    const manifest = path.join(exportDir, 'clip.json');
    fs.writeFileSync(manifest, JSON.stringify({ files: filePaths, text }), 'utf8');
    const script = path.join(SCRIPTS_DIR, 'copy-to-clipboard.ps1');
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Manifest', manifest,
    ], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => resolve({ ok: code === 0, error: err.trim() }));
    ps.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// ---------- двухшаговая вставка ----------
function armSecondPaste(text) {
  pendingText = text;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(disarmSecondPaste, 3 * 60 * 1000); // ждём вставку не дольше 3 минут
  helperSend('arm');
}

function disarmSecondPaste() {
  pendingText = null;
  clearTimeout(pendingTimer);
  helperSend('disarm');
}

function onUserPaste() {
  if (!pendingText) return;
  const text = pendingText;
  disarmSecondPaste();
  setTimeout(() => {
    clipboard.writeText(text);
    setTimeout(() => helperSend('paste'), 120);
  }, 700);
}

// ---------- голосовой ввод: локальный GigaAM v3 (stt/stt_server.py) ----------
let stt = null;
let sttReady = false;
let sttError = '';
let sttSeq = 0;
const sttWaiters = new Map();
let sttRestarts = 0;
// Сначала модель ищется только на диске (без сети). Если её нет — перезапуск с разрешённой сетью:
// при первом запуске на новом компьютере модель (~220 МБ) скачивается сама.
let sttOnline = false;
let sttDownloading = false;
let sttSwitchToOnline = false;

function startStt() {
  if (stt) return;
  if (!fs.existsSync(STT_PYTHON)) { sttError = 'не найден Python для распознавания'; log(`stt: ${sttError} (${STT_PYTHON})`); return; }
  sttReady = false; sttError = '';
  sttDownloading = sttOnline;
  stt = spawn(STT_PYTHON, ['-u', STT_SCRIPT], {
    windowsHide: true,
    cwd: STT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', HF_HUB_OFFLINE: sttOnline ? '0' : '1' },
  });
  let buf = '';
  stt.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log(`stt: ${line}`); continue; }
      if ('ready' in msg) {
        sttReady = Boolean(msg.ready);
        sttDownloading = false;
        log(`stt ready=${sttReady} online=${sttOnline} ${msg.load_sec || ''}s ${msg.error || ''}`);
        if (!sttReady && !sttOnline) { sttOnline = true; sttSwitchToOnline = true; sttDownloading = true; }
        else if (!sttReady) sttError = msg.error || 'ошибка загрузки';
        continue;
      }
      if (msg.log) { log(`stt: ${msg.log}`); continue; }
      const w = sttWaiters.get(String(msg.id));
      if (w) { sttWaiters.delete(String(msg.id)); w(msg); }
    }
  });
  stt.stderr.on('data', (d) => {
    const t = d.toString();
    if (/warn|Fetching \d+ files|%\|/i.test(t)) return; // предупреждения и полоса загрузки модели
    log(`stt stderr: ${t.slice(0, 300)}`);
  });
  stt.on('exit', (code) => {
    log(`stt exit ${code}`);
    stt = null; sttReady = false;
    for (const [, w] of sttWaiters) w({ ok: false, error: 'nostt' });
    sttWaiters.clear();
    if (quitting) return;
    if (sttSwitchToOnline) { sttSwitchToOnline = false; log('stt: модели нет на диске, скачиваю'); startStt(); return; }
    if (sttRestarts++ < 3) setTimeout(startStt, 3000);
  });
}

async function waitStt(ms) {
  const t0 = now();
  while (!sttReady && stt && now() - t0 < ms) await new Promise((r) => setTimeout(r, 150));
  return sttReady;
}

async function transcribe(pcm) {
  if (!stt) startStt();
  if (sttDownloading) return { ok: false, error: 'downloading' };
  if (!(await waitStt(30000))) return { ok: false, error: sttDownloading ? 'downloading' : (stt ? 'loading' : 'nostt') };
  const id = String(++sttSeq);
  const file = path.join(dataDir, `voice-${id}.f32`);
  fs.writeFileSync(file, Buffer.from(pcm));
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => { sttWaiters.delete(id); resolve({ ok: false, error: 'timeout' }); }, 60000);
    sttWaiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    stt.stdin.write(`tr ${id} ${file}\n`);
  });
  try { fs.unlinkSync(file); } catch { /* уже нет */ }
  if (res.ok) log(`stt ok ${res.sec}s audio in ${res.ms}ms`);
  else log(`stt error: ${res.error}`);
  return res.ok ? { ok: true, text: res.text || '' } : { ok: false, error: res.error === 'timeout' || res.error === 'nostt' || res.error === 'loading' ? res.error : 'nostt' };
}

// ---------- IPC ----------
ipcMain.handle('queue:get', () => queue.map(publicItem));
ipcMain.handle('shot:data', (_e, id) => readShotDataUrl(id));

ipcMain.on('capture:new', () => startCapture());
ipcMain.on('capture:cancel', () => closeCapture());
ipcMain.on('capture:ready', () => {
  revealCapture();
  log(`capture shown in ${now() - captureT0}ms`);
});

ipcMain.handle('capture:save', (_e, data) => {
  // data: { id?, image? (dataURL нового снимка), width, height, annotations, comment }
  let item = data.id ? queue.find((q) => q.id === data.id) : null;
  if (item) {
    item.annotations = data.annotations || [];
    item.comment = data.comment || '';
    item.updatedAt = Date.now();
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const base64 = String(data.image).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(shotPath(id), Buffer.from(base64, 'base64'));
    item = {
      id,
      width: data.width,
      height: data.height,
      annotations: data.annotations || [],
      comment: data.comment || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    queue.push(item);
  }
  saveQueue();
  closeCapture();
  broadcastQueue();
  return item.id;
});

ipcMain.handle('queue:update', (_e, { id, comment }) => {
  const item = queue.find((q) => q.id === id);
  if (item) { item.comment = comment; saveQueue(); }
  return true;
});

ipcMain.handle('queue:move', (_e, { id, dir }) => {
  const i = queue.findIndex((q) => q.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= queue.length) return false;
  [queue[i], queue[j]] = [queue[j], queue[i]];
  saveQueue();
  broadcastQueue();
  return true;
});

ipcMain.handle('queue:delete', (_e, id) => {
  const item = queue.find((q) => q.id === id);
  if (item) {
    queue = queue.filter((q) => q.id !== id);
    try { fs.unlinkSync(shotPath(id)); } catch { /* файла уже нет */ }
    saveQueue();
    broadcastQueue();
  }
  return true;
});

ipcMain.handle('queue:clear', () => {
  for (const it of queue) { try { fs.unlinkSync(shotPath(it.id)); } catch { /* пусто */ } }
  queue = [];
  saveQueue();
  broadcastQueue();
  return true;
});

ipcMain.on('queue:edit', (_e, id) => {
  const item = queue.find((q) => q.id === id);
  if (item) startCapture(item);
});

// files: [{ name, dataUrl }], text: строка с комментариями
ipcMain.handle('queue:copy', async (_e, { files, text, twoStep }) => {
  fs.rmSync(exportDir, { recursive: true, force: true });
  fs.mkdirSync(exportDir, { recursive: true });
  const paths = [];
  for (const f of files) {
    const p = path.join(exportDir, f.name);
    fs.writeFileSync(p, Buffer.from(String(f.dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
    paths.push(p);
  }
  const res = await copyToClipboard(paths, text);
  if (res.ok && twoStep && text) armSecondPaste(text); else disarmSecondPaste();
  return { ...res, count: paths.length, folder: exportDir };
});

ipcMain.handle('clipboard:text', (_e, text) => { disarmSecondPaste(); clipboard.writeText(text); return true; });
ipcMain.handle('panel:expand', (_e, on) => { setPanelExpanded(on); return panelExpanded; });

ipcMain.on('panel:hide', () => { if (panelWin) panelWin.hide(); });
ipcMain.handle('panel:pin', (_e, on) => { if (panelWin) panelWin.setAlwaysOnTop(Boolean(on)); return Boolean(on); });
ipcMain.handle('app:info', () => ({ hotkeyCapture: 'Ctrl+Shift+S', hotkeyPanel: 'Ctrl+Shift+D', dataDir }));
ipcMain.on('app:open-folder', () => shell.openPath(dataDir));

ipcMain.handle('voice:status', () => ({ ready: sttReady, error: sttError, downloading: sttDownloading }));
ipcMain.handle('voice:transcribe', (_e, { pcm }) => transcribe(pcm));

// ---------- трей ----------
function buildTray() {
  tray = new Tray(makeIcon(32));
  tray.setToolTip(`${APP_TITLE} · Ctrl+Shift+S`);
  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Новый снимок\tCtrl+Shift+S', click: () => startCapture() },
      { label: 'Показать / скрыть панель\tCtrl+Shift+D', click: togglePanel },
      { type: 'separator' },
      {
        label: 'Запускать с Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (mi) => {
          app.setLoginItemSettings({
            openAtLogin: mi.checked,
            path: process.execPath,
            args: app.isPackaged ? [] : [app.getAppPath()],
          });
          rebuild();
        },
      },
      { label: 'Открыть папку снимков', click: () => shell.openPath(dataDir) },
      { type: 'separator' },
      { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  tray.on('click', togglePanel);
}

// ---------- старт ----------
app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => { /* живём в трее */ });
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  helperSend('quit');
  if (stt) { try { stt.stdin.write('quit\n'); } catch { /* уже закрыт */ } }
});

app.whenReady().then(() => {
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });
  loadSettings();
  loadQueue();

  // микрофон разрешён только нашим окнам
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  startHelper();
  startStt();
  createPanel();
  createCaptureWin();
  buildTray();

  const ok1 = globalShortcut.register(HOTKEY_CAPTURE, () => startCapture());
  const ok2 = globalShortcut.register(HOTKEY_PANEL, togglePanel);
  log(`start; hotkeys: capture=${ok1} panel=${ok2}`);
  if (!ok1) notify('Не удалось занять Ctrl+Shift+S: клавиша занята другой программой');
  if (!ok2) notify('Не удалось занять Ctrl+Shift+D');

  showPanel(false);
});
