using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

internal static class Desktop {
    [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll",SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder info,uint length,out uint needed);
    [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint count,Input[] inputs,int size);
    [StructLayout(LayoutKind.Sequential)]struct MouseInput {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
    [StructLayout(LayoutKind.Sequential)]struct Input {public uint Type;public MouseInput Mouse;}
    internal static void Interactive() {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var handle=OpenInputDesktop(0,false,1);if(handle==IntPtr.Zero)throw new InvalidOperationException("INTERACTIVE_DESKTOP_REQUIRED");
        try {var name=new StringBuilder(256);if(!GetUserObjectInformation(handle,2,name,512,out _)||name.ToString()!="Default")throw new InvalidOperationException("SECURE_OR_LOCKED_DESKTOP");}
        finally{CloseDesktop(handle);}
    }
    static Rectangle Bounds() => SystemInformation.VirtualScreen;
    static string Topology() => string.Join(";",Screen.AllScreens.OrderBy(s=>s.DeviceName).Select(s=>$"{s.DeviceName}:{s.Bounds.X},{s.Bounds.Y},{s.Bounds.Width},{s.Bounds.Height}"));
    internal static object Capture() {
        Interactive();var b=Bounds();
        if(b.Width<1||b.Height<1||(long)b.Width*b.Height>25000000)throw new ArgumentException("DESKTOP_IMAGE_LIMIT");
        using var image=new Bitmap(b.Width,b.Height,PixelFormat.Format32bppArgb);
        using(var g=Graphics.FromImage(image))g.CopyFromScreen(b.X,b.Y,0,0,b.Size,CopyPixelOperation.SourceCopy);
        using var stream=new MemoryStream();image.Save(stream,ImageFormat.Png);
        return new {png=Convert.ToBase64String(stream.ToArray()),width=b.Width,height=b.Height,left=b.Left,top=b.Top,topology=Topology(),
            displays=Screen.AllScreens.Select(s=>new{name=s.DeviceName,left=s.Bounds.Left,top=s.Bounds.Top,width=s.Bounds.Width,height=s.Bounds.Height,primary=s.Primary})};
    }
    static void InputEvent(uint flags,int x=0,int y=0,uint data=0) {
        var input=new Input{Mouse=new MouseInput{X=x,Y=y,Data=data,Flags=flags}};
        if(SendInput(1,[input],Marshal.SizeOf<Input>())!=1)throw new InvalidOperationException("SYSTEM_INPUT_REJECTED: no elevation or automatic retry is attempted");
    }
    static void Move(int x,int y,Rectangle b) {
        if(!b.Contains(x,y)||!Screen.AllScreens.Any(s=>s.Bounds.Contains(x,y)))throw new ArgumentException("POINT_OUTSIDE_DISPLAY");
        InputEvent(0x8000|0x4000|1,(int)Math.Round((x-b.Left)*65535.0/Math.Max(1,b.Width-1)),(int)Math.Round((y-b.Top)*65535.0/Math.Max(1,b.Height-1)));
    }
    static (int X,int Y) Point(JsonElement r,string name,Rectangle bounds) {
        var p=r.GetProperty(name);int x=p.GetProperty("x").GetInt32(),y=p.GetProperty("y").GetInt32();
        if(!bounds.Contains(x,y)||!Screen.AllScreens.Any(s=>s.Bounds.Contains(x,y)))throw new ArgumentException("POINT_OUTSIDE_DISPLAY");return(x,y);
    }
    internal static object Act(JsonElement r) {
        Interactive();var bounds=Bounds();if(r.GetProperty("topology").GetString()!=Topology())throw new ArgumentException("DISPLAY_TOPOLOGY_CHANGED: capture again");
        if(new[]{1,2,4,16,17,18,91,92}.Any(key=>(GetAsyncKeyState(key)&0x8000)!=0))throw new InvalidOperationException("USER_INPUT_HELD: release mouse/modifier keys first");
        var point=Point(r,"point",bounds);string kind=r.GetProperty("action").GetString()??"";
        if(kind is not ("click" or "drag" or "scroll"))throw new ArgumentException("UNKNOWN_DESKTOP_ACTION");
        var end=kind=="drag"?Point(r,"to",bounds):point;
        string button=r.TryGetProperty("button",out var bt)?bt.GetString()??"left":"left";
        (uint down,uint up)=button switch{"left"=>(2u,4u),"right"=>(8u,16u),"middle"=>(32u,64u),_=>throw new ArgumentException("INVALID_BUTTON")};
        int count=r.TryGetProperty("clickCount",out var cc)?cc.GetInt32():1;
        int delta=r.TryGetProperty("delta",out var d)?d.GetInt32():0;
        if(count<1||count>2||Math.Abs((long)delta)>1200)throw new ArgumentException("INPUT_LIMIT");
        Move(point.X,point.Y,bounds);bool pressed=false;
        try {
            if(kind=="scroll")InputEvent(0x800,data:unchecked((uint)delta));
            else if(kind=="click")for(int i=0;i<count;i++){pressed=true;InputEvent(down);Thread.Sleep(30);InputEvent(up);pressed=false;if(i+1<count)Thread.Sleep(70);}
            else {pressed=true;InputEvent(down);for(int i=1;i<=20;i++){
                if((GetAsyncKeyState(27)&0x8000)!=0)throw new InvalidOperationException("ESCAPE_CANCELLED: input may already have occurred");
                Interactive();Move(point.X+(end.X-point.X)*i/20,point.Y+(end.Y-point.Y)*i/20,bounds);Thread.Sleep(20);
            }InputEvent(up);pressed=false;}
        }finally{if(pressed)try{InputEvent(up);}catch{}}
        return new{dispatched=true,verified=false,action=kind,next="Capture fresh desktop state and check the intended outcome. Do not replay uncertain input."};
    }
}
