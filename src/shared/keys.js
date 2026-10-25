// Сочетания клавиш в формате Electron («Control+Shift+S»): запись из нажатия, сравнение, подпись по-русски.
// Используется физический код клавиши (e.code), поэтому раскладка (рус/англ) не важна.
(function (global) {
  const SPECIAL = {
    Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    PrintScreen: 'PrintScreen', Pause: 'Pause', ScrollLock: 'Scrolllock',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  const STANDALONE = /^(F\d{1,2}|PrintScreen|Pause|Scrolllock)$/; // можно без Ctrl/Alt/Shift

  function codeToKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
    return SPECIAL[code] || null;
  }

  function keyToCode(key) {
    if (/^[A-Z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^\d$/.test(key)) return `Digit${key}`;
    if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
    if (/^num\d$/i.test(key)) return `Numpad${key.slice(3)}`;
    for (const [code, k] of Object.entries(SPECIAL)) if (k.toLowerCase() === String(key).toLowerCase()) return code;
    return key;
  }

  // Нажатие → сочетание. null, если нажат только модификатор.
  function fromEvent(e) {
    const key = codeToKey(e.code);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    return [...mods, key].join('+');
  }

  function parse(acc) {
    const parts = String(acc || '').split('+');
    const key = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return {
      ctrl: mods.has('control') || mods.has('ctrl') || mods.has('commandorcontrol') || mods.has('cmdorctrl'),
      shift: mods.has('shift'),
      alt: mods.has('alt'),
      meta: mods.has('super') || mods.has('meta'),
      code: keyToCode(key),
      key,
    };
  }

  function matches(e, acc) {
    const p = parse(acc);
    return e.code === p.code && e.ctrlKey === p.ctrl && e.shiftKey === p.shift && e.altKey === p.alt && e.metaKey === p.meta;
  }

  // Годится ли сочетание: нужен модификатор, кроме F-клавиш и PrintScreen.
  function isValid(acc) {
    const p = parse(acc);
    if (!p.key) return false;
    if (STANDALONE.test(p.key)) return true;
    return p.ctrl || p.alt || p.meta;
  }

  function label(acc) {
    return String(acc || '').split('+').map((part) => {
      const l = part.toLowerCase();
      if (l === 'commandorcontrol' || l === 'cmdorctrl' || l === 'control') return 'Ctrl';
      if (l === 'super' || l === 'meta') return 'Win';
      if (l === 'space') return 'Пробел';
      if (l === 'printscreen') return 'PrtSc';
      if (l === 'up') return '↑';
      if (l === 'down') return '↓';
      if (l === 'left') return '←';
      if (l === 'right') return '→';
      return part;
    }).join('+');
  }

  global.Keys = { fromEvent, parse, matches, isValid, label };
})(window);
