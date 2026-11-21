using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

internal static class NativeWindows {
    delegate bool EnumProc(IntPtr h,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect rect);
    [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
    internal sealed record WindowInfo(string WindowId,long Handle,int Pid,string Process,string Title,int Left,int Top,int Width,int Height,bool Minimized);
    static WindowInfo? Info(IntPtr h) {
        if(h==IntPtr.Zero||!GetWindowRect(h,out var b))return null;
        GetWindowThreadProcessId(h,out uint pid);
        var text=new StringBuilder(2048);GetWindowText(h,text,text.Capacity);
        try {using var process=Process.GetProcessById((int)pid);
            return new($"{h.ToInt64():x}:{pid}:{process.StartTime.ToUniversalTime().Ticks}",h.ToInt64(),(int)pid,process.ProcessName,text.ToString(),b.Left,b.Top,b.Right-b.Left,b.Bottom-b.Top,IsIconic(h));
        }catch{return null;}
    }
    internal static WindowInfo[] Catalog() {
        Desktop.Interactive();var rows=new List<WindowInfo>();
        EnumWindows((h,_)=>{if(IsWindowVisible(h)&&Info(h) is { } info&&info.Title.Length>0)rows.Add(info);return true;},IntPtr.Zero);
        return rows.ToArray();
    }
    internal static string ForegroundIdentity() {var w=Info(GetForegroundWindow());return w==null?"none":$"{w.WindowId}:{w.Left},{w.Top},{w.Width},{w.Height}";}
    internal static object Capture(JsonElement r) {
        Desktop.Interactive();var rows=Catalog().AsEnumerable();
        string id=r.TryGetProperty("windowId",out var i)?i.GetString()??"":"";
        string title=r.TryGetProperty("titleContains",out var t)?t.GetString()??"":"";
        string process=r.TryGetProperty("processName",out var p)?p.GetString()??"":"";
        if(id.Length==0&&title.Length==0&&process.Length==0)throw new ArgumentException("WINDOW_SELECTOR_REQUIRED");
        if(id.Length>0)rows=rows.Where(w=>w.WindowId==id);
        if(title.Length>0)rows=rows.Where(w=>w.Title.Contains(title,StringComparison.OrdinalIgnoreCase));
        if(process.Length>0)rows=rows.Where(w=>w.Process.Equals(process,StringComparison.OrdinalIgnoreCase));
        var matches=rows.ToArray();
        if(matches.Length!=1)throw new ArgumentException(matches.Length==0?"WINDOW_NOT_FOUND":"AMBIGUOUS_WINDOW: use an exact windowId from computer_pro_windows");
        var target=matches[0];var handle=new IntPtr(target.Handle);
        bool focus=!r.TryGetProperty("bringToFront",out var f)||f.GetBoolean();
        if(focus) {
            if(target.Minimized)ShowWindow(handle,9);
            SetForegroundWindow(handle);
            for(int attempt=0;attempt<10&&GetForegroundWindow()!=handle;attempt++)Thread.Sleep(30);
            if(GetForegroundWindow()!=handle)throw new InvalidOperationException("FOREGROUND_DENIED: window capture was not performed");
        }
        var fresh=Info(handle);
        if(fresh==null||fresh.WindowId!=target.WindowId)throw new InvalidOperationException("WINDOW_IDENTITY_CHANGED");
        if(fresh.Minimized)throw new InvalidOperationException("WINDOW_MINIMIZED");
        var visible=Rectangle.Intersect(new Rectangle(fresh.Left,fresh.Top,fresh.Width,fresh.Height),SystemInformation.VirtualScreen);
        if(visible.Width<=0||visible.Height<=0||(long)visible.Width*visible.Height>25000000)throw new InvalidOperationException("WINDOW_IMAGE_LIMIT");
        var state=Desktop.State();var foregroundBefore=GetForegroundWindow();
        using var image=new Bitmap(visible.Width,visible.Height,PixelFormat.Format32bppArgb);
        using(var graphics=Graphics.FromImage(image))graphics.CopyFromScreen(visible.X,visible.Y,0,0,visible.Size);
        var afterState=Desktop.State();var afterInfo=Info(handle);
        if(GetForegroundWindow()!=foregroundBefore||afterInfo!=fresh)throw new InvalidOperationException("WINDOW_STATE_CHANGED: capture again");
        using var stream=new MemoryStream();image.Save(stream,ImageFormat.Png);
        return new{png=Convert.ToBase64String(stream.ToArray()),windowId=fresh.WindowId,title=fresh.Title,process=fresh.Process,
            bounds=new{x=visible.X,y=visible.Y,width=visible.Width,height=visible.Height},foreground=GetForegroundWindow()==handle,
            captureKind="visible-screen-region",occlusion="not-guaranteed",state,inputChangedDuringCapture=state!=afterState};
    }
    internal static object ClipboardImage() {
        Desktop.Interactive();using var image=Clipboard.GetImage();
        if(image==null)throw new InvalidOperationException("CLIPBOARD_EMPTY");
        if((long)image.Width*image.Height>25000000)throw new ArgumentException("IMAGE_DIMENSIONS_EXCEEDED");
        using var stream=new MemoryStream();image.Save(stream,ImageFormat.Png);
        return new{png=Convert.ToBase64String(stream.ToArray()),width=image.Width,height=image.Height};
    }
}
