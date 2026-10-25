# Постоянный помощник приложения (запускается один раз при старте).
# Команды в stdin, по одной в строке:
#   shot <id> <x> <y> <w> <h> <path>  — снимок области экрана (физические пиксели) в сырой BGRA-файл
#   arm / disarm                      — сообщать ли о Ctrl+V пользователя (строка CTRLV)
#   paste                             — нажать Ctrl+V
#   quit                              — выход
# Ответы в stdout: READY, SHOT <id> ok <w> <h> <мс>, SHOT <id> err <текст>, CTRLV.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class Helper {
  const int WH_KEYBOARD_LL = 13; const int WM_KEYDOWN = 0x100; const int WM_SYSKEYDOWN = 0x104;
  delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  static Proc proc = Callback; static IntPtr hook = IntPtr.Zero;
  static volatile bool armed = false;
  static readonly object outLock = new object();

  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc p, IntPtr m, uint t);
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

  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER {
    public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
    public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public int biClrUsed; public int biClrImportant;
  }

  static void Say(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

  static IntPtr Callback(int n, IntPtr w, IntPtr l) {
    if (armed && n >= 0 && ((int)w == WM_KEYDOWN || (int)w == WM_SYSKEYDOWN)) {
      int vk = Marshal.ReadInt32(l);
      if (vk == 0x56 && (GetAsyncKeyState(0x11) & 0x8000) != 0) Say("CTRLV");
    }
    return CallNextHookEx(hook, n, w, l);
  }

  static void Paste() {
    keybd_event(0x11, 0x1D, 0, UIntPtr.Zero); Thread.Sleep(20);
    keybd_event(0x56, 0x2F, 0, UIntPtr.Zero); Thread.Sleep(30);
    keybd_event(0x56, 0x2F, 2, UIntPtr.Zero); Thread.Sleep(20);
    keybd_event(0x11, 0x1D, 2, UIntPtr.Zero);
  }

  // Снимок области экрана: BitBlt в DIB сверху вниз, 32 бита BGRA, запись в файл.
  static void Shot(string id, int x, int y, int w, int h, string path) {
    Stopwatch sw = Stopwatch.StartNew();
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
      byte[] buf = new byte[len];
      Marshal.Copy(bits, buf, 0, len);
      File.WriteAllBytes(path, buf);
      Say("SHOT " + id + " ok " + w + " " + h + " " + sw.ElapsedMilliseconds);
    } catch (Exception e) {
      Say("SHOT " + id + " err " + e.Message.Replace("\n", " "));
    } finally {
      if (dib != IntPtr.Zero) DeleteObject(dib);
      DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) Say("HOOK_FAILED");
    Thread t = new Thread(delegate() {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        string[] p = line.Trim().Split(new char[] { ' ' }, 7);
        if (p.Length == 0) continue;
        try {
          if (p[0] == "shot" && p.Length == 7) Shot(p[1], int.Parse(p[2]), int.Parse(p[3]), int.Parse(p[4]), int.Parse(p[5]), p[6]);
          else if (p[0] == "arm") armed = true;
          else if (p[0] == "disarm") armed = false;
          else if (p[0] == "paste") Paste();
          else if (p[0] == "quit") break;
        } catch (Exception e) { Say("ERR " + e.Message.Replace("\n", " ")); }
      }
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
