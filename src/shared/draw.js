// Общая отрисовка разметки. Используется редактором и панелью (при сборке файлов для буфера).
// Координаты аннотаций — в пикселях исходного изображения.
(function (global) {
  function baseWidth(w, h) {
    return Math.max(3, Math.round(Math.hypot(w, h) / 350));
  }

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

  function drawRect(ctx, a) {
    const x = Math.min(a.x1, a.x2); const y = Math.min(a.y1, a.y2);
    const w = Math.abs(a.x2 - a.x1); const h = Math.abs(a.y2 - a.y1);
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

  function drawNumber(ctx, a) {
    const r = a.width * 3.2;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fillStyle = a.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, a.width * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.fillStyle = isLight(a.color) ? '#111' : '#fff';
    ctx.font = `bold ${Math.round(r * 1.25)}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(a.n), a.x, a.y + r * 0.06);
  }

  function isLight(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return false;
    const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
    return (r * 299 + g * 587 + b * 114) / 1000 > 170;
  }

  function drawAnnotations(ctx, annotations) {
    for (const a of annotations || []) {
      ctx.save();
      if (a.type === 'arrow') drawArrow(ctx, a);
      else if (a.type === 'rect') drawRect(ctx, a);
      else if (a.type === 'pen') drawPen(ctx, a);
      else if (a.type === 'num') drawNumber(ctx, a);
      ctx.restore();
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
    ctx.font = `bold ${Math.round(r * 1.2)}px "Segoe UI", Arial, sans-serif`;
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

  // Собирает готовый PNG: исходник + разметка (+ номер очереди, + подпись под картинкой).
  function compose(img, annotations, badgeNumber, caption) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const font = Math.max(15, Math.round(Math.hypot(w, h) / 60));
    const pad = Math.round(font * 0.9);
    const lineH = Math.round(font * 1.35);
    const c = document.createElement('canvas');
    const probe = c.getContext('2d');
    probe.font = `${font}px "Segoe UI", Arial, sans-serif`;
    const prefix = badgeNumber != null ? `${badgeNumber}. ` : '';
    const text = caption && String(caption).trim() ? prefix + String(caption).trim() : '';
    const lines = text ? wrapLines(probe, text, w - pad * 2) : [];
    const stripH = lines.length ? pad * 2 + lines.length * lineH : 0;
    c.width = w;
    c.height = h + stripH;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawAnnotations(ctx, annotations);
    if (badgeNumber != null) drawBadge(ctx, badgeNumber, w, h);
    if (lines.length) {
      ctx.fillStyle = '#1b1b1f';
      ctx.fillRect(0, h, w, stripH);
      ctx.fillStyle = '#FF5A28';
      ctx.fillRect(0, h, w, Math.max(2, Math.round(font / 6)));
      ctx.fillStyle = '#ffffff';
      ctx.font = `${font}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((ln, i) => ctx.fillText(ln, pad, h + pad + i * lineH));
    }
    return c;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }

  global.ShotDraw = { baseWidth, drawAnnotations, drawBadge, compose, loadImage };
})(window);
