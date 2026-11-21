[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try{$img=[System.Windows.Forms.Clipboard]::GetImage()}catch{$img=$null}
if(-not $img){[Console]::Error.WriteLine('NO_CLIPBOARD_IMAGE');exit 2}
try{
  $ms=New-Object System.IO.MemoryStream
  $img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
  $bytes=$ms.ToArray()
  $meta=@{format='png';width=$img.Width;height=$img.Height;bytes=$bytes.Length}|ConvertTo-Json -Compress
  [Console]::Out.WriteLine($meta)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
}finally{$img.Dispose()}

