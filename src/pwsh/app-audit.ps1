param([int]$MaxWindows=20,[int]$MaxElements=400)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$list=@()
$root=[System.Windows.Automation.AutomationElement]::RootElement
$children=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
$windows=@()
foreach($w in $children){
  try{
    $rect=$w.Current.BoundingRectangle
    if($rect.Width -lt 120 -or $rect.Height -lt 120){continue}
    $proc=(Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue)
    $windows+=[pscustomobject]@{element=$w;title=$w.Current.Name;pid=$w.Current.ProcessId;process=if($proc){$proc.ProcessName}else{''};rect=$rect}
  }catch{}
}
$windows=@($windows|Sort-Object -Property @{Expression={$_.rect.Width*$_.rect.Height};Descending=$true}|Select-Object -First $MaxWindows)
foreach($item in $windows){
  $entry=@{pid=$item.pid;process=$item.process;title=$item.title;total=0;named=0;identified=0;error=$null;roles=@{};bounds=@{x=[int]$item.rect.X;y=[int]$item.rect.Y;width=[int]$item.rect.Width;height=[int]$item.rect.Height}}
  try{
    $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack=New-Object System.Collections.Stack
    $stack.Push($item.element)
    while($stack.Count -gt 0 -and $entry.total -lt $MaxElements){
      $node=$stack.Pop()
      $entry.total=$entry.total+1
      try{
        if($node.Current.Name -and $node.Current.Name.Trim()){$entry.named=$entry.named+1}
        if($node.Current.AutomationId -and $node.Current.AutomationId.Trim()){$entry.identified=$entry.identified+1}
        $role=$node.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
        if($entry.roles.ContainsKey($role)){$entry.roles[$role]=$entry.roles[$role]+1}else{$entry.roles[$role]=1}
      }catch{}
      try{
        $child=$walker.GetFirstChild($node)
        while($child -ne $null){$stack.Push($child);$child=$walker.GetNextSibling($child)}
      }catch{}
    }
    $entry.truncated=($entry.total -ge $MaxElements)
  }catch{$entry.error=$_.Exception.Message}
  $list+=[pscustomobject]$entry
}
@($list)|ConvertTo-Json -Depth 4 -Compress

