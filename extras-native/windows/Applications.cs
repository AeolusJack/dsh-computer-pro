using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

internal static class Applications {
    internal record App(string Id,string Name,string Source);
    internal static App[] Catalog() {
        var result=new Dictionary<string,App>(StringComparer.OrdinalIgnoreCase);
        void Add(string? path,string? name,string source) {
            if(string.IsNullOrWhiteSpace(path))return;
            result.TryAdd(path,new(path,string.IsNullOrWhiteSpace(name)?Path.GetFileNameWithoutExtension(path):name,source));
        }
        // App Paths includes per-user WPS and software absent from AppsFolder.
        foreach(var hive in new[]{RegistryHive.CurrentUser,RegistryHive.LocalMachine})
        foreach(var view in new[]{RegistryView.Registry64,RegistryView.Registry32}) {
            using var root=RegistryKey.OpenBaseKey(hive,view);
            using var paths=root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths");
            if(paths==null)continue;
            foreach(var key in paths.GetSubKeyNames().Take(5000)) try {
                using var item=paths.OpenSubKey(key);
                var path=Environment.ExpandEnvironmentVariables((item?.GetValue("") as string??"").Trim().Trim('"'));
                if(Path.IsPathFullyQualified(path)&&File.Exists(path)&&Path.GetExtension(path).Equals(".exe",StringComparison.OrdinalIgnoreCase)) {
                    var candidate=Path.Combine(Path.GetDirectoryName(path)!,key);
                    if(Path.GetFileName(key)==key&&Path.GetExtension(key).Equals(".exe",StringComparison.OrdinalIgnoreCase)&&File.Exists(candidate))path=candidate;
                    var info=FileVersionInfo.GetVersionInfo(path);
                    Add(Path.GetFullPath(path),$"{(string.IsNullOrWhiteSpace(info.FileDescription)?Path.GetFileNameWithoutExtension(path):info.FileDescription)} ({Path.GetFileName(path)})","app-paths");
                }
            } catch(Exception e) when(e is System.Security.SecurityException or UnauthorizedAccessException or IOException) {}
        }
        foreach(var folder in new[]{Environment.SpecialFolder.StartMenu,Environment.SpecialFolder.CommonStartMenu}) {
            var path=Environment.GetFolderPath(folder);if(!Directory.Exists(path))continue;
            try {foreach(var file in Directory.EnumerateFiles(path,"*.lnk",new EnumerationOptions{RecurseSubdirectories=true,IgnoreInaccessible=true,AttributesToSkip=FileAttributes.ReparsePoint}).Take(5000))Add(file,Path.GetFileNameWithoutExtension(file),"start-menu");}catch(IOException){}
        }
        // A failed COM catalogue must not discard independently discovered applications.
        object? shell=null,apps=null,items=null;
        try {
            shell=Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application")!);
            apps=((dynamic)shell!).NameSpace("shell:AppsFolder");
            if(apps!=null) {
                items=((dynamic)apps).Items();int count=((dynamic)items).Count;
                for(int i=0;i<Math.Min(count,10000);i++) {
                    object? item=null;
                    try {item=((dynamic)items).Item(i);Add((string)((dynamic)item).Path,(string)((dynamic)item).Name,"apps-folder");}
                    catch(COMException){}finally{Release(item);}
                }
            }
        } catch(COMException){} finally{Release(items);Release(apps);Release(shell);}
        foreach(var process in Process.GetProcesses())using(process)try {
            if(process.MainWindowHandle==IntPtr.Zero)continue;
            string? path=process.MainModule?.FileName;if(path!=null)Add(path,$"{process.ProcessName} (running)","running");
        }catch(Exception e)when(e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException){}
        return result.Values.OrderBy(a=>a.Name).ToArray();
    }
    internal static object Launch(string id) {
        var app=Catalog().SingleOrDefault(a=>a.Id.Equals(id,StringComparison.OrdinalIgnoreCase))??throw new ArgumentException("APP_NOT_IN_CATALOG");
        ProcessStartInfo start;
        bool direct=Path.IsPathFullyQualified(app.Id)&&File.Exists(app.Id);
        if(direct)start=new(app.Id){UseShellExecute=true,Verb="open"};
        else {
            // Ask the interactive Explorer to resolve the catalogued ID. No in-worker
            // activation-manager COM call, shell command text, or elevation verb.
            start=new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe")){UseShellExecute=true,Verb="open"};
            start.ArgumentList.Add("shell:AppsFolder\\"+app.Id);
        }
        using var process=Process.Start(start);
        return new {dispatched=true,verified=false,processId=direct?process?.Id:null,app,
            next="Resolve the current cua app ID and observe its windows. Launch dispatch does not prove startup succeeded."};
    }
    internal static void Release(object? value) {if(value!=null&&Marshal.IsComObject(value))Marshal.FinalReleaseComObject(value);}
}
