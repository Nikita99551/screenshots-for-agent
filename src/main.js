// Главный процесс: трей, горячие клавиши, захват экрана, очередь снимков, буфер обмена, голосовой ввод.
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, session,
  desktopCapturer, nativeImage, Notification, shell, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Горячие клавиши по умолчанию; свои хранятся в settings.json (настраиваются в панели).
const DEFAULT_HOTKEYS = { capture: 'CommandOrControl+Shift+S', panel: 'CommandOrControl+Shift+D', voice: 'Control+Space' };
const HISTORY_LIMIT = 30;
// Словарь замен после распознавания речи: «что = на что», звёздочка — любое окончание слова.
const DEFAULT_DICTIONARY = [
  'фигм* = Figma',
  'клод* = Claude',
  'клауд = Claude',
  'чат джипити* = ChatGPT',
  'чат гпт = ChatGPT',
  'джипити = GPT',
  'гитхаб* = GitHub',
  'реакт* = React',
  'тайпскрипт* = TypeScript',
  'джаваскрипт* = JavaScript',
  'апи = API',
  'юай = UI',
  'юикс = UX',
].join('\n');
const APP_TITLE = 'Скриншоты для агента';
// В установленной программе скрипты, сервер распознавания и Python лежат в resources/, при разработке — рядом с src/.
const RES_DIR = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(RES_DIR, 'scripts');
const STT_DIR = path.join(RES_DIR, 'stt');
const STT_PYTHON = app.isPackaged ? path.join(RES_DIR, 'python', 'python.exe') : path.join(STT_DIR, '.venv', 'Scripts', 'python.exe');
const STT_SCRIPT = path.join(STT_DIR, 'stt_server.py');

// Одна папка данных и для разработки, и для установленной программы (иначе имя папки взялось бы из productName).
app.setPath('userData', process.env.SFA_USERDATA || path.join(app.getPath('appData'), 'screenshots-for-agent'));
// Самопроверка (npm run selftest): невидимо делает снимок, сохраняет и копирует, пишет время шагов в app.log.
const SELFTEST = process.env.SFA_SELFTEST === '1';

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
const clipWaiters = new Map();
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
    for (const [, w] of clipWaiters) w({ ok: false, error: 'helper exited' });
    clipWaiters.clear();
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
  if (line.startsWith('CLIP ')) {
    const [, id, status, ...rest] = line.split(' ');
    const w = clipWaiters.get(id);
    if (!w) return;
    clipWaiters.delete(id);
    w(status === 'ok' ? { ok: true, ms: Number(rest[0]) } : { ok: false, error: status === 'busy' ? 'busy' : rest.join(' '), detail: rest.join(' ') });
    return;
  }
  if (line) log(`helper: ${line}`);
}

function helperSend(cmd) {
  if (!helper) return false;
  try { helper.stdin.write(`${cmd}\n`); return true; } catch (e) { log(`helper send: ${e.message}`); return false; }
}

function helperShot(rect, flush = 0) {
  return new Promise((resolve, reject) => {
    if (!helperReady) { reject(new Error('helper not ready')); return; }
    const id = String(++shotSeq);
    const timer = setTimeout(() => { shotWaiters.delete(id); reject(new Error('timeout')); }, 1500);
    shotWaiters.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    helperSend(`shot ${id} ${rect.x} ${rect.y} ${rect.width} ${rect.height} ${flush} ${rawShotFile}`);
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
    // вместо паузы 40 мс помощник ждёт, пока Windows дорисует кадр без панели (DwmFlush)
    if (hidePanel) panelWin.setOpacity(0);
    let r;
    try { r = await helperShot(phys, hidePanel ? 2 : 0); } finally { if (hidePanel) panelWin.setOpacity(1); }
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
    // без фонового торможения: иначе кодирование PNG в свёрнутой/скрытой панели ждёт до 5 с
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
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
  if (SELFTEST) return; // в самопроверке окно остаётся прозрачным и не забирает фокус
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
      payload = { mode: 'edit', item: editItem, image: readShotDataUrl(editItem.id), index: queue.indexOf(editItem) + 1 };
    } else {
      const g = await grabDisplay(display);
      payload = { mode: 'select', raw: g.raw, width: g.width, height: g.height, scaleFactor: display.scaleFactor || 1, index: queue.length + 1 };
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
  if (SELFTEST) captureWin.showInactive(); else captureWin.show();
  payload.voiceKey = hotkeys().voice;
  captureWin.webContents.send('capture:init', payload);
  captureShowTimer = setTimeout(revealCapture, 1200); // страховка, если окно не ответило
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: APP_TITLE, body, icon: makeIcon(64) }).show();
}

// ---------- буфер обмена: файлы + текст через PowerShell ----------
// Через постоянный помощник: ~20 мс. Запасной путь — отдельный PowerShell (1–3 с на запуск).
async function copyToClipboard(filePaths, text) {
  if (helperReady) {
    const manifest = path.join(exportDir, 'clip.txt');
    await fs.promises.writeFile(manifest, [String(filePaths.length), ...filePaths, text || ''].join('\n'), 'utf8');
    const id = String(++shotSeq);
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => { clipWaiters.delete(id); resolve({ ok: false, error: 'timeout' }); }, 5000);
      clipWaiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
      if (!helperSend(`clip ${id} ${manifest}`)) { clipWaiters.delete(id); clearTimeout(timer); resolve({ ok: false, error: 'helper' }); }
    });
    if (res.ok) return res;
    // буфер занят другой программой: запасной путь упрётся в то же самое, сразу говорим пользователю
    if (res.error === 'busy') { log(`clip: clipboard busy (${res.detail})`); return res; }
    log(`clip via helper failed: ${res.error}, fallback`);
  }
  return copyToClipboardSlow(filePaths, text);
}

function copyToClipboardSlow(filePaths, text) {
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
  return res.ok ? { ok: true, text: applyDictionary(res.text || '') } : { ok: false, error: res.error === 'timeout' || res.error === 'nostt' || res.error === 'loading' ? res.error : 'nostt' };
}

// ---------- IPC ----------
ipcMain.handle('queue:get', () => queue.map(publicItem));
ipcMain.handle('shot:data', (_e, id) => readShotDataUrl(id));
ipcMain.handle('shot:bytes', (_e, id) => fs.promises.readFile(shotPath(id)));

ipcMain.on('capture:new', () => startCapture());
ipcMain.on('capture:cancel', () => closeCapture());
ipcMain.on('capture:ready', () => {
  revealCapture();
  log(`capture shown in ${now() - captureT0}ms`);
});

// Окно прячется сразу по Enter, а PNG кодируется и сохраняется уже в фоне.
ipcMain.on('capture:hide', () => closeCapture());

ipcMain.handle('capture:save', async (_e, data) => {
  // data: { id?, png? (ArrayBuffer нового снимка), width, height, annotations, comment }
  const t0 = now();
  let item = data.id ? queue.find((q) => q.id === data.id) : null;
  if (item) {
    item.annotations = data.annotations || [];
    item.comment = data.comment || '';
    item.updatedAt = Date.now();
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await fs.promises.writeFile(shotPath(id), Buffer.from(data.png));
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
  broadcastQueue();
  log(`save ${data.png ? Math.round(data.png.byteLength / 1024) + 'KB' : 'edit'} main=${now() - t0}ms`);
  return item.id;
});

ipcMain.on('app:log', (_e, msg) => log(`ui: ${String(msg).slice(0, 300)}`));

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
// files: [{ name, data: ArrayBuffer PNG }]
ipcMain.handle('queue:copy', async (_e, { files, text, twoStep }) => {
  const t0 = now();
  await fs.promises.rm(exportDir, { recursive: true, force: true });
  await fs.promises.mkdir(exportDir, { recursive: true });
  const paths = files.map((f) => path.join(exportDir, f.name));
  await Promise.all(files.map((f, i) => fs.promises.writeFile(paths[i], Buffer.from(f.data))));
  const tWrite = now() - t0;
  const res = await copyToClipboard(paths, text);
  if (res.ok && twoStep && text && !SELFTEST) armSecondPaste(text); else disarmSecondPaste();
  log(`copy ${files.length} files: write=${tWrite}ms clipboard=${now() - t0 - tWrite}ms ok=${res.ok}`);
  if (res.ok) {
    const snapshot = queue.map((it) => ({ ...it, annotations: (it.annotations || []).map((a) => ({ ...a })) }));
    saveHistory(paths, text, snapshot).then(() => { if (panelWin) panelWin.webContents.send('history:changed'); })
      .catch((e) => log(`history save: ${e.message}`));
  }
  return { ...res, count: paths.length, folder: exportDir };
});

// ---------- история ----------
ipcMain.handle('history:list', async () => (await readHistory()).map(historyPublic));
ipcMain.handle('history:copy', async (_e, { id, twoStep }) => {
  const m = (await readHistory()).find((x) => x.id === id);
  if (!m) return { ok: false, error: 'not found' };
  const res = await copyToClipboard(m.files.map((f) => path.join(historyDir, id, f)), m.text);
  if (res.ok && twoStep && m.text && !SELFTEST) armSecondPaste(m.text); else disarmSecondPaste();
  return { ...res, count: m.files.length };
});
ipcMain.handle('history:restore', async (_e, id) => {
  const m = (await readHistory()).find((x) => x.id === id);
  if (!m) return 0;
  let n = 0;
  for (const it of m.items) {
    const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { await fs.promises.copyFile(path.join(historyDir, id, it.file), shotPath(newId)); } catch { continue; }
    const { file, ...rest } = it;
    queue.push({ ...rest, id: newId, createdAt: Date.now(), updatedAt: Date.now() });
    n++;
  }
  saveQueue();
  broadcastQueue();
  return n;
});
ipcMain.handle('history:delete', async (_e, id) => {
  if (!/^[a-z0-9]+$/.test(String(id))) return false;
  await fs.promises.rm(path.join(historyDir, id), { recursive: true, force: true });
  return true;
});

// ---------- настройки ----------
ipcMain.handle('settings:get', () => ({
  hotkeys: hotkeys(), hotkeyStatus: { ...hotkeyStatus }, dictionary: dictionaryText(), defaultDictionary: DEFAULT_DICTIONARY,
}));
ipcMain.handle('settings:set-hotkey', (_e, { name, acc }) => setHotkey(name, acc));
ipcMain.handle('settings:reset-hotkeys', () => { delete settings.hotkeys; saveSettings(); return registerHotkeys(); });
ipcMain.handle('settings:set-dictionary', (_e, text) => {
  settings.dictionary = String(text || '');
  saveSettings();
  return { ok: true, rules: dictionaryRules().length };
});

ipcMain.handle('clipboard:text', (_e, text) => { disarmSecondPaste(); clipboard.writeText(text); return true; });
ipcMain.handle('panel:expand', (_e, on) => { setPanelExpanded(on); return panelExpanded; });

ipcMain.on('panel:hide', () => { if (panelWin) panelWin.hide(); });
ipcMain.handle('panel:pin', (_e, on) => { if (panelWin) panelWin.setAlwaysOnTop(Boolean(on)); return Boolean(on); });
ipcMain.handle('app:info', () => ({ hotkeyCapture: 'Ctrl+Shift+S', hotkeyPanel: 'Ctrl+Shift+D', dataDir }));
ipcMain.on('app:open-folder', () => shell.openPath(dataDir));

ipcMain.handle('voice:status', () => ({ ready: sttReady, error: sttError, downloading: sttDownloading }));
ipcMain.handle('voice:transcribe', (_e, { pcm }) => transcribe(pcm));

// ---------- горячие клавиши ----------
function hotkeys() { return { ...DEFAULT_HOTKEYS, ...(settings.hotkeys || {}) }; }

function accLabel(acc) {
  return String(acc || '').split('+').map((p) => {
    const l = p.toLowerCase();
    if (l === 'commandorcontrol' || l === 'cmdorctrl' || l === 'control') return 'Ctrl';
    if (l === 'super') return 'Win';
    if (l === 'space') return 'Пробел';
    if (l === 'printscreen') return 'PrtSc';
    return p;
  }).join('+');
}

const hotkeyHandlers = { capture: () => startCapture(), panel: () => togglePanel() };
const hotkeyStatus = { capture: false, panel: false };

function tryRegister(acc, fn) {
  try { return globalShortcut.register(acc, fn); } catch (e) { log(`hotkey ${acc}: ${e.message}`); return false; }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = hotkeys();
  for (const name of ['capture', 'panel']) hotkeyStatus[name] = tryRegister(hk[name], hotkeyHandlers[name]);
  log(`hotkeys: capture=${hk.capture}:${hotkeyStatus.capture} panel=${hk.panel}:${hotkeyStatus.panel}`);
  if (tray) rebuildTrayMenu();
  return hotkeyStatus;
}

// Смена одной клавиши: новая регистрируется до сохранения, при неудаче остаётся старая.
function setHotkey(name, acc) {
  if (!DEFAULT_HOTKEYS[name]) return { ok: false, error: 'unknown' };
  const hk = hotkeys();
  if (Object.entries(hk).some(([n, a]) => n !== name && a.toLowerCase() === String(acc).toLowerCase())) return { ok: false, error: 'duplicate' };
  if (name !== 'voice') {
    const old = hk[name];
    try { globalShortcut.unregister(old); } catch { /* не была занята */ }
    if (!tryRegister(acc, hotkeyHandlers[name])) {
      hotkeyStatus[name] = tryRegister(old, hotkeyHandlers[name]);
      return { ok: false, error: 'busy' };
    }
    hotkeyStatus[name] = true;
  }
  settings.hotkeys = { ...(settings.hotkeys || {}), [name]: acc };
  saveSettings();
  rebuildTrayMenu();
  return { ok: true };
}

// ---------- словарь замен для голоса ----------
let dictCache = { text: null, rules: [] };
function dictionaryText() { return typeof settings.dictionary === 'string' ? settings.dictionary : DEFAULT_DICTIONARY; }

function dictionaryRules() {
  const text = dictionaryText();
  if (dictCache.text === text) return dictCache.rules;
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    let from = line.slice(0, i).trim().toLowerCase();
    const to = line.slice(i + 1).trim();
    if (!from || !to) continue;
    const stem = from.endsWith('*');
    if (stem) from = from.slice(0, -1);
    const body = from.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    try {
      rules.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${body}${stem ? '\\p{L}*' : ''}(?![\\p{L}\\p{N}])`, 'giu'), to });
    } catch (e) { log(`dictionary line skipped: ${line}`); }
  }
  dictCache = { text, rules };
  return rules;
}

function applyDictionary(text) {
  let out = String(text || '');
  for (const { re, to } of dictionaryRules()) out = out.replace(re, to);
  return out;
}

// ---------- история серий ----------
const historyDir = path.join(dataDir, 'history');

async function readHistory() {
  let dirs = [];
  try { dirs = await fs.promises.readdir(historyDir); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try { out.push(JSON.parse(await fs.promises.readFile(path.join(historyDir, d, 'meta.json'), 'utf8'))); } catch { /* битая запись */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// Сохраняет скопированную серию: готовые картинки (для повторного копирования) и исходники с разметкой (для возврата в очередь).
async function saveHistory(paths, text, items) {
  const signature = items.map((it) => `${it.id}:${it.updatedAt}:${it.comment}`).join('|');
  const list = await readHistory();
  if (list[0] && list[0].signature === signature) {
    list[0].createdAt = Date.now();
    await fs.promises.writeFile(path.join(historyDir, list[0].id, 'meta.json'), JSON.stringify(list[0], null, 2));
    return;
  }
  const id = Date.now().toString(36);
  const dir = path.join(historyDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const files = [];
  for (const p of paths) { const name = path.basename(p); await fs.promises.copyFile(p, path.join(dir, name)); files.push(name); }
  const saved = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const orig = `orig-${String(i + 1).padStart(2, '0')}.png`;
    try { await fs.promises.copyFile(shotPath(it.id), path.join(dir, orig)); } catch { continue; }
    saved.push({ ...it, file: orig });
  }
  const meta = { id, createdAt: Date.now(), count: files.length, text, files, items: saved, signature };
  await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  // храним последние HISTORY_LIMIT серий
  for (const old of [meta, ...list].slice(HISTORY_LIMIT)) {
    await fs.promises.rm(path.join(historyDir, old.id), { recursive: true, force: true });
  }
}

function historyPublic(m) {
  return {
    id: m.id, createdAt: m.createdAt, count: m.count, text: m.text,
    thumbs: m.files.slice(0, 4).map((f) => `file:///${path.join(historyDir, m.id, f).replace(/\\/g, '/')}`),
  };
}

// ---------- трей ----------
function rebuildTrayMenu() {
  if (!tray) return;
  const hk = hotkeys();
  tray.setToolTip(`${APP_TITLE} · ${accLabel(hk.capture)}`);
  const menu = Menu.buildFromTemplate([
    { label: `Новый снимок\t${accLabel(hk.capture)}`, click: () => startCapture() },
    { label: `Показать / скрыть панель\t${accLabel(hk.panel)}`, click: togglePanel },
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
        rebuildTrayMenu();
      },
    },
    { label: 'Открыть папку снимков', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function buildTray() {
  tray = new Tray(makeIcon(32));
  rebuildTrayMenu();
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
  if (!SELFTEST) startStt();
  createPanel();
  createCaptureWin();
  buildTray();

  if (SELFTEST) { selfTest(); return; } // без горячих клавиш: они заняты основной копией программы

  const st = registerHotkeys();
  const hk = hotkeys();
  log('start');
  if (!st.capture) notify(`Не удалось занять ${accLabel(hk.capture)}: клавиша занята другой программой. Поменяй её в настройках панели.`);
  if (!st.panel) notify(`Не удалось занять ${accLabel(hk.panel)}. Поменяй клавишу в настройках панели.`);
  showPanel(false);
});

// ---------- самопроверка ----------
async function selfShot(win, name) {
  if (!process.env.SFA_SHOTS) return;
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.SFA_SHOTS, `${name}.png`), img.toPNG());
  } catch (e) { log(`selfShot ${name}: ${e.message}`); }
}

async function selfTest() {
  const wait = async (cond, ms) => { const t = now(); while (!cond() && now() - t < ms) await new Promise((r) => setTimeout(r, 10)); return cond(); };
  const result = {};
  try {
    await wait(() => helperReady, 20000);
    await wait(() => panelWin && !panelWin.webContents.isLoading() && captureWin && !captureWin.webContents.isLoading(), 20000);
    {
      panelWin.setBounds({ x: 20, y: 20, width: PANEL_COMPACT.width, height: PANEL_COMPACT.height });
      await panelWin.webContents.executeJavaScript("document.body.style.background = '#ff00ff'; document.querySelector('.bar').style.background = '#ff00ff'; true");
      panelWin.showInactive();
      await new Promise((r) => setTimeout(r, 400));
      const display = screen.getPrimaryDisplay();
      const tg = now();
      const g = await grabDisplay(display);
      result.grabWithPanel = now() - tg;
      const sf = display.scaleFactor || 1;
      const px = Math.round((20 + PANEL_COMPACT.width / 2) * sf); const py = Math.round((20 + PANEL_COMPACT.height / 2) * sf);
      const i = (py * g.width + px) * 4;
      result.panelInShot = g.raw[i + 2] > 200 && g.raw[i] > 200 && g.raw[i + 1] < 80;
      panelWin.hide();
      await panelWin.webContents.executeJavaScript("document.body.style.background = ''; document.querySelector('.bar').style.background = ''; true");
    }
    result.dictionary = applyDictionary('сделай как в фигме и спроси у клода, а гитхаб не трогай');
    result.captureReady = []; result.hiddenAfterEnter = []; result.savedAfterEnter = [];
    let t;
    for (let i = 0; i < 3; i++) {
      const before = queue.length;
      // 1. снимок экрана → окно выделения готово
      t = now();
      const ready = new Promise((r) => ipcMain.once('capture:ready', r));
      startCapture();
      await ready;
      result.captureReady.push(now() - t);
      // 2. выделить область, написать комментарий, Enter
      await captureWin.webContents.executeJavaScript(`cropAndEdit({ x: 40, y: 40, w: innerWidth - 80 - ${i * 300}, h: innerHeight - 120 - ${i * 150} }); document.querySelector('#comment').value = 'самопроверка ${i + 1}: комментарий средней длины для проверки скорости сохранения'; if (${i} === 0) { const w = strokeWidth(); state.annotations.push({ type: 'rect', x1: 120, y1: 160, x2: 700, y2: 420, color: '#FF3B30', width: w, note: 'сделать кнопку крупнее' }, { type: 'arrow', x1: 1100, y1: 700, x2: 820, y2: 460, color: '#0A84FF', width: w, note: 'убрать лишний отступ' }, { type: 'blur', x1: 900, y1: 120, x2: 1500, y2: 330, color: '#FF3B30', width: w }, { type: 'num', x: 1300, y: 600, color: '#34C759', width: w }, { type: 'rect', x1: 1600, y1: 500, x2: 1900, y2: 700, color: '#FF9500', width: w }); render(); } true`);
      if (i === 0) {
        await captureWin.webContents.executeJavaScript("openNote(state.annotations[0]); true");
        await new Promise((r) => setTimeout(r, 200));
        await selfShot(captureWin, 'editor-note');
        await captureWin.webContents.executeJavaScript("closeNote(false); true");
      }
      t = now();
      captureWin.webContents.executeJavaScript('done(); true');
      await wait(() => !captureWin.isVisible(), 10000);
      result.hiddenAfterEnter.push(now() - t);
      await wait(() => queue.length > before, 15000);
      result.savedAfterEnter.push(now() - t);
    }
    // разбор по шагам сборки одного снимка в панели
    result.composeSteps = await panelWin.webContents.executeJavaScript(`(async () => {
      const r = {}; let t = performance.now();
      const it = items[0];
      const bytes = await api.invoke('shot:bytes', it.id); r.ipc = Math.round(performance.now() - t); t = performance.now();
      const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); r.decode = Math.round(performance.now() - t); t = performance.now();
      const c = ShotDraw.compose(img, it.annotations, 1, it.comment); r.draw = Math.round(performance.now() - t); t = performance.now();
      const b = await ShotDraw.encodePng(c); r.encode = Math.round(performance.now() - t); r.kb = Math.round(b.byteLength / 1024);
      r.visibility = document.visibilityState;
      return r;
    })()`);
    // 3. скопировать всё
    t = now();
    await panelWin.webContents.executeJavaScript('copyAll().then(() => true)');
    result.copyAll = now() - t;
    result.clipboardFormats = clipboard.availableFormats().join(',');
    result.clipboardFull = clipboard.readText();
    await wait(() => false, 600);
    result.historyEntries = (await readHistory()).length;
    // панель за краем экрана: вкладки «Снимки», «История», «Настройки»
    panelWin.setBounds({ x: -3000, y: 100, width: PANEL_FULL.width, height: PANEL_FULL.height });
    panelWin.showInactive();
    panelWin.webContents.send('panel:expanded', true);
    for (const v of ['shots', 'history', 'settings']) {
      await panelWin.webContents.executeJavaScript(`setView('${v}'); true`);
      await new Promise((r) => setTimeout(r, 400));
      await selfShot(panelWin, `panel-${v}`);
    }
    panelWin.webContents.send('panel:expanded', false);
    panelWin.setBounds({ x: -3000, y: 100, width: PANEL_COMPACT.width, height: PANEL_COMPACT.height });
    await new Promise((r) => setTimeout(r, 300));
    await selfShot(panelWin, 'panel-pill');
    panelWin.hide();
    result.clipboardText = clipboard.readText().slice(0, 60);
  } catch (e) {
    result.error = e.stack || String(e);
  }
  log(`SELFTEST ${JSON.stringify(result)}`);
  console.log(`SELFTEST ${JSON.stringify(result)}`);
  quitting = true;
  app.quit();
}

