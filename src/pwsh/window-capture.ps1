param([string]$TitleContains='',[string]$ProcessName='',[string]$OutFile='',[int]$BringToFront=1)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CpWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$root=[System.Windows.Automation.AutomationElement]::RootElement
$children=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
$cands=@()
foreach($w in $children){
  try{
    $rect=$w.Current.BoundingRectangle
    if($rect.Width -lt 80 -or $rect.Height -lt 80){continue}
    $title=$w.Current.Name
    $handle=[IntPtr]$w.Current.NativeWindowHandle
    if($handle -eq [IntPtr]::Zero){continue}
    $proc=(Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue)
    $pname=if($proc){$proc.ProcessName}else{''}
    $cands+=[pscustomobject]@{handle=$handle;title=$title;process=$pname;pid=$w.Current.ProcessId;rect=$rect}
  }catch{}
}
if($ProcessName){$cands=@($cands|Where-Object{$_.process -like "*$ProcessName*"})}
if($TitleContains){$cands=@($cands|Where-Object{$_.title -like "*$TitleContains*"})}
$cands=@($cands|Sort-Object -Property @{Expression={ if($TitleContains -and $_.title -eq $TitleContains){0} elseif($TitleContains -and $_.title -like "*$TitleContains*"){1} else {2} };Descending=$false},@{Expression={$_.rect.Width*$_.rect.Height};Descending=$true})
if($cands.Count -eq 0){'{"found":false}'|Write-Output;exit 0}
$target=$cands[0]
if($BringToFront -eq 1){
  if([CpWin]::IsIconic($target.handle)){[void][CpWin]::ShowWindow($target.handle,9)}
  [void][CpWin]::SetForegroundWindow($target.handle)
  Start-Sleep -Milliseconds 400
}
$r=New-Object CpWin+RECT
[void][CpWin]::GetWindowRect($target.handle,[ref]$r)
$w=$r.Right-$r.Left
$hgt=$r.Bottom-$r.Top
if($w -le 0 -or $hgt -le 0){'{"found":true,"error":"EMPTY_BOUNDS"}'|Write-Output;exit 0}
$bmp=New-Object System.Drawing.Bitmap($w,$hgt)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$hgt)))
$g.Dispose()
$bmp.Save($OutFile,[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$result=@{found=$true;pid=$target.pid;process=$target.process;title=$target.title;bounds=@{x=$r.Left;y=$r.Top;width=$w;height=$hgt};candidates=$cands.Count;foreground=($BringToFront -eq 1);saved=$OutFile;otherTitles=@($cands|Select-Object -Skip 1 -First 4|ForEach-Object{$_.title})}
$result|ConvertTo-Json -Compress

