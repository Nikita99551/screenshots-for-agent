# Постоянный помощник приложения (запускается один раз при старте, живёт, пока жив Electron).
# Команды в stdin, по одной в строке:
#   shot <id> <x> <y> <w> <h> <flush> <path> — снимок области (физ. пиксели) в сырой BGRA; flush — сколько кадров DwmFlush ждать
#   clip <id> <manifest>              — положить в буфер файлы + текст (манифест: N, N путей, дальше текст)
#   arm / disarm                      — включить / выключить перехват Ctrl+V (строка CTRLV)
#   paste                             — нажать Ctrl+V
#   quit                              — выход
# Ответы в stdout: READY, SHOT <id> ok <w> <h> <мс>, SHOT <id> err <текст>, CLIP <id> ok <мс>, CLIP <id> err <текст>, CTRLV.
# Перехват клавиатуры включается только между «скопировать всё» и вставкой, чтобы в остальное время
# ни одно нажатие клавиши в системе не зависело от этого процесса.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Specialized;

public class Helper {
  const int WH_KEYBOARD_LL = 13; const int WM_KEYDOWN = 0x100; const int WM_SYSKEYDOWN = 0x104;
  delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  static Proc proc = Callback; static IntPtr hook = IntPtr.Zero;
  static readonly object outLock = new object();
  static Control ui; // элемент на STA-потоке: буфер обмена и хук ставятся только отсюда

  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc p, IntPtr m, uint t);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr sec, uint off);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, ref PPTS info, int size);

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
    public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public int biClrUsed; public int biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PPTS { public uint Version; public uint ControlMask; public uint StateMask; }

  static void Say(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  static string Clean(Exception e) { return e.Message.Replace("\r", " ").Replace("\n", " "); }

  static IntPtr Callback(int n, IntPtr w, IntPtr l) {
    if (n >= 0 && ((int)w == WM_KEYDOWN || (int)w == WM_SYSKEYDOWN)) {
      int vk = Marshal.ReadInt32(l);
      if (vk == 0x56 && (GetAsyncKeyState(0x11) & 0x8000) != 0) Say("CTRLV");
    }
    return CallNextHookEx(hook, n, w, l);
  }

  static void Arm() {
    if (hook != IntPtr.Zero) return;
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) Say("HOOK_FAILED");
  }
  static void Disarm() {
    if (hook == IntPtr.Zero) return;
    UnhookWindowsHookEx(hook); hook = IntPtr.Zero;
  }

  static void Paste() {
    keybd_event(0x11, 0x1D, 0, UIntPtr.Zero); Thread.Sleep(20);
    keybd_event(0x56, 0x2F, 0, UIntPtr.Zero); Thread.Sleep(30);
    keybd_event(0x56, 0x2F, 2, UIntPtr.Zero); Thread.Sleep(20);
    keybd_event(0x11, 0x1D, 2, UIntPtr.Zero);
  }

  // Манифест (UTF-8): первая строка — число файлов N, затем N путей, всё остальное — текст.
  static void Clip(string id, string manifest) {
    Stopwatch sw = Stopwatch.StartNew();
    try {
      string[] lines = File.ReadAllText(manifest, Encoding.UTF8).Replace("\r\n", "\n").Split('\n');
      int n = int.Parse(lines[0].Trim());
      StringCollection files = new StringCollection();
      for (int i = 1; i <= n; i++) files.Add(lines[i]);
      string text = n + 1 < lines.Length ? string.Join("\r\n", lines, n + 1, lines.Length - n - 1).TrimEnd() : "";
      DataObject data = new DataObject();
      if (files.Count > 0) data.SetFileDropList(files);
      if (text.Length > 0) data.SetText(text, TextDataFormat.UnicodeText);
      Clipboard.SetDataObject(data, true, 20, 100); // буфер может быть занят другой программой: ждём до 2 с
      Say("CLIP " + id + " ok " + sw.ElapsedMilliseconds);
    } catch (ExternalException e) {
      Say("CLIP " + id + " busy " + Clean(e));
    } catch (Exception e) {
      Say("CLIP " + id + " err " + Clean(e));
    }
  }

  // Снимок области экрана: BitBlt в DIB сверху вниз, 32 бита BGRA, запись в файл.
  static void Shot(string id, int x, int y, int w, int h, int flush, string path) {
    Stopwatch sw = Stopwatch.StartNew();
    // flush > 0: дождаться, пока Windows выведет кадры (например, после скрытия панели), вместо фиксированной паузы
    for (int i = 0; i < flush; i++) { try { DwmFlush(); } catch { } }
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    BITMAPINFOHEADER bi = new BITMAPINFOHEADER();
    bi.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32; bi.biCompression = 0;
    IntPtr bits;
    IntPtr dib = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
    try {
      if (dib == IntPtr.Zero) throw new Exception("CreateDIBSection failed");
      IntPtr old = SelectObject(mem, dib);
      bool ok = BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020 | 0x40000000);
      SelectObject(mem, old);
      if (!ok) throw new Exception("BitBlt failed");
      int len = w * h * 4;
      // пишем прямо из памяти DIB, без лишнего массива на 15 МБ
      using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1 << 20)) {
        byte[] chunk = new byte[1 << 20];
        for (int off = 0; off < len; off += chunk.Length) {
          int c = Math.Min(chunk.Length, len - off);
          Marshal.Copy(new IntPtr(bits.ToInt64() + off), chunk, 0, c);
          fs.Write(chunk, 0, c);
        }
      }
      Say("SHOT " + id + " ok " + w + " " + h + " " + sw.ElapsedMilliseconds);
    } catch (Exception e) {
      Say("SHOT " + id + " err " + Clean(e));
    } finally {
      if (dib != IntPtr.Zero) DeleteObject(dib);
      DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  static void OnUi(Action a) {
    try { ui.Invoke(a); } catch (Exception e) { Say("ERR " + Clean(e)); }
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    try {
      // фоновый процесс без окна Windows 11 переводит в экономный режим — отключаем для себя
      PPTS st = new PPTS(); st.Version = 1; st.ControlMask = 1; st.StateMask = 0;
      SetProcessInformation(GetCurrentProcess(), 4, ref st, Marshal.SizeOf(typeof(PPTS)));
    } catch { }
    ui = new Control();
    IntPtr forceHandle = ui.Handle;
    Thread t = new Thread(delegate() {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        string[] p = line.Trim().Split(new char[] { ' ' }, 8);
        if (p.Length == 0) continue;
        try {
          if (p[0] == "shot" && p.Length == 8) Shot(p[1], int.Parse(p[2]), int.Parse(p[3]), int.Parse(p[4]), int.Parse(p[5]), int.Parse(p[6]), p[7]);
          else if (p[0] == "clip") { string[] q = line.Trim().Split(new char[] { ' ' }, 3); string cid = q[1]; string cpath = q[2]; OnUi(delegate { Clip(cid, cpath); }); }
          else if (p[0] == "arm") OnUi(Arm);
          else if (p[0] == "disarm") OnUi(Disarm);
          else if (p[0] == "paste") Paste();
          else if (p[0] == "quit") break;
        } catch (Exception e) { Say("ERR " + Clean(e)); }
      }
      try { ui.Invoke(new Action(Disarm)); } catch { }
      Application.Exit();
    });
    t.IsBackground = true; t.Start();
    Say("READY");
    Application.Run();
  }
}
"@
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Helper]::Run()
