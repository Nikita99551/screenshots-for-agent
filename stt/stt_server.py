"""Локальное распознавание речи для приложения «Скриншоты для агента».

Держит модель GigaAM v3 E2E (русский, с пунктуацией) в памяти и отвечает на команды из stdin:
    tr <id> <путь к файлу float32 16 кГц моно>
Ответ в stdout одной строкой JSON: {"id": ..., "ok": true, "text": ..., "ms": ...}
При старте печатает {"ready": true, ...} после загрузки модели.
"""
import json
import os
import sys
import time

import numpy as np

MODEL = os.environ.get("STT_MODEL", "gigaam-v3-e2e-rnnt")
QUANT = os.environ.get("STT_QUANT", "int8") or None
SR = 16000
CHUNK_SEC = 22  # длинные записи режем по тишине через VAD


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def no_power_throttling(priority=0x8000):
    """Windows 11 переводит фоновые процессы без окна в режим экономии (EcoQoS): распознавание
    тогда идёт в разы медленнее. Отключаем это для себя и чуть поднимаем приоритет."""
    try:
        import ctypes
        from ctypes import wintypes

        class PPTS(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        st = PPTS(1, 1, 0)  # ProcessPowerThrottling: EXECUTION_SPEED выключен
        k32.SetProcessInformation(k32.GetCurrentProcess(), 4, ctypes.byref(st), ctypes.sizeof(st))
        k32.SetPriorityClass(k32.GetCurrentProcess(), priority)  # 0x4000 ниже обычного, 0x8000 выше обычного
    except Exception as e:
        say({"log": f"power throttling: {e}"})


def session_options():
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
    so.inter_op_num_threads = 1
    so.enable_mem_pattern = False  # длина фраз всё время разная
    return so


def load():
    import onnx_asr

    t0 = time.time()
    try:
        model = onnx_asr.load_model(MODEL, quantization=QUANT, sess_options=session_options())
    except Exception as e:  # нет квантованной версии — берём обычную
        say({"log": f"quantized load failed: {e}; loading fp32"})
        model = onnx_asr.load_model(MODEL, sess_options=session_options())
    vad_model = None
    try:
        vad_model = model.with_vad(onnx_asr.load_vad("silero"))
    except Exception as e:
        say({"log": f"vad unavailable: {e}"})
    # Прогрев на фразах разной длины: первое распознавание новой длины без него идёт в 10–20 раз дольше.
    rng = np.random.default_rng(0)
    for sec in (1, 3, 6, 10, 16, CHUNK_SEC):
        model.recognize((rng.standard_normal(SR * sec) * 0.01).astype(np.float32), sample_rate=SR)
    return model, vad_model, time.time() - t0


def recognize(model, vad_model, audio):
    if len(audio) <= CHUNK_SEC * SR or vad_model is None:
        return model.recognize(audio, sample_rate=SR)
    parts = [seg.text for seg in vad_model.recognize(audio, sample_rate=SR)]
    return " ".join(p.strip() for p in parts if p and p.strip())


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    no_power_throttling(0x4000)  # на прогреве уступаем процессор, чтобы не тормозить снимки экрана
    try:
        model, vad_model, sec = load()
    except Exception as e:
        say({"ready": False, "error": str(e)})
        return
    no_power_throttling(0x8000)
    say({"ready": True, "model": MODEL, "load_sec": round(sec, 2)})
    for line in sys.stdin:
        parts = line.strip().split(" ", 2)
        if not parts or parts[0] == "":
            continue
        if parts[0] == "quit":
            break
        if parts[0] != "tr" or len(parts) != 3:
            continue
        rid, path = parts[1], parts[2]
        t0 = time.time()
        try:
            audio = np.fromfile(path, dtype=np.float32)
            text = recognize(model, vad_model, audio) if len(audio) > SR // 5 else ""
            say({"id": rid, "ok": True, "text": (text or "").strip(), "ms": int((time.time() - t0) * 1000),
                 "sec": round(len(audio) / SR, 2)})
        except Exception as e:
            say({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
