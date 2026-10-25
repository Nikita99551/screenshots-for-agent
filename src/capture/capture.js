// Окно захвата (создаётся один раз и переиспользуется):
// выделение области на замороженном экране → редактор разметки с комментарием, заметками к меткам и голосом.
const $ = (s) => document.querySelector(s);

const COLORS = ['#FF3B30', '#FF9500', '#FFD60A', '#34C759', '#0A84FF', '#BF5AF2', '#FFFFFF', '#111111'];
const TOOL_KEYS = { a: 'arrow', ф: 'arrow', r: 'rect', к: 'rect', m: 'num', ь: 'num', n: 'num', т: 'num', p: 'pen', з: 'pen', b: 'blur', и: 'blur' };

const state = {
  mode: 'idle',
  screen: null,        // canvas со всем экраном (физические пиксели)
  scaleFactor: 1,
  editId: null,        // id существующего снимка при редактировании
  index: null,         // номер снимка в серии (для подписей меток «N.k»)
  img: null,           // canvas или Image вырезанной области
  annotations: [],
  tool: 'arrow',
  color: COLORS[0],
  drawing: null,       // текущая фигура в процессе рисования
  hits: [],            // прямоугольники плашек меток (для клика)
  noteFor: null,       // аннотация, заметка которой сейчас редактируется
  saving: false,
  voiceKey: 'Control+Space',
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
  c.getContext('2d', { willReadFrequently: true }).putImageData(img, 0, 0);
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
  const c = ShotDraw.makeCanvas(sw, sh);
  c.getContext('2d', { willReadFrequently: true }).drawImage(state.screen, sx, sy, sw, sh, 0, 0, sw, sh);
  state.img = c; // PNG кодируется только при сохранении, в фоновом потоке
  enterEdit();
}

// ---------------- редактор ----------------
const ed = { canvas: $('#editCanvas'), ctx: null, scale: 1 };
ed.ctx = ed.canvas.getContext('2d');
const comment = $('#comment');
const mic = $('#mic');
const noteBox = $('#noteBox');
const noteInput = $('#noteInput');
const noteMic = $('#noteMic');
Voice.decorate(mic);
Voice.decorate(noteMic);

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
window.addEventListener('resize', () => { if (state.mode === 'edit') { fitCanvas(); placeNoteBox(); } });

function render() {
  const { ctx, canvas } = ed;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.img, 0, 0);
  state.hits = [];
  const list = state.drawing ? [...state.annotations, state.drawing] : state.annotations;
  ShotDraw.drawAnnotations(ctx, list, { source: state.img, prefix: state.index, hits: state.hits, focus: state.noteFor });
}

function toImg(e) {
  const r = ed.canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * ed.canvas.width;
  const y = (e.clientY - r.top) / r.height * ed.canvas.height;
  return [Math.max(0, Math.min(ed.canvas.width, x)), Math.max(0, Math.min(ed.canvas.height, y))];
}

function toClient(x, y) {
  const r = ed.canvas.getBoundingClientRect();
  return [r.left + x / ed.canvas.width * r.width, r.top + y / ed.canvas.height * r.height];
}

function strokeWidth() { return ShotDraw.baseWidth(ed.canvas.width, ed.canvas.height); }

// ---------------- заметки к меткам ----------------
// Номер, который получит метка: свой, если уже есть, иначе следующий по порядку рисования.
function labelOf(a) {
  const map = ShotDraw.labelMap(state.annotations);
  let k = map.get(a);
  if (!k) {
    k = 1;
    for (const b of state.annotations) { if (b === a) break; if (map.has(b)) k++; }
  }
  return state.index != null ? `${state.index}.${k}` : String(k);
}

function anchorOf(a) {
  if (a.type === 'num') return [a.x, a.y];
  if (a.type === 'arrow') return [a.x1, a.y1];
  return [Math.min(a.x1, a.x2), Math.max(a.y1, a.y2)];
}

function placeNoteBox() {
  if (!state.noteFor) return;
  const [ax, ay] = anchorOf(state.noteFor);
  let [cx, cy] = toClient(ax, ay);
  const bw = noteBox.offsetWidth || 380; const bh = noteBox.offsetHeight || 46;
  cx = Math.max(12, Math.min(window.innerWidth - bw - 12, cx - 20));
  cy += 22;
  if (cy + bh > window.innerHeight - 140) cy = Math.max(12, cy - bh - 60);
  noteBox.style.left = `${cx}px`;
  noteBox.style.top = `${cy}px`;
}

function openNote(a) {
  state.noteFor = a;
  $('#noteLabel').textContent = labelOf(a);
  noteInput.value = a.note || '';
  noteBox.hidden = false;
  placeNoteBox();
  render();
  noteInput.focus();
  noteInput.select();
}

function closeNote(focusComment = true) {
  if (!state.noteFor) return;
  if (Voice.isActive()) Voice.stop();
  const a = state.noteFor;
  a.note = noteInput.value.trim();
  if (!a.note) delete a.note;
  state.noteFor = null;
  noteBox.hidden = true;
  render();
  if (focusComment) comment.focus();
}

noteInput.addEventListener('input', () => {
  if (!state.noteFor) return;
  state.noteFor.note = noteInput.value;
  $('#noteLabel').textContent = labelOf(state.noteFor);
  render();
});
$('#noteDel').addEventListener('click', () => {
  const a = state.noteFor;
  if (!a) return;
  state.annotations = state.annotations.filter((b) => b !== a);
  state.noteFor = null;
  noteBox.hidden = true;
  render();
  comment.focus();
});
noteMic.addEventListener('click', () => Voice.toggle(noteInput, noteMic));

// ---------------- рисование ----------------
ed.canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  if (state.noteFor) closeNote(false);
  const [x, y] = toImg(e);
  const hit = state.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
  if (hit) { openNote(hit.a); return; } // клик по номеру метки — редактировать её заметку
  const width = strokeWidth();
  const color = state.color;
  if (state.tool === 'num') {
    const pin = { type: 'num', x, y, color, width };
    state.annotations.push(pin);
    openNote(pin);
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

window.addEventListener('mouseup', (e) => {
  if (state.mode !== 'edit' || !state.drawing) return;
  const d = state.drawing; state.drawing = null;
  const tooSmall = d.type === 'pen' ? d.points.length < 2 : Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4;
  if (tooSmall) {
    // просто клик: если попали по рамке или стрелке — открыть её заметку
    const [x, y] = toImg(e);
    const shape = ShotDraw.hitShape(state.annotations, x, y, Math.max(6, 10 / ed.scale));
    render();
    if (shape) openNote(shape);
    return;
  }
  state.annotations.push(d);
  render();
  if (d.type === 'rect' || d.type === 'arrow') openNote(d); // как в Snapik: нарисовал — сразу пишешь заметку
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
  const a = state.annotations.pop();
  if (a && a === state.noteFor) { state.noteFor = null; noteBox.hidden = true; }
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
  // голос пишется туда, где стоит курсор: в заметку метки или в общий комментарий
  if (document.activeElement === noteInput && state.noteFor) Voice.start(noteInput, noteMic);
  else Voice.start(comment, mic);
}
// Удержание клавиши голоса дольше 0,4 с = «рация»: отпустил — запись закончилась.
window.addEventListener('keyup', (e) => {
  if (!voiceStartedByKey || e.code !== Keys.parse(state.voiceKey).code) return;
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
  if (state.noteFor) closeNote(false);
  const t0 = performance.now();
  const payload = {
    id: state.editId,
    width: ed.canvas.width,
    height: ed.canvas.height,
    annotations: state.annotations,
    comment: comment.value.trim(),
  };
  const crop = state.editId ? null : state.img;
  // Окно прячем сразу; PNG кодируется в фоновом потоке, сохранение идёт в фоне.
  api.send('capture:hide');
  if (crop) payload.png = await ShotDraw.encodePng(crop);
  const tEnc = performance.now() - t0;
  await api.invoke('capture:save', payload);
  api.send('app:log', `save ${payload.width}x${payload.height} encode=${Math.round(tEnc)}ms total=${Math.round(performance.now() - t0)}ms`);
}
$('#done').addEventListener('click', done);

function handleKey(e) {
  if (state.mode === 'idle') return;
  if (Keys.matches(e, state.voiceKey)) { e.preventDefault(); if (state.mode === 'edit') onVoiceKeyDown(e); return; }
  const inNote = e.target === noteInput;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (Voice.isActive()) { Voice.cancel(); return; } // Esc во время записи — только отменить запись
    if (inNote || state.noteFor) { closeNote(); return; }
    cancel();
    return;
  }
  if (state.mode !== 'edit') return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); return; } // Ctrl+Enter — сохранить откуда угодно
  if (inNote) {
    if (e.key === 'Enter') { e.preventDefault(); closeNote(); }
    return; // остальное — обычный ввод заметки
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(); return; }
  if (e.target === comment) return; // остальные клавиши — обычный ввод текста
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) { setTool(tool); e.preventDefault(); }
  const digit = parseInt(e.key, 10);
  if (digit >= 1 && digit <= COLORS.length) setColor(COLORS[digit - 1]);
}
window.addEventListener('keydown', handleKey, true);

// клик по фону редактора (не по холсту) → фокус на комментарий
$('.stage').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) { closeNote(); comment.focus(); } });

// ---------------- жизненный цикл окна ----------------
function reset() {
  if (Voice.isActive()) Voice.cancel();
  state.mode = 'idle';
  state.screen = null; state.img = null; state.editId = null; state.index = null;
  state.annotations = []; state.drawing = null; state.saving = false; state.hits = []; state.noteFor = null;
  sel.start = null; sel.cur = null;
  comment.value = '';
  noteInput.value = '';
  noteBox.hidden = true;
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
  state.index = payload.index ?? null;
  if (payload.voiceKey) state.voiceKey = payload.voiceKey;
  $('#voiceKeyHint').textContent = Keys.label(state.voiceKey);
  if (payload.mode === 'edit') {
    state.editId = payload.item.id;
    state.annotations = (payload.item.annotations || []).map((a) => ({ ...a }));
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
