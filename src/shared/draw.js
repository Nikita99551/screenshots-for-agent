// Общая отрисовка разметки. Используется редактором и панелью (при сборке файлов для буфера).
// Координаты аннотаций — в пикселях исходного изображения.
//
// Метки (как в Snapik): рамка, стрелка и точка-метка могут иметь заметку (a.note). Метка получает номер k,
// на картинке рисуется «N.k» (N — номер снимка в серии), в тексте для чата — «N.k заметка».
// Точка-метка нумеруется всегда, рамка и стрелка — только если у них есть заметка.
const SCRIPT_URL = document.currentScript ? document.currentScript.src : location.href;
(function (global) {
  const FONT = '"Segoe UI", Arial, sans-serif';
  const MARKABLE = new Set(['rect', 'arrow', 'num']);

  function baseWidth(w, h) {
    return Math.max(3, Math.round(Math.hypot(w, h) / 350));
  }

  function isLight(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return false;
    const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
    return (r * 299 + g * 587 + b * 114) / 1000 > 170;
  }

  // Какие аннотации получают номер метки и какой.
  function labelMap(annotations) {
    const map = new Map();
    let k = 0;
    for (const a of annotations || []) {
      if (!MARKABLE.has(a.type)) continue;
      if (a.type === 'num' || (a.note && a.note.trim())) map.set(a, ++k);
    }
    return map;
  }

  // Заметки снимка для текста и подписи: [{ k, note }]
  function notesOf(annotations) {
    const out = [];
    for (const [a, k] of labelMap(annotations)) if (a.note && a.note.trim()) out.push({ k, note: a.note.trim() });
    return out;
  }

  function labelText(prefix, k) { return prefix != null ? `${prefix}.${k}` : String(k); }

  function drawArrow(ctx, a) {
    const { x1, y1, x2, y2, width } = a;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = width * 4.5;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const shaftEnd = len > head ? { x: x2 - Math.cos(ang) * head * 0.8, y: y2 - Math.sin(ang) * head * 0.8 } : { x: x1, y: y1 };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  function rectOf(a) {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }

  function drawRect(ctx, a) {
    const { x, y, w, h } = rectOf(a);
    const r = Math.min(a.width * 1.5, w / 2, h / 2);
    ctx.lineWidth = a.width;
    ctx.strokeStyle = a.color;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.stroke();
  }

  function drawPen(ctx, a) {
    if (!a.points || a.points.length === 0) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = a.width;
    ctx.strokeStyle = a.color;
    ctx.beginPath();
    ctx.moveTo(a.points[0][0], a.points[0][1]);
    for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i][0], a.points[i][1]);
    if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.1, a.points[0][1]);
    ctx.stroke();
  }

  // Размытие = крупная мозаика: надёжно прячет текст (пароли, телефоны), в отличие от лёгкого размытия.
  function drawBlur(ctx, a, source) {
    if (!source) return;
    const { x, y, w, h } = rectOf(a);
    if (w < 2 || h < 2) return;
    const block = Math.max(8, Math.round(a.width * 3.5));
    const tw = Math.max(1, Math.ceil(w / block)); const th = Math.max(1, Math.ceil(h / block));
    const tmp = makeCanvas(tw, th);
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(source, x, y, w, h, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }

  // Плашка с номером метки. Возвращает её прямоугольник (для клика по метке в редакторе).
  function drawLabel(ctx, text, cx, cy, color, width, align) {
    const h = Math.max(20, Math.round(width * 6));
    ctx.font = `bold ${Math.round(h * 0.62)}px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const w = Math.max(h, Math.round(tw + h * 0.7));
    let x = cx - w / 2; let y = cy - h / 2;
    if (align === 'corner') { x = cx; y = cy; }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = h * 0.25;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1.5, h * 0.08);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.fillStyle = isLight(color) ? '#111' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + h * 0.03);
    ctx.restore();
    return { x, y, w, h };
  }

  function overlaps(a, b) { return !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  // avoid — область, которую плашка не должна закрывать (кружок с номером снимка в углу)
  function labelFor(ctx, a, text, imgW, imgH, avoid) {
    const h = Math.max(20, Math.round(a.width * 6));
    if (a.type === 'num') return drawLabel(ctx, text, a.x, a.y, a.color, a.width);
    if (a.type === 'arrow') return drawLabel(ctx, text, a.x1, a.y1, a.color, a.width);
    // рамка: плашка над левым верхним углом; если сверху нет места или там кружок номера — внутри угла
    const r = rectOf(a);
    const gap = Math.round(h * 0.25);
    const wGuess = h * 2.2;
    let x = Math.min(Math.max(0, r.x), Math.max(0, imgW - wGuess));
    let y = r.y - h - gap;
    if (y < 0 || overlaps({ x, y, w: wGuess, h }, avoid)) {
      y = r.y + gap; x = Math.min(r.x + gap, Math.max(0, imgW - wGuess));
      if (overlaps({ x, y, w: wGuess, h }, avoid)) x = avoid.x + avoid.w + gap;
    }
    return drawLabel(ctx, text, x, y, a.color, a.width, 'corner');
  }

  // opts: { source — исходник для размытия, prefix — номер снимка, hits — массив для прямоугольников меток,
  //         focus — аннотация, у которой сейчас редактируется заметка (подсвечивается) }
  function drawAnnotations(ctx, annotations, opts = {}) {
    const list = annotations || [];
    for (const a of list) if (a.type === 'blur') { ctx.save(); drawBlur(ctx, a, opts.source); ctx.restore(); }
    for (const a of list) {
      ctx.save();
      if (a.type === 'arrow') drawArrow(ctx, a);
      else if (a.type === 'rect') drawRect(ctx, a);
      else if (a.type === 'pen') drawPen(ctx, a);
      ctx.restore();
    }
    const W = ctx.canvas.width; const H = ctx.canvas.height;
    const labels = labelMap(list);
    // точки-метки без номера в карте (например, во время рисования) — всё равно показываем
    for (const a of list) if (a.type === 'num' && !labels.has(a)) labels.set(a, labels.size + 1);
    for (const [a, k] of labels) {
      const r = labelFor(ctx, a, labelText(opts.prefix, k), W, H, opts.avoid);
      if (opts.focus === a) {
        ctx.save();
        ctx.lineWidth = Math.max(2, a.width * 0.6);
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([a.width * 2, a.width * 1.5]);
        ctx.strokeRect(r.x - a.width, r.y - a.width, r.w + a.width * 2, r.h + a.width * 2);
        ctx.restore();
      }
      if (opts.hits) opts.hits.push({ a, ...r });
    }
  }

  // Номер снимка в очереди — крупный кружок в левом верхнем углу.
  function drawBadge(ctx, n, w, h) {
    const r = Math.max(16, Math.round(Math.hypot(w, h) / 52));
    const pad = Math.round(r * 0.55);
    const cx = pad + r; const cy = pad + r;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = r * 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#FF5A28';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.2)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), cx, cy + r * 0.06);
    ctx.restore();
  }

  // Разбивает текст на строки по ширине.
  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text).replace(/\r/g, '').split('\n');
    for (const para of paragraphs) {
      let line = '';
      for (const word of para.split(' ')) {
        const probe = line ? `${line} ${word}` : word;
        if (ctx.measureText(probe).width > maxWidth && line) { lines.push(line); line = word; } else line = probe;
      }
      lines.push(line);
    }
    return lines;
  }

  // Текст снимка для подписи и для чата: «N. комментарий», затем «N.k заметка».
  function captionLines(n, comment, annotations) {
    const out = [];
    const c = String(comment || '').trim();
    if (c) out.push(`${n}. ${c}`);
    for (const { k, note } of notesOf(annotations)) out.push(`${n}.${k} ${note}`);
    return out;
  }

  // Собирает готовый PNG: исходник + разметка + номер снимка (+ подпись с комментарием и заметками).
  function compose(img, annotations, badgeNumber, comment, withCaption = true) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const font = Math.max(15, Math.round(Math.hypot(w, h) / 60));
    const pad = Math.round(font * 0.9);
    const lineH = Math.round(font * 1.35);
    const c = makeCanvas(1, 1);
    const probe = c.getContext('2d', { willReadFrequently: true });
    probe.font = `${font}px ${FONT}`;
    const text = withCaption ? captionLines(badgeNumber, comment, annotations) : [];
    const lines = [];
    for (const t of text) lines.push(...wrapLines(probe, t, w - pad * 2));
    const stripH = lines.length ? pad * 2 + lines.length * lineH : 0;
    c.width = w;
    c.height = h + stripH;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const br = Math.max(16, Math.round(Math.hypot(w, h) / 52));
    const bbox = badgeNumber != null ? { x: 0, y: 0, w: Math.round(br * 0.55) * 2 + br * 2, h: Math.round(br * 0.55) * 2 + br * 2 } : null;
    drawAnnotations(ctx, annotations, { source: img, prefix: badgeNumber, avoid: bbox });
    if (badgeNumber != null) drawBadge(ctx, badgeNumber, w, h);
    if (lines.length) {
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, h, w, stripH);
      ctx.fillStyle = '#FF5A28';
      ctx.fillRect(0, h, w, Math.max(2, Math.round(font / 6)));
      ctx.fillStyle = '#ffffff';
      ctx.font = `${font}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((ln, i) => ctx.fillText(ln, pad, h + pad + i * lineH));
    }
    return c;
  }

  // Попадание точки в фигуру (для клика по уже нарисованной рамке или стрелке).
  function hitShape(annotations, x, y, tol) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.type === 'rect') {
        const r = rectOf(a);
        const inX = x >= r.x - tol && x <= r.x + r.w + tol; const inY = y >= r.y - tol && y <= r.y + r.h + tol;
        const nearEdge = Math.min(Math.abs(x - r.x), Math.abs(x - r.x - r.w), Math.abs(y - r.y), Math.abs(y - r.y - r.h)) <= tol;
        if (inX && inY && nearEdge) return a;
      } else if (a.type === 'arrow') {
        const dx = a.x2 - a.x1; const dy = a.y2 - a.y1;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x1) * dx + (y - a.y1) * dy) / len2));
        if (Math.hypot(x - (a.x1 + t * dx), y - (a.y1 + t * dy)) <= tol) return a;
      }
    }
    return null;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }

  // Холст для снимков: внеэкранный, процессорный.
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c;
  }

  // PNG кодируется в отдельном потоке (png-worker.js): в самом окне движок откладывает кодирование
  // «до свободной минуты», и первое кодирование большой картинки ждало до 3–5 секунд.
  let worker = null;
  let seq = 0;
  const waiters = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('png-worker.js', SCRIPT_URL));
    worker.onmessage = (e) => {
      const w = waiters.get(e.data.id);
      if (!w) return;
      waiters.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.buf);
    };
    worker.onerror = (e) => { for (const [, w] of waiters) w.reject(new Error(e.message || 'png worker')); waiters.clear(); worker = null; };
    return worker;
  }

  // Холст → ArrayBuffer с PNG. Запасной путь — кодирование в самом окне.
  async function encodePng(canvas) {
    try {
      const bitmap = await createImageBitmap(canvas);
      const id = ++seq;
      return await new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        getWorker().postMessage({ id, bitmap }, [bitmap]);
      });
    } catch (e) {
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
        : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob.arrayBuffer();
    }
  }

  // Прогрев: запускаем поток заранее, пока пользователь ничего не ждёт.
  setTimeout(() => { encodePng(makeCanvas(64, 64)).catch(() => {}); }, 300);

  global.ShotDraw = {
    baseWidth, drawAnnotations, drawBadge, compose, captionLines, notesOf, labelMap, hitShape,
    loadImage, makeCanvas, encodePng, MARKABLE,
  };
})(window);
