// Голосовой ввод: запись с микрофона → PCM 16 кГц → локальная модель GigaAM (через главный процесс) → текст в поле.
// Один активный сеанс записи на окно. Кнопка-иконка получает data-state: idle | rec | busy | error.
(function (global) {
  const MAX_MS = 2 * 60 * 1000;
  const SR = 16000;
  const IDLE_TITLE = 'Голосовой ввод (Ctrl+Пробел)';
  const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const MESSAGES = {
    nomic: 'Нет доступа к микрофону. Проверь, что он подключён и разрешён в настройках Windows.',
    loading: 'Модель распознавания ещё загружается, попробуй через пару секунд.',
    downloading: 'Модель распознавания скачивается (первый запуск, около 220 МБ). Попробуй через несколько минут.',
    nostt: 'Распознавание речи не запустилось. Подробности в app.log.',
    timeout: 'Распознавание заняло слишком много времени, попробуй ещё раз.',
    empty: 'Ничего не расслышал, попробуй ещё раз ближе к микрофону.',
    decode: 'Не удалось обработать запись.',
  };
  let cur = null;
  let onMessage = () => {};

  function setState(btn, state, title) {
    btn.dataset.state = state;
    if (title) btn.title = title;
  }

  function flashError(btn, code) {
    setState(btn, 'error', MESSAGES[code] || code);
    onMessage(code);
    setTimeout(() => setState(btn, 'idle', IDLE_TITLE), 3000);
  }

  function insertText(ta, text) {
    if (!text) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const sepBefore = before && !/\s$/.test(before) ? ' ' : '';
    const sepAfter = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + sepBefore + text + sepAfter + after;
    const pos = (before + sepBefore + text).length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function meter(btn, stream, session) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const bars = btn.querySelectorAll('.lv i');
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
        bars.forEach((b, i) => {
          const k = [0.55, 0.85, 1, 0.8, 0.5][i] || 0.7;
          b.style.transform = `scaleY(${Math.max(0.18, rms * k + Math.random() * 0.08)})`;
        });
        if (cur === session) session.raf = requestAnimationFrame(tick);
      };
      tick();
      return ctx;
    } catch { return null; }
  }

  // webm/opus → Float32 моно 16 кГц (декодер Chromium сам пересэмплирует под частоту контекста)
  async function toPcm16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, SR);
    const audio = await ctx.decodeAudioData(buf);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / audio.numberOfChannels;
    }
    return out;
  }

  async function start(ta, btn) {
    if (cur) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      flashError(btn, 'nomic');
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    const session = { ta, btn, stream, rec, chunks: [], cancelled: false };
    let finish;
    session.done = new Promise((r) => { finish = r; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) session.chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(session.raf);
      if (session.ctx) session.ctx.close().catch(() => {});
      clearTimeout(session.timer);
      if (cur === session) cur = null;
      if (session.cancelled || !session.chunks.length) { setState(btn, 'idle', IDLE_TITLE); finish(''); return; }
      setState(btn, 'busy', 'Распознаю…');
      let pcm;
      try {
        pcm = await toPcm16k(new Blob(session.chunks, { type: mime }));
      } catch {
        flashError(btn, 'decode'); finish(''); return;
      }
      const res = await api.invoke('voice:transcribe', { pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) });
      if (res.ok && res.text) {
        insertText(ta, res.text);
        setState(btn, 'idle', IDLE_TITLE);
        finish(res.text);
      } else {
        flashError(btn, res.ok ? 'empty' : res.error);
        finish('');
      }
      ta.focus();
    };
    cur = session;
    rec.start(250);
    setState(btn, 'rec', 'Идёт запись: нажми ещё раз, чтобы закончить');
    session.ctx = meter(btn, stream, session);
    session.timer = setTimeout(() => stop(), MAX_MS);
  }

  // Останавливает запись; промис завершается, когда текст вставлен.
  function stop() {
    if (!cur) return Promise.resolve('');
    const s = cur;
    if (s.rec.state !== 'inactive') s.rec.stop();
    return s.done;
  }

  function cancel() {
    if (!cur) return;
    cur.cancelled = true;
    if (cur.rec.state !== 'inactive') cur.rec.stop();
  }

  function toggle(ta, btn) { return cur ? stop() : start(ta, btn); }

  // Пустая кнопка → иконка микрофона + полоски уровня + спиннер.
  function decorate(btn) {
    btn.type = 'button';
    btn.classList.add('voice-btn');
    btn.innerHTML = `${MIC_SVG}<span class="lv"><i></i><i></i><i></i><i></i><i></i></span><span class="spin"></span>`;
    setState(btn, 'idle', IDLE_TITLE);
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // не отбирать фокус у поля
  }

  global.Voice = {
    decorate,
    start,
    stop,
    cancel,
    toggle,
    isActive: () => Boolean(cur),
    onMessage: (fn) => { onMessage = fn; },
    messageText: (code) => MESSAGES[code] || `Голосовой ввод: ${code}`,
  };
})(window);
