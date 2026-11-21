using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

internal static class Program {
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    [STAThread] static int Main() {
        try {
            using var doc = JsonDocument.Parse(Console.In.ReadToEnd());
            var r=doc.RootElement;
            object result = r.GetProperty("method").GetString() switch {
                "capabilities" => new {platform="windows", languages=OcrEngine.AvailableRecognizerLanguages.Select(l=>l.LanguageTag).ToArray(), maxImageDimension=OcrEngine.MaxImageDimension},
                "apps" => Catalog(),
                "launch" => Launch(r.GetProperty("id").GetString() ?? ""),
                "ocr" => Recognize(r).GetAwaiter().GetResult(),
                _ => throw new ArgumentException("UNKNOWN_METHOD")
            };
            Console.WriteLine(JsonSerializer.Serialize(new {ok=true,result}, Json));return 0;
        } catch(Exception e) {
            Console.WriteLine(JsonSerializer.Serialize(new {ok=false,error=e.Message}, Json));return 1;
        }
    }
    record App(string Id,string Name);
    [ComImport,Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)]string appId,[MarshalAs(UnmanagedType.LPWStr)]string? arguments,uint options,out uint processId);
    }
    static App[] Catalog() {
        dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application")!)!;
        object? folder=null,items=null;
        var result=new List<App>();
        try {
            folder=shell.NameSpace("shell:AppsFolder");
            if(folder is null)throw new InvalidOperationException("APP_CATALOG_UNAVAILABLE");
            items=((dynamic)folder).Items();
            int count=((dynamic)items).Count;
            for(int i=0;i<Math.Min(count,10000);i++) {
                object item=((dynamic)items).Item(i);
                try {var id=(string)((dynamic)item).Path;var name=(string)((dynamic)item).Name;
                    if(!string.IsNullOrWhiteSpace(id))result.Add(new(id,name));}
                finally {Marshal.FinalReleaseComObject(item);}
            }
        } finally {if(items!=null)Marshal.FinalReleaseComObject(items);if(folder!=null)Marshal.FinalReleaseComObject(folder);Marshal.FinalReleaseComObject(shell);}
        return result.DistinctBy(x=>x.Id).OrderBy(x=>x.Name).ToArray();
    }
    static object Launch(string id) {
        var app=Catalog().SingleOrDefault(a=>a.Id==id) ?? throw new ArgumentException("APP_NOT_IN_CATALOG");
        // Packaged apps return the OS activation result and PID, rather than an Explorer dispatch receipt.
        uint? processId=null;
        if(Path.IsPathFullyQualified(app.Id) && Path.GetExtension(app.Id).Equals(".exe",StringComparison.OrdinalIgnoreCase) && File.Exists(app.Id)) {
            // GUI ShellExecute avoids handing our JSON protocol pipes to the launched application.
            // No command shell, arguments or elevation verb is used.
            using var process=Process.Start(new ProcessStartInfo(app.Id){UseShellExecute=true,Verb="open"}) ?? throw new InvalidOperationException("LAUNCH_FAILED");
            processId=(uint)process.Id;
        } else if(app.Id.Contains('!')) {
            object manager=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"))!)!;
            try {int hr=((IActivationManager)manager).ActivateApplication(app.Id,null,0,out uint pid);
                if(hr<0)Marshal.ThrowExceptionForHR(hr);processId=pid;}
            finally{Marshal.FinalReleaseComObject(manager);}
        } else {
            dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application")!)!;
            object? folder=null,item=null;
            try {folder=shell.NameSpace("shell:AppsFolder");item=((dynamic)folder!).ParseName(app.Id);
                if(item==null)throw new InvalidOperationException("APP_DISAPPEARED");((dynamic)item).InvokeVerb("open");}
            finally{if(item!=null)Marshal.FinalReleaseComObject(item);if(folder!=null)Marshal.FinalReleaseComObject(folder);Marshal.FinalReleaseComObject(shell);}
        }
        return new {dispatched=true,verified=false,processId,app,next="Observe the application's windows before sending input. Launch is never automatically retried."};
    }
    static async Task<object> Recognize(JsonElement r) {
        string path=r.GetProperty("path").GetString() ?? throw new ArgumentException("IMAGE_REQUIRED");
        var file=new FileInfo(path);
        if(!file.Exists||file.Length>32*1024*1024)throw new ArgumentException("IMAGE_TOO_LARGE_OR_MISSING");
        var data=await File.ReadAllBytesAsync(path);
        using var stream=new InMemoryRandomAccessStream();
        using(var writer=new DataWriter(stream)){writer.WriteBytes(data);await writer.StoreAsync();writer.DetachStream();}
        stream.Seek(0);
        var decoder=await BitmapDecoder.CreateAsync(stream);
        if(decoder.PixelWidth>OcrEngine.MaxImageDimension||decoder.PixelHeight>OcrEngine.MaxImageDimension||
           (long)decoder.PixelWidth*decoder.PixelHeight>25_000_000)throw new ArgumentException("IMAGE_DIMENSIONS_EXCEEDED");
        var engine=r.TryGetProperty("language",out var lang)&&lang.GetString() is string tag&&tag.Length>0
            ? OcrEngine.TryCreateFromLanguage(new Language(tag)) : OcrEngine.TryCreateFromUserProfileLanguages();
        if(engine==null)throw new ArgumentException("OCR_LANGUAGE_UNAVAILABLE: install the requested Windows language pack or select an available language.");
        using var bitmap=await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8,BitmapAlphaMode.Premultiplied);
        var result=await engine.RecognizeAsync(bitmap);
        return new {text=result.Text,language=engine.RecognizerLanguage.LanguageTag,width=decoder.PixelWidth,height=decoder.PixelHeight,
            coordinateSpace="image-pixels-top-left",textAngle=result.TextAngle,
            lines=result.Lines.Select(line=>new {text=line.Text,words=line.Words.Select(word=>new {
                text=word.Text,x=word.BoundingRect.X,y=word.BoundingRect.Y,width=word.BoundingRect.Width,height=word.BoundingRect.Height,confidence=(double?)null}).ToArray()}).ToArray()};
    }
}
