// Рисует иконку программы build/icon.png (256×256) без сторонних библиотек: оранжевое кольцо с белым центром,
// как в трее. Запуск: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // сглаживание: 4×4 подвыборки на пиксель
const c = SIZE / 2;
const ORANGE = [255, 90, 40];
const DARK = [24, 24, 28];
const WHITE = [255, 255, 255];

function colorAt(x, y) {
  const d = Math.hypot(x - c, y - c);
  if (d <= c * 0.40) return WHITE;
  if (d <= c * 0.56) return DARK;
  if (d <= c * 0.96) return ORANGE;
  return null;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // фильтр строки: нет
  for (let x = 0; x < SIZE; x++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const col = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
      }
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
function crc32(buf) {
  let v = 0xffffffff;
  for (const byte of buf) v = CRC_TABLE[(v ^ byte) & 0xff] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8 бит, RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon:', out, png.length, 'bytes');
