// Окно захвата (создаётся один раз и переиспользуется):
// выделение области на замороженном экране → редактор разметки с комментарием и голосовым вводом.
const $ = (s) => document.querySelector(s);

const COLORS = ['#FF3B30', '#FF9500', '#FFD60A', '#34C759', '#0A84FF', '#BF5AF2', '#FFFFFF', '#111111'];

const state = {
  mode: 'idle',
  screen: null,        // canvas со всем экраном (физические пиксели)
  scaleFactor: 1,
  editId: null,        // id существующего снимка при редактировании
  img: null,           // canvas или Image вырезанной области
  annotations: [],
  tool: 'arrow',
  color: COLORS[0],
  drawing: null,       // текущая фигура в процессе рисования
  saving: false,
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// ---------------- выделение ----------------
const bg = $('#bgCanvas');
const sel = { canvas: $('#selCanvas'), ctx: null, start: null, cur: null, k: 1 };
sel.ctx = sel.canvas.getContext('2d');

// Сырые пиксели BGRA (Windows) → canvas.
function rawToCanvas(raw, w, h) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const src = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h);
  const img = new ImageData(w, h);
  const dst = new Uint32Array(img.data.buffer);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    dst[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

function setupSelect() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(window.innerWidth * dpr); const H = Math.round(window.innerHeight * dpr);
  bg.width = W; bg.height = H;
  sel.canvas.width = W; sel.canvas.height = H;
  sel.k = W / window.innerWidth;
  bg.getContext('2d').drawImage(state.screen, 0, 0, W, H); // один раз: дальше рисуется только затемнение
  drawSelect();
}

function drawSelect() {
  const { ctx, canvas } = sel;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const r = selRect();
  if (r) {
    const k = sel.k;
    const sx = r.x * k; const sy = r.y * k; const sw = r.w * k; const sh = r.h * k;
    ctx.clearRect(sx, sy, sw, sh);
    ctx.strokeStyle = '#ff5a28';
    ctx.lineWidth = 2 * k;
    ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
  }
}

function selRect() {
  if (!sel.start || !sel.cur) return null;
  const x = Math.min(sel.start.x, sel.cur.x); const y = Math.min(sel.start.y, sel.cur.y);
  const w = Math.abs(sel.cur.x - sel.start.x); const h = Math.abs(sel.cur.y - sel.start.y);
  return { x, y, w, h };
}

sel.canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) { cancel(); return; }
  if (e.button !== 0) return;
  sel.start = { x: e.clientX, y: e.clientY };
  sel.cur = { ...sel.start };
  $('#selHint').style.display = 'none';
  drawSelect();
});
sel.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('mousemove', (e) => {
  if (state.mode !== 'select' || !sel.start) return;
  sel.cur = { x: e.clientX, y: e.clientY };
  drawSelect();
  const r = selRect();
  const size = $('#selSize');
  size.style.display = 'block';
  size.textContent = `${Math.round(r.w * state.scaleFactor)} × ${Math.round(r.h * state.scaleFactor)}`;
  size.style.left = `${Math.min(r.x + r.w + 8, window.innerWidth - 90)}px`;
  size.style.top = `${Math.min(r.y + r.h + 8, window.innerHeight - 28)}px`;
});

window.addEventListener('mouseup', (e) => {
  if (state.mode !== 'select' || !sel.start) return;
  sel.cur = { x: e.clientX, y: e.clientY };
  const r = selRect();
  sel.start = null; sel.cur = null;
  $('#selSize').style.display = 'none';
  if (!r || r.w < 5 || r.h < 5) { $('#selHint').style.display = ''; drawSelect(); return; }
  cropAndEdit(r);
});

function cropAndEdit(r) {
  // r в CSS-пикселях окна; изображение экрана — в физических.
  const k = state.screen.width / window.innerWidth;
  const sx = Math.round(r.x * k); const sy = Math.round(r.y * k);
  const sw = Math.max(1, Math.round(r.w * k)); const sh = Math.max(1, Math.round(r.h * k));
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  c.getContext('2d').drawImage(state.screen, sx, sy, sw, sh, 0, 0, sw, sh);
  state.img = c; // PNG кодируется только при сохранении
  enterEdit();
}

// ---------------- редактор ----------------
const ed = { canvas: $('#editCanvas'), ctx: null, scale: 1 };
ed.ctx = ed.canvas.getContext('2d');
const comment = $('#comment');
const mic = $('#mic');
Voice.decorate(mic);

function imgSize(im) { return [im.naturalWidth || im.width, im.naturalHeight || im.height]; }

function enterEdit() {
  state.mode = 'edit';
  $('#select').classList.remove('active');
  $('#edit').classList.add('active');
  const [w, h] = imgSize(state.img);
  ed.canvas.width = w;
  ed.canvas.height = h;
  fitCanvas();
  render();
  comment.focus();
}

function fitCanvas() {
  const stage = document.querySelector('.stage');
  const maxW = stage.clientWidth - 64; const maxH = stage.clientHeight - 32;
  const w = ed.canvas.width; const h = ed.canvas.height;
  ed.scale = Math.min(1, maxW / w, maxH / h);
  // маленькие снимки увеличиваем, чтобы было удобно рисовать
  if (w * ed.scale < 320 && h * ed.scale < 240) ed.scale = Math.min(maxW / w, maxH / h, 3);
  ed.canvas.style.width = `${Math.round(w * ed.scale)}px`;
  ed.canvas.style.height = `${Math.round(h * ed.scale)}px`;
}
window.addEventListener('resize', () => { if (state.mode === 'edit') fitCanvas(); });

function render() {
  const { ctx, canvas } = ed;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.img, 0, 0);
  ShotDraw.drawAnnotations(ctx, state.annotations);
  if (state.drawing) ShotDraw.drawAnnotations(ctx, [state.drawing]);
}

function toImg(e) {
  const r = ed.canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * ed.canvas.width;
  const y = (e.clientY - r.top) / r.height * ed.canvas.height;
  return [Math.max(0, Math.min(ed.canvas.width, x)), Math.max(0, Math.min(ed.canvas.height, y))];
}

function strokeWidth() { return ShotDraw.baseWidth(ed.canvas.width, ed.canvas.height); }
function nextNumber() { return state.annotations.filter((a) => a.type === 'num').length + 1; }

ed.canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const [x, y] = toImg(e);
  const width = strokeWidth();
  const color = state.color;
  if (state.tool === 'num') {
    state.annotations.push({ type: 'num', x, y, n: nextNumber(), color, width });
    render();
    return;
  }
  if (state.tool === 'pen') state.drawing = { type: 'pen', points: [[x, y]], color, width };
  else state.drawing = { type: state.tool, x1: x, y1: y, x2: x, y2: y, color, width };
  render();
});

window.addEventListener('mousemove', (e) => {
  if (state.mode !== 'edit' || !state.drawing) return;
  const [x, y] = toImg(e);
  if (state.drawing.type === 'pen') {
    const pts = state.drawing.points; const last = pts[pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 1.5) pts.push([x, y]);
  } else { state.drawing.x2 = x; state.drawing.y2 = y; }
  render();
});

window.addEventListener('mouseup', () => {
  if (state.mode !== 'edit' || !state.drawing) return;
  const d = state.drawing; state.drawing = null;
  const tooSmall = d.type === 'pen' ? d.points.length < 2 : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4;
  if (!tooSmall) state.annotations.push(d);
  render();
});

function setTool(t) {
  state.tool = t;
  document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}
document.querySelectorAll('#tools .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function setColor(c) {
  state.color = c;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === c));
}
const colorsBox = $('#colors');
for (const c of COLORS) {
  const s = document.createElement('div');
  s.className = 'swatch'; s.dataset.color = c; s.style.background = c; s.title = c;
  s.addEventListener('click', () => setColor(c));
  colorsBox.appendChild(s);
}
setColor(COLORS[0]);

function undo() {
  state.annotations.pop();
  render();
}
$('#undo').addEventListener('click', undo);

// ---------------- голос ----------------
let msgTimer;
Voice.onMessage((code) => {
  $('#msg').textContent = Voice.messageText(code);
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { $('#msg').textContent = ''; }, 6000);
});
mic.addEventListener('click', () => Voice.toggle(comment, mic));

let voiceKeyDownAt = 0;
let voiceStartedByKey = false;
function onVoiceKeyDown(e) {
  if (e.repeat) return;
  voiceKeyDownAt = performance.now();
  if (Voice.isActive()) { voiceStartedByKey = false; Voice.stop(); return; }
  voiceStartedByKey = true;
  Voice.start(comment, mic);
}
// Удержание Ctrl+Пробел дольше 0,4 с = «рация»: отпустил — запись закончилась.
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || !voiceStartedByKey) return;
  voiceStartedByKey = false;
  if (Voice.isActive() && performance.now() - voiceKeyDownAt > 400) Voice.stop();
}, true);

// ---------------- сохранение / отмена ----------------
function cancel() {
  if (Voice.isActive()) Voice.cancel();
  api.send('capture:cancel');
}
$('#cancel').addEventListener('click', cancel);

async function done() {
  if (state.saving) return;
  state.saving = true;
  $('#done').disabled = true;
  if (Voice.isActive()) await Voice.stop(); // дождаться распознанного текста
  const payload = {
    id: state.editId,
    image: state.editId ? undefined : state.img.toDataURL('image/png'),
    width: ed.canvas.width,
    height: ed.canvas.height,
    annotations: state.annotations,
    comment: comment.value.trim(),
  };
  await api.invoke('capture:save', payload);
}
$('#done').addEventListener('click', done);

function handleKey(e) {
  if (state.mode === 'idle') return;
  if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); if (state.mode === 'edit') onVoiceKeyDown(e); return; }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (Voice.isActive()) { Voice.cancel(); return; } // Esc во время записи — только отменить запись
    cancel();
    return;
  }
  if (state.mode !== 'edit') return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); return; }
  if (e.target === comment) return; // остальные клавиши — обычный ввод текста
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const map = { a: 'arrow', ф: 'arrow', r: 'rect', к: 'rect', n: 'num', т: 'num', p: 'pen', з: 'pen' };
  if (map[k]) { setTool(map[k]); e.preventDefault(); }
  const digit = parseInt(e.key, 10);
  if (digit >= 1 && digit <= COLORS.length) setColor(COLORS[digit - 1]);
}
window.addEventListener('keydown', handleKey, true);

// клик по фону редактора (не по холсту) → фокус на комментарий
$('.stage').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) comment.focus(); });

// ---------------- жизненный цикл окна ----------------
function reset() {
  if (Voice.isActive()) Voice.cancel();
  state.mode = 'idle';
  state.screen = null; state.img = null; state.editId = null;
  state.annotations = []; state.drawing = null; state.saving = false;
  sel.start = null; sel.cur = null;
  comment.value = '';
  $('#msg').textContent = '';
  $('#done').disabled = false;
  $('#selHint').style.display = '';
  $('#selSize').style.display = 'none';
  $('#select').classList.remove('active');
  $('#edit').classList.remove('active');
  bg.width = bg.height = 1; sel.canvas.width = sel.canvas.height = 1;
  ed.canvas.width = ed.canvas.height = 1;
}

api.on('capture:reset', reset);

api.on('capture:init', async (payload) => {
  reset();
  if (payload.mode === 'edit') {
    state.editId = payload.item.id;
    state.annotations = payload.item.annotations || [];
    state.img = await ShotDraw.loadImage(payload.image);
    comment.value = payload.item.comment || '';
    enterEdit();
  } else {
    state.scaleFactor = payload.scaleFactor || 1;
    state.screen = rawToCanvas(payload.raw, payload.width, payload.height);
    state.mode = 'select';
    $('#select').classList.add('active');
    setupSelect();
  }
  await nextFrame();
  api.send('capture:ready');
  window.focus();
  if (state.mode === 'edit') comment.focus();
});
