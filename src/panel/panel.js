// Панель: маленькая пилюля (счётчик · скопировать · раскрыть) + раскрытая часть с вкладками
// «Снимки», «История», «Настройки».
const $ = (s) => document.querySelector(s);
let items = [];
let expanded = false;
let lastCount = null;
let view = 'shots';
let cfg = { hotkeys: {}, hotkeyStatus: {}, dictionary: '', defaultDictionary: '' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- локальные настройки (localStorage) ----------
const opt = (key, def) => { const v = localStorage.getItem(key); return v == null ? def : v === '1'; };
const settings = {
  caption: opt('caption', true),
  twoStep: opt('twoStep', true),
  autoClear: opt('autoClear', false),
  pin: opt('pin', true),
};
function bindOpt(id, key, onChange) {
  const el = $(id);
  el.checked = settings[key];
  el.addEventListener('change', () => { settings[key] = el.checked; localStorage.setItem(key, el.checked ? '1' : '0'); if (onChange) onChange(el.checked); });
}
bindOpt('#optCaption', 'caption');
bindOpt('#optTwoStep', 'twoStep');
bindOpt('#autoClear', 'autoClear');
bindOpt('#pin', 'pin', (on) => api.invoke('panel:pin', on));
api.invoke('panel:pin', settings.pin);

function plural(n) { return n % 10 === 1 && n % 100 !== 11 ? 'снимок' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'снимка' : 'снимков'); }

// ---------- вкладки ----------
function setView(v) {
  view = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  if (v === 'history') renderHistory();
  if (v === 'shots') regrow();
  if (v === 'settings') loadSettings();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// ---------- снимки ----------
function render() {
  const n = items.length;
  const count = $('#count');
  count.textContent = n;
  count.classList.toggle('empty', n === 0);
  count.classList.toggle('has', n > 0);
  count.title = n ? `${n} ${plural(n)} в очереди. Раскрыть список` : 'Снимков нет. Раскрыть список';
  if (lastCount != null && n > lastCount) { count.classList.remove('bump'); void count.offsetWidth; count.classList.add('bump'); }
  lastCount = n;
  const copy = $('#copy');
  if (!copy.classList.contains('busy')) copy.disabled = n === 0;

  const list = $('#list');
  if (n === 0) {
    const key = Keys.label(cfg.hotkeys.capture || 'Control+Shift+S');
    list.innerHTML = `<div class="empty-list"><strong>Снимков пока нет</strong>Нажми <kbd>${esc(key)}</kbd>, выдели область,<br>обведи место рамкой и напиши заметку к ней.<br>Потом нажми иконку «скопировать».</div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => {
    const notes = ShotDraw.notesOf(it.annotations);
    return `
    <div class="card" data-id="${it.id}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <img class="thumb" src="${it.thumb}" title="Открыть и изменить разметку" data-act="edit">
        <div class="field">
          <textarea rows="1" placeholder="Общий комментарий к снимку…" data-act="comment">${esc(it.comment)}</textarea>
          <button data-act="mic"></button>
        </div>
        ${notes.length ? `<ul class="notes">${notes.map((x) => `<li data-act="edit" title="Изменить в разметке"><b>${i + 1}.${x.k}</b><span>${esc(x.note)}</span></li>`).join('')}</ul>` : ''}
        <div class="actions">
          <button class="icon-btn" data-act="up" title="Выше"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
          <button class="icon-btn" data-act="down" title="Ниже"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
          <button class="icon-btn" data-act="edit" title="Изменить разметку"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-act="delete" title="Удалить"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
        </div>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('textarea').forEach(autoGrow);
  list.querySelectorAll('[data-act="mic"]').forEach((b) => Voice.decorate(b));
}

function autoGrow(t) {
  t.style.height = 'auto';
  const h = t.scrollHeight + 2; // + рамка поля, иначе появляется лишняя прокрутка
  t.style.height = `${Math.min(140, h)}px`;
  t.style.overflowY = h > 140 ? 'auto' : 'hidden';
}

const saveTimers = new Map();
$('#list').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.act !== 'comment') return;
  autoGrow(t);
  const id = t.closest('.card').dataset.id;
  const item = items.find((x) => x.id === id);
  if (item) item.comment = t.value;
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => api.invoke('queue:update', { id, comment: t.value }), 300));
});

$('#list').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.dataset.act === 'comment') return;
  const id = el.closest('.card').dataset.id;
  switch (el.dataset.act) {
    case 'edit': api.send('queue:edit', id); break;
    case 'mic': Voice.toggle(el.closest('.field').querySelector('textarea'), el); break;
    case 'delete': await api.invoke('queue:delete', id); break;
    case 'up': await api.invoke('queue:move', { id, dir: -1 }); break;
    case 'down': await api.invoke('queue:move', { id, dir: 1 }); break;
    default: break;
  }
});

function setExpanded(on) {
  expanded = on;
  document.body.classList.toggle('expanded', on);
  $('#toggle').title = on ? 'Свернуть' : 'Раскрыть список';
  if (on) regrow();
}

// высота полей считается только у видимой панели — пересчитываем после раскрытия
function regrow() { requestAnimationFrame(() => document.querySelectorAll('#list textarea').forEach(autoGrow)); }
$('#toggle').addEventListener('click', () => api.invoke('panel:expand', !expanded));
$('#count').addEventListener('click', () => api.invoke('panel:expand', !expanded));
api.on('panel:expanded', setExpanded);

$('#new').addEventListener('click', () => api.send('capture:new'));
$('#newBig').addEventListener('click', () => api.send('capture:new'));
$('#hide').addEventListener('click', () => api.send('panel:hide'));

$('#clear').addEventListener('click', async () => {
  if (!items.length) return;
  const btn = $('#clear');
  if (btn.dataset.confirm) { delete btn.dataset.confirm; btn.textContent = 'Очистить'; await api.invoke('queue:clear'); return; }
  btn.dataset.confirm = '1'; btn.textContent = 'Точно удалить?';
  setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Очистить'; }, 2500);
});

// Текст для чата: «1. комментарий», под ним «   1.1 заметка».
function buildText() {
  return items.map((it, i) => {
    const n = i + 1;
    const c = String(it.comment || '').trim();
    const notes = ShotDraw.notesOf(it.annotations);
    if (!c && !notes.length) return `${n}. (без комментария)`;
    return [c ? `${n}. ${c}` : `${n}.`, ...notes.map((x) => `   ${n}.${x.k} ${x.note}`)].join('\n');
  }).join('\n');
}

let toastTimer;
function toast(html, kind = '', ms = 5000) {
  const t = $('#toast');
  t.innerHTML = html; t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, ms);
}

// Ошибка в свёрнутом виде: раскрываем панель, чтобы было видно сообщение.
function showError(html) {
  if (!expanded) api.invoke('panel:expand', true);
  toast(html, 'err', 9000);
}

const CLIP_ERR = { busy: 'Буфер обмена сейчас занят другой программой. Подожди пару секунд и нажми ещё раз.' };
function clipError(err) { return CLIP_ERR[err] || `Не удалось положить в буфер: ${esc(err || 'неизвестная ошибка')}`; }

function flashCopyDone(n) {
  const btn = $('#copy');
  btn.classList.add('done');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg><span class="spin"></span>';
  btn.title = `Скопировано: ${n} ${plural(n)}. Нажми Ctrl+V в чате`;
  clearTimeout(copyDoneTimer);
  copyDoneTimer = setTimeout(resetCopyIcon, 2500);
}

let copyDoneTimer;
async function copyAll() {
  if (!items.length) return;
  const btn = $('#copy');
  btn.classList.remove('done');
  btn.classList.add('busy'); btn.disabled = true;
  try {
    const t0 = performance.now();
    // Все снимки собираются параллельно; PNG кодируется в фоновом потоке, панель не замирает.
    const files = await Promise.all(items.map(async (it, i) => {
      const bytes = await api.invoke('shot:bytes', it.id);
      const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = ShotDraw.compose(img, it.annotations, i + 1, it.comment, settings.caption);
      return { name: `скриншот-${String(i + 1).padStart(2, '0')}.png`, data: await ShotDraw.encodePng(canvas) };
    }));
    const tCompose = performance.now() - t0;
    const text = buildText();
    const res = await api.invoke('queue:copy', { files, text, twoStep: settings.twoStep });
    api.send('app:log', `copy ${files.length}: compose=${Math.round(tCompose)}ms total=${Math.round(performance.now() - t0)}ms`);
    if (res.ok) {
      const n = res.count;
      flashCopyDone(n);
      if (expanded) toast(`Скопировано: ${n} ${plural(n)}. Нажми <b>Ctrl+V</b> в чате${settings.twoStep ? ': картинки, затем текст сам' : ''}. Серия сохранена в истории.`, 'ok');
      if (settings.autoClear) await api.invoke('queue:clear');
    } else {
      showError(clipError(res.error));
    }
  } catch (e) {
    showError(`Ошибка: ${esc(e.message)}`);
  } finally {
    btn.classList.remove('busy');
    render();
  }
}
function resetCopyIcon() {
  const btn = $('#copy');
  btn.classList.remove('done');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg><span class="spin"></span>';
  btn.title = 'Скопировать всё для чата';
}
$('#copy').addEventListener('click', copyAll);

$('#copyText').addEventListener('click', async () => {
  if (!items.length) return;
  await api.invoke('clipboard:text', buildText());
  toast('Текст комментариев скопирован. Вставь его в чат: <b>Ctrl+V</b>.', 'ok');
});

// ---------- история ----------
function fmtDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `сегодня, ${time}`;
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`;
}

async function renderHistory() {
  const box = $('#historyList');
  const list = await api.invoke('history:list');
  if (!list.length) {
    box.innerHTML = '<div class="empty-list"><strong>История пуста</strong>Каждая скопированная серия снимков<br>сохраняется здесь (последние 30).</div>';
    return;
  }
  box.innerHTML = list.map((h) => `
    <div class="hist" data-id="${h.id}">
      <div class="meta"><span><b>${h.count} ${plural(h.count)}</b></span><span>${esc(fmtDate(h.createdAt))}</span></div>
      <div class="thumbs">${h.thumbs.map((t) => `<img src="${t}" alt="">`).join('')}</div>
      <div class="text">${esc(h.text)}</div>
      <div class="row">
        <button class="btn ghost small danger" data-hact="delete">Удалить</button>
        <button class="btn ghost small" data-hact="restore" title="Вернуть снимки в очередь, чтобы дополнить или изменить">В очередь</button>
        <button class="btn ghost small" data-hact="copy">Скопировать</button>
      </div>
    </div>`).join('');
}

$('#historyList').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-hact]');
  if (!el) return;
  const id = el.closest('.hist').dataset.id;
  if (el.dataset.hact === 'copy') {
    const res = await api.invoke('history:copy', { id, twoStep: settings.twoStep });
    if (res.ok) { flashCopyDone(res.count); toast(`Серия скопирована: ${res.count} ${plural(res.count)}. Нажми <b>Ctrl+V</b> в чате.`, 'ok'); } else showError(clipError(res.error));
  } else if (el.dataset.hact === 'restore') {
    const n = await api.invoke('history:restore', id);
    toast(`В очередь добавлено: ${n} ${plural(n)}.`, 'ok');
    setView('shots');
  } else if (el.dataset.hact === 'delete') {
    if (!el.dataset.confirm) { el.dataset.confirm = '1'; el.textContent = 'Точно?'; setTimeout(() => { delete el.dataset.confirm; el.textContent = 'Удалить'; }, 2500); return; }
    await api.invoke('history:delete', id);
    renderHistory();
  }
});
api.on('history:changed', () => { if (view === 'history') renderHistory(); });

// ---------- настройки: горячие клавиши ----------
const HK_ERR = { busy: 'Это сочетание занято другой программой.', duplicate: 'Это сочетание уже используется в программе.', unknown: 'Неизвестная клавиша.' };
let recording = null;

function paintHotkeys() {
  document.querySelectorAll('[data-hk]').forEach((b) => {
    const name = b.dataset.hk;
    b.classList.toggle('rec', recording === name);
    b.textContent = recording === name ? 'Нажми сочетание…' : Keys.label(cfg.hotkeys[name] || '');
    b.classList.toggle('bad', name !== 'voice' && cfg.hotkeyStatus[name] === false);
    b.title = name !== 'voice' && cfg.hotkeyStatus[name] === false ? 'Не удалось занять: клавиша занята другой программой' : '';
  });
  $('#captureKeyHint').textContent = Keys.label(cfg.hotkeys.capture || '');
  $('#new').title = `Новый снимок (${Keys.label(cfg.hotkeys.capture || '')})`;
  $('#hide').title = `Скрыть панель (${Keys.label(cfg.hotkeys.panel || '')})`;
}

function hkHint(text, kind = '') {
  const h = $('#hkHint');
  h.textContent = text || 'Нажми на кнопку и затем нужное сочетание. Esc — отмена.';
  h.className = `hint ${kind}`;
}

document.querySelectorAll('[data-hk]').forEach((b) => b.addEventListener('click', () => {
  recording = recording === b.dataset.hk ? null : b.dataset.hk;
  hkHint(recording ? 'Нажми сочетание, например Ctrl+Shift+S. Esc — отмена.' : '');
  paintHotkeys();
}));

window.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { recording = null; hkHint(''); paintHotkeys(); return; }
  const acc = Keys.fromEvent(e);
  if (!acc) return; // пока нажаты только Ctrl/Alt/Shift
  if (!Keys.isValid(acc)) { hkHint('Добавь Ctrl, Alt или Win (без них можно только F1–F12 и PrtSc).', 'err'); return; }
  const name = recording;
  recording = null;
  const res = await api.invoke('settings:set-hotkey', { name, acc });
  await loadSettings();
  if (res.ok) hkHint(`Готово: ${Keys.label(acc)}.`, 'ok'); else hkHint(HK_ERR[res.error] || res.error, 'err');
}, true);

$('#hkReset').addEventListener('click', async () => {
  await api.invoke('settings:reset-hotkeys');
  await loadSettings();
  hkHint('Вернул стандартные клавиши.', 'ok');
});

// ---------- настройки: словарь ----------
$('#dictSave').addEventListener('click', async () => {
  const res = await api.invoke('settings:set-dictionary', $('#dict').value);
  $('#dictHint').textContent = `Сохранено, правил: ${res.rules}.`;
  $('#dictHint').className = 'hint ok';
});
$('#dictDefault').addEventListener('click', () => {
  $('#dict').value = cfg.defaultDictionary;
  $('#dictHint').textContent = 'Стандартный словарь подставлен, нажми «Сохранить».';
  $('#dictHint').className = 'hint';
});

async function loadSettings() {
  cfg = await api.invoke('settings:get');
  paintHotkeys();
  if (document.activeElement !== $('#dict')) $('#dict').value = cfg.dictionary;
  render();
}

// ---------- голосовой ввод (локальный GigaAM) ----------
Voice.onMessage((code) => showError(esc(Voice.messageText(code))));
async function refreshStt() {
  const st = await api.invoke('voice:status');
  const el = $('#sttState');
  el.textContent = st.ready ? 'готово' : (st.error ? 'ошибка' : (st.downloading ? 'скачивается модель…' : 'загружается…'));
  el.classList.toggle('ok', st.ready);
  if (!st.ready && !st.error) setTimeout(refreshStt, st.downloading ? 5000 : 1500);
}
refreshStt();

api.on('queue:changed', (q) => { items = q; render(); });
loadSettings();
api.invoke('queue:get').then((q) => { items = q; render(); });
