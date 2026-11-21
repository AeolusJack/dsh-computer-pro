using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using global::Windows.Globalization;
using global::Windows.Graphics.Imaging;
using global::Windows.Media.Ocr;
using global::Windows.Storage.Streams;

internal static class Program {
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    [STAThread] static int Main(string[] args) {
        Console.InputEncoding=new System.Text.UTF8Encoding(false,true);
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        if(args.SequenceEqual(new[]{"--server"})) {
            string? line;
            while((line=Console.ReadLine())!=null) {
                string? id=null;
                try {
                    if(line.Length>4*1024*1024)throw new ArgumentException("REQUEST_TOO_LARGE");
                    using var envelope=JsonDocument.Parse(line);
                    var root=envelope.RootElement;id=root.GetProperty("id").GetString();
                    if(root.GetProperty("protocol").GetInt32()!=1||string.IsNullOrEmpty(id))throw new ArgumentException("PROTOCOL_VERSION");
                    var result=Dispatch(root.GetProperty("request"));
                    Console.WriteLine(JsonSerializer.Serialize(new{protocol=1,id,ok=true,result},Json));
                }catch(Exception e){Console.WriteLine(JsonSerializer.Serialize(new{protocol=1,id,ok=false,error=e.Message},Json));}
            }
            return 0;
        }
        try {
            Console.InputEncoding=new System.Text.UTF8Encoding(false,true);
            Console.OutputEncoding=new System.Text.UTF8Encoding(false);
            using var doc = JsonDocument.Parse(Console.In.ReadToEnd());
            var r=doc.RootElement;
            var result=Dispatch(r);
            Console.WriteLine(JsonSerializer.Serialize(new {ok=true,result}, Json));return 0;
        } catch(Exception e) {
            Console.WriteLine(JsonSerializer.Serialize(new {ok=false,error=e.Message}, Json));return 1;
        }
    }
    static object Dispatch(JsonElement r) => r.GetProperty("method").GetString() switch {
                "capabilities" => new {protocol=1,platform="windows",version="0.4.0",methods=new[]{"capabilities","apps","launch","ocr","office_read","office_edit_copy","desktop_capture","desktop_action","windows","window_capture","clipboard_image","input_status"},languages=OcrEngine.AvailableRecognizerLanguages.Select(l=>l.LanguageTag).ToArray(), maxImageDimension=OcrEngine.MaxImageDimension},
                "apps" => Applications.Catalog(),
                "launch" => Applications.Launch(r.GetProperty("id").GetString() ?? ""),
                "office_read" => Office.Read(r),
                "office_edit_copy" => Office.EditCopy(r),
                "desktop_capture" => Desktop.Capture(),
                "desktop_action" => Desktop.Act(r),
                "windows" => NativeWindows.Catalog(),
                "input_status" => InputWatch.Status(),
                "window_capture" => NativeWindows.Capture(r),
                "clipboard_image" => NativeWindows.ClipboardImage(),
                "ocr" => Recognize(r).GetAwaiter().GetResult(),
                _ => throw new ArgumentException("UNKNOWN_METHOD")
            };
    static async Task<object> Recognize(JsonElement r) {
        string path=r.GetProperty("path").GetString() ?? throw new ArgumentException("IMAGE_REQUIRED");
        var file=new FileInfo(path);
        if(!file.Exists||file.Length>32*1024*1024)throw new ArgumentException("IMAGE_TOO_LARGE_OR_MISSING");
        var data=await File.ReadAllBytesAsync(path);
        int scale=r.TryGetProperty("scale",out var scaleValue)?scaleValue.GetInt32():1;
        if(scale<1||scale>3)throw new ArgumentException("OCR_SCALE_LIMIT: use 1, 2 or 3");
        int originX=0,originY=0,originalWidth,originalHeight;
        using(var sourceStream=new MemoryStream(data))using(var original=new System.Drawing.Bitmap(sourceStream)) {
            originalWidth=original.Width;originalHeight=original.Height;
            if((long)originalWidth*originalHeight>25000000)throw new ArgumentException("IMAGE_DIMENSIONS_EXCEEDED");
            int width=originalWidth,height=originalHeight;
            if(r.TryGetProperty("region",out var region)) {originX=region.GetProperty("x").GetInt32();originY=region.GetProperty("y").GetInt32();width=region.GetProperty("width").GetInt32();height=region.GetProperty("height").GetInt32();}
            if(originX<0||originY<0||width<1||height<1||(long)originX+width>originalWidth||(long)originY+height>originalHeight)throw new ArgumentException("INVALID_OCR_REGION");
            if((long)width*scale>OcrEngine.MaxImageDimension||(long)height*scale>OcrEngine.MaxImageDimension||(long)width*height*scale*scale>25000000)throw new ArgumentException("OCR_CROP_TOO_LARGE");
            if(scale!=1||originX!=0||originY!=0||width!=originalWidth||height!=originalHeight) {
                using var resized=new System.Drawing.Bitmap(width*scale,height*scale);
                using(var g=System.Drawing.Graphics.FromImage(resized)){g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(original,new System.Drawing.Rectangle(0,0,resized.Width,resized.Height),new System.Drawing.Rectangle(originX,originY,width,height),System.Drawing.GraphicsUnit.Pixel);}
                using var encoded=new MemoryStream();resized.Save(encoded,System.Drawing.Imaging.ImageFormat.Png);data=encoded.ToArray();
            }
        }
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
        return new {text=result.Text,language=engine.RecognizerLanguage.LanguageTag,width=originalWidth,height=originalHeight,scale,originX,originY,
            coordinateSpace="image-pixels-top-left",textAngle=result.TextAngle,
            lines=result.Lines.Select(line=>new {text=line.Text,words=line.Words.Select(word=>new {
                text=word.Text,x=originX+word.BoundingRect.X/scale,y=originY+word.BoundingRect.Y/scale,width=word.BoundingRect.Width/scale,height=word.BoundingRect.Height/scale,confidence=(double?)null}).ToArray()}).ToArray()};
    }
}
