// Панель очереди: маленькая пилюля (счётчик · скопировать · раскрыть) + раскрывающийся список.
const $ = (s) => document.querySelector(s);
let items = [];
let expanded = false;
let lastCount = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// настройки (localStorage)
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
    list.innerHTML = `<div class="empty-list"><strong>Снимков пока нет</strong>Нажми <kbd>Ctrl+Shift+S</kbd>, выдели область,<br>отметь стрелкой и напиши или скажи комментарий.<br>Потом нажми иконку «скопировать».</div>`;
    return;
  }
  list.innerHTML = items.map((it, i) => `
    <div class="card" data-id="${it.id}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <img class="thumb" src="${it.thumb}" title="Открыть и изменить разметку" data-act="edit">
        <div class="field">
          <textarea rows="1" placeholder="Комментарий для агента…" data-act="comment">${esc(it.comment)}</textarea>
          <button data-act="mic"></button>
        </div>
        <div class="actions">
          <button class="icon-btn" data-act="up" title="Выше"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
          <button class="icon-btn" data-act="down" title="Ниже"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
          <button class="icon-btn" data-act="edit" title="Изменить разметку"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="icon-btn" data-act="delete" title="Удалить"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('textarea').forEach(autoGrow);
  list.querySelectorAll('[data-act="mic"]').forEach((b) => Voice.decorate(b));
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(140, t.scrollHeight)}px`;
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
}
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

function buildText() {
  return items.map((it, i) => `${i + 1}. ${it.comment.trim() || '(без комментария)'}`).join('\n');
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

let copyDoneTimer;
async function copyAll() {
  if (!items.length) return;
  const btn = $('#copy');
  btn.classList.remove('done');
  btn.classList.add('busy'); btn.disabled = true;
  try {
    const t0 = performance.now();
    // Все снимки собираются параллельно; toBlob кодирует PNG вне основного потока, панель не замирает.
    const files = await Promise.all(items.map(async (it, i) => {
      const bytes = await api.invoke('shot:bytes', it.id);
      const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = ShotDraw.compose(img, it.annotations, i + 1, settings.caption ? it.comment : '');
      return { name: `скриншот-${String(i + 1).padStart(2, '0')}.png`, data: await ShotDraw.encodePng(canvas) };
    }));
    const tCompose = performance.now() - t0;
    const text = buildText();
    const res = await api.invoke('queue:copy', { files, text, twoStep: settings.twoStep });
    api.send('app:log', `copy ${files.length}: compose=${Math.round(tCompose)}ms total=${Math.round(performance.now() - t0)}ms`);
    if (res.ok) {
      const n = res.count;
      btn.classList.add('done');
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg><span class="spin"></span>';
      btn.title = `Скопировано: ${n} ${plural(n)}. Нажми Ctrl+V в чате`;
      clearTimeout(copyDoneTimer);
      copyDoneTimer = setTimeout(resetCopyIcon, 2500);
      if (expanded) toast(`Скопировано: ${n} ${plural(n)}. Нажми <b>Ctrl+V</b> в чате${settings.twoStep ? ': картинки, затем текст сам' : ''}.`, 'ok');
      if (settings.autoClear) await api.invoke('queue:clear');
    } else {
      showError(`Не удалось положить в буфер: ${esc(res.error || 'неизвестная ошибка')}`);
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

// ---------- голосовой ввод (локальный GigaAM) ----------
Voice.onMessage((code) => showError(esc(Voice.messageText(code))));
async function refreshStt() {
  const st = await api.invoke('voice:status');
  const el = $('#sttState');
  el.textContent = st.ready ? 'голос: готов' : (st.error ? 'голос: ошибка' : (st.downloading ? 'голос: скачивается модель…' : 'голос: загружается…'));
  el.classList.toggle('ok', st.ready);
  if (!st.ready && !st.error) setTimeout(refreshStt, st.downloading ? 5000 : 1500);
}
refreshStt();

api.on('queue:changed', (q) => { items = q; render(); });
api.invoke('queue:get').then((q) => { items = q; render(); });
