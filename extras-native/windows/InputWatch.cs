using System.Runtime.InteropServices;
using System.Windows.Forms;

// Counts activity, never records key text. Callbacks only update counters and forward events.
internal static class InputWatch {
    delegate IntPtr HookProc(int code,IntPtr w,IntPtr l);
    [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetWindowsHookEx(int id,HookProc proc,IntPtr module,uint thread);
    [DllImport("user32.dll")]static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr w,IntPtr l);
    [DllImport("user32.dll")]static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
    [DllImport("user32.dll")]static extern bool UnregisterHotKey(IntPtr h,int id);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string? name);
    [StructLayout(LayoutKind.Sequential)]struct MouseHook { public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra; }
    static readonly HookProc keyboard=Keyboard,mouse=Mouse;
    static readonly ManualResetEventSlim ready=new();
    static long revision;static int started,lastX=int.MinValue,lastY=int.MinValue;
    internal static readonly string Instance=Guid.NewGuid().ToString("N");
    static readonly string pauseFile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ComputerPro","desktop-paused");
    internal static volatile bool Available,Paused,HotkeyAvailable;
    internal static long Revision=>Interlocked.Read(ref revision);
    internal static readonly UIntPtr InjectedTag=new UIntPtr(0x4350524F);
    internal static long MarkDispatch()=>Interlocked.Increment(ref revision);
    static IntPtr Keyboard(int code,IntPtr w,IntPtr l) {if(code>=0)Interlocked.Increment(ref revision);return CallNextHookEx(IntPtr.Zero,code,w,l);}
    static IntPtr Mouse(int code,IntPtr w,IntPtr l) {
        if(code>=0) {
            var e=Marshal.PtrToStructure<MouseHook>(l);
            // Some remote/driver stacks periodically emit no-op mouse moves.
            if(e.Extra!=InjectedTag&&(w.ToInt32()!=0x200||e.X!=lastX||e.Y!=lastY))Interlocked.Increment(ref revision);
            lastX=e.X;lastY=e.Y;
        }
        return CallNextHookEx(IntPtr.Zero,code,w,l);
    }
    sealed class Pump : NativeWindow,IDisposable {
        internal Pump(){CreateHandle(new CreateParams{Caption="ComputerPro InputWatch",Parent=new IntPtr(-3)});HotkeyAvailable=RegisterHotKey(Handle,1,0x4000|1|2,0x77);}
        protected override void WndProc(ref Message m){if(m.Msg==0x312){
            try {Directory.CreateDirectory(Path.GetDirectoryName(pauseFile)!);if(Paused)File.Delete(pauseFile);else File.WriteAllText(pauseFile,"paused");Paused=!Paused;}
            catch {Paused=true;}
            Interlocked.Increment(ref revision);
        }base.WndProc(ref m);}
        public void Dispose(){UnregisterHotKey(Handle,1);DestroyHandle();}
    }
    internal static void Start() {
        if(Interlocked.Exchange(ref started,1)==0) {
            Paused=File.Exists(pauseFile);
            var thread=new Thread(()=>{
                IntPtr kh=IntPtr.Zero,mh=IntPtr.Zero;
                try {
                    using var pump=new Pump();var module=GetModuleHandle(null);
                    kh=SetWindowsHookEx(13,keyboard,module,0);mh=SetWindowsHookEx(14,mouse,module,0);
                    Available=kh!=IntPtr.Zero&&mh!=IntPtr.Zero;ready.Set();Application.Run();
                }catch{Available=false;ready.Set();}
                finally{Available=false;if(kh!=IntPtr.Zero)UnhookWindowsHookEx(kh);if(mh!=IntPtr.Zero)UnhookWindowsHookEx(mh);}
            }){IsBackground=true,Name="ComputerPro InputWatch"};thread.SetApartmentState(ApartmentState.STA);thread.Start();
        }
        if(!ready.Wait(2000))throw new InvalidOperationException("INPUT_MONITOR_START_TIMEOUT");
    }
    internal static object Status(){Start();return new{available=Available,paused=Paused,revision=Revision,hotkeyAvailable=HotkeyAvailable,hotkey="Ctrl+Alt+F8",recordsKeyText=false};}
}
