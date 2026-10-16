using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

/*
 * PC Remote helper. Two modes:
 *   RemoteHelper.exe input                  - replays input commands from stdin
 *   RemoteHelper.exe screen <w> <q> <fps>   - streams JPEG frames to stdout
 *
 * Input protocol: one tab-separated command per line
 *   move <dx> <dy> | down <button> | up <button> | click <button>
 *   scroll <dy> <dx> | keydown <vk> | keyup <vk> | key <vk> | text <utf8>
 */
internal static class RemoteHelper
{
    /* ------------------------- Win32 ------------------------- */

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;

    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    /* The screen bitmap from CopyFromScreen never contains the mouse pointer
     * (it is drawn by the desktop compositor, not part of the pixels), so the
     * pointer has to be drawn on top of each captured frame. */
    private const int CURSOR_SHOWING = 0x00000001;
    private const int DI_NORMAL = 0x0003;

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DrawIconEx(
        IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth,
        int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static void EnableDpiAwareness()
    {
        try { SetProcessDpiAwareness(2); }
        catch
        {
            try { SetProcessDPIAware(); }
            catch { /* best effort */ }
        }
    }

    /* ---------------------- input sending ---------------------- */

    private static void SendMouse(int dx, int dy, uint flags, uint data)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dx = dx;
        inputs[0].u.mi.dy = dy;
        inputs[0].u.mi.mouseData = data;
        inputs[0].u.mi.dwFlags = flags;
        ReportIfFailed(SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))), "mouse");
    }

    private static void SendKey(ushort vk, ushort scan, uint flags)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.wScan = scan;
        inputs[0].u.ki.dwFlags = flags;
        ReportIfFailed(SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))), "key");
    }

    private static int failureCount = 0;

    /** SendInput silently does nothing if the desktop blocks it (e.g. the
     *  foreground window belongs to an elevated process). Surface that once
     *  so the app can explain it instead of appearing broken. */
    private static void ReportIfFailed(uint sent, string kind)
    {
        if (sent != 0) return;
        failureCount++;
        if (failureCount == 1 || failureCount % 200 == 0)
        {
            int error = Marshal.GetLastWin32Error();
            Console.Error.WriteLine(
                "input blocked (" + kind + "): SendInput error " + error +
                (error == 5 ? " - an elevated window may be in the foreground, run PC Remote as administrator" : ""));
            Console.Error.Flush();
        }
    }

    private static int stuckStreak = 0;

    /** SendInput can report success while the pointer never actually moves
     *  (a locked session, or a process that is not on the active desktop).
     *  Detect that so the app can explain it instead of looking broken. Moves
     *  that are legitimately clamped at a screen edge are ignored. */
    private static void CheckCursorMoved(POINT before, POINT after, int dx, int dy)
    {
        if (before.X != after.X || before.Y != after.Y)
        {
            stuckStreak = 0;
            return;
        }
        Rectangle screen;
        try { screen = SystemInformation.VirtualScreen; }
        catch { screen = Rectangle.Empty; }
        if (screen.Width > 0)
        {
            int tx = before.X + dx;
            int ty = before.Y + dy;
            if (tx < screen.Left || tx >= screen.Right || ty < screen.Top || ty >= screen.Bottom) return;
        }
        stuckStreak++;
        if (stuckStreak == 8 || stuckStreak % 300 == 0)
        {
            Console.Error.WriteLine(
                "input blocked (move): the cursor did not move after SendInput (stayed at " +
                before.X + "," + before.Y + ") - the session may be locked, or PC Remote is not on the active desktop");
            Console.Error.Flush();
        }
    }

    private static void Button(string name, bool down)
    {
        switch (name)
        {
            case "right":
                SendMouse(0, 0, down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP, 0);
                break;
            case "middle":
                SendMouse(0, 0, down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP, 0);
                break;
            default:
                SendMouse(0, 0, down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, 0);
                break;
        }
    }

    private static int Int(string[] parts, int index)
    {
        if (index >= parts.Length) return 0;
        int value;
        return int.TryParse(parts[index], out value) ? value : 0;
    }

    private static int InputMode()
    {
        var stdin = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            string[] parts = line.Split('\t');
            switch (parts[0])
            {
                case "move":
                    {
                        int dx = Math.Max(-4000, Math.Min(4000, Int(parts, 1)));
                        int dy = Math.Max(-4000, Math.Min(4000, Int(parts, 2)));
                        if (dx != 0 || dy != 0)
                        {
                            POINT before;
                            GetCursorPos(out before);
                            SendMouse(dx, dy, MOUSEEVENTF_MOVE, 0);
                            Thread.Sleep(1);
                            POINT after;
                            GetCursorPos(out after);
                            CheckCursorMoved(before, after, dx, dy);
                        }
                        break;
                    }
                case "down": Button(parts.Length > 1 ? parts[1] : "left", true); break;
                case "up": Button(parts.Length > 1 ? parts[1] : "left", false); break;
                case "click":
                    {
                        string button = parts.Length > 1 ? parts[1] : "left";
                        Button(button, true);
                        Thread.Sleep(8);
                        Button(button, false);
                        break;
                    }
                case "scroll":
                    {
                        int dy = Int(parts, 1);
                        int dx = Int(parts, 2);
                        if (dy != 0) SendMouse(0, 0, MOUSEEVENTF_WHEEL, unchecked((uint)dy));
                        if (dx != 0) SendMouse(0, 0, MOUSEEVENTF_HWHEEL, unchecked((uint)dx));
                        break;
                    }
                case "keydown":
                    SendKey((ushort)Int(parts, 1), 0, 0);
                    break;
                case "keyup":
                    SendKey((ushort)Int(parts, 1), 0, KEYEVENTF_KEYUP);
                    break;
                case "key":
                    {
                        ushort vk = (ushort)Int(parts, 1);
                        SendKey(vk, 0, 0);
                        Thread.Sleep(12);
                        SendKey(vk, 0, KEYEVENTF_KEYUP);
                        break;
                    }
                case "text":
                    {
                        string text = parts.Length > 1 ? parts[1] : string.Empty;
                        foreach (char ch in text)
                        {
                            SendKey(0, ch, KEYEVENTF_UNICODE);
                            SendKey(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
                        }
                        break;
                    }
                case "ping": break;
                case "probe":
                    {
                        POINT p;
                        GetCursorPos(out p);
                        Console.Out.WriteLine("pos\t" + p.X + "\t" + p.Y);
                        Console.Out.Flush();
                        break;
                    }
            }
        }
        return 0;
    }

    /* --------------------- screen streaming --------------------- */

    /** Draws the current mouse pointer onto a captured frame. `ptScreenPos` is
     *  the hotspot, so shift by the hotspot to get the icon's top-left corner.
     *  Best effort: a failure here must never break the video stream. */
    private static void DrawCursor(Graphics g, Rectangle bounds)
    {
        try
        {
            CURSORINFO info = new CURSORINFO();
            info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref info)) return;
            if ((info.flags & CURSOR_SHOWING) == 0 || info.hCursor == IntPtr.Zero) return;

            int x = info.ptScreenPos.X - bounds.X;
            int y = info.ptScreenPos.Y - bounds.Y;
            ICONINFO icon;
            if (GetIconInfo(info.hCursor, out icon))
            {
                x -= icon.xHotspot;
                y -= icon.yHotspot;
                if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
                if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
            }

            IntPtr hdc = g.GetHdc();
            try
            {
                DrawIconEx(hdc, x, y, info.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }
        catch
        {
            /* never let a cursor problem stop the stream */
        }
    }

    private static int ScreenMode(string[] args)
    {
        int maxWidth = args.Length > 1 ? int.Parse(args[1]) : 1280;
        int quality = args.Length > 2 ? int.Parse(args[2]) : 55;
        int fps = args.Length > 3 ? int.Parse(args[3]) : 8;
        if (maxWidth < 160) maxWidth = 160;
        if (quality < 10) quality = 10;
        if (fps < 1) fps = 1;

        Rectangle bounds = SystemInformation.VirtualScreen;
        if (bounds.Width <= 0 || bounds.Height <= 0) bounds = new Rectangle(0, 0, 1280, 720);

        double scale = Math.Min(1.0, (double)maxWidth / bounds.Width);
        int outWidth = Math.Max(1, (int)(bounds.Width * scale));
        int outHeight = Math.Max(1, (int)(bounds.Height * scale));

        ImageCodecInfo jpegCodec = null;
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.MimeType == "image/jpeg") jpegCodec = codec;
        }
        if (jpegCodec == null) return 3;

        EncoderParameters encoderParams = new EncoderParameters(1);
        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);

        using (Bitmap source = new Bitmap(bounds.Width, bounds.Height))
        using (Bitmap target = new Bitmap(outWidth, outHeight))
        using (Graphics sourceGraphics = Graphics.FromImage(source))
        using (Graphics targetGraphics = Graphics.FromImage(target))
        {
            targetGraphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Low;
            targetGraphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;

            Stream stdout = Console.OpenStandardOutput();
            Console.Error.WriteLine(
                "{\"width\":" + bounds.Width +
                ",\"height\":" + bounds.Height +
                ",\"frameWidth\":" + outWidth +
                ",\"frameHeight\":" + outHeight + "}");
            Console.Error.Flush();

            int frameDelay = Math.Max(1, 1000 / fps);
            while (true)
            {
                int started = Environment.TickCount;
                try
                {
                    sourceGraphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, source.Size);
                    DrawCursor(sourceGraphics, bounds);
                    targetGraphics.DrawImage(source, 0, 0, outWidth, outHeight);
                    using (MemoryStream buffer = new MemoryStream(96 * 1024))
                    {
                        target.Save(buffer, jpegCodec, encoderParams);
                        byte[] bytes = buffer.ToArray();
                        byte[] length = BitConverter.GetBytes(bytes.Length);
                        stdout.Write(length, 0, 4);
                        stdout.Write(bytes, 0, bytes.Length);
                        stdout.Flush();
                    }
                }
                catch
                {
                    Thread.Sleep(400);
                }
                int elapsed = Environment.TickCount - started;
                int sleep = frameDelay - elapsed;
                if (sleep > 0) Thread.Sleep(sleep);
            }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            EnableDpiAwareness();
            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "input";
            if (mode == "screen") return ScreenMode(args);
            if (mode == "input") return InputMode();
            Console.Error.WriteLine("Unknown mode: " + mode);
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }
}
