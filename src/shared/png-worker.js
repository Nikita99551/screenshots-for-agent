// Фоновый поток кодирования PNG. В окне браузерный движок откладывает кодирование «до свободной минуты»
// (в фоновом окне — до нескольких секунд), а в отдельном потоке оно начинается сразу.
self.onmessage = async (e) => {
  const { id, bitmap } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
