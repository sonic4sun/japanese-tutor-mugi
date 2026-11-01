# 關閉 Mugi 伺服器：只關「命令列裡含有本專案資料夾」的 node（不會動到電腦上其他的 node 程式）。
$root = Split-Path -Parent $PSScriptRoot
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains("$root\node_modules") }
if (-not $procs) { Write-Host 'Mugi 伺服器本來就沒有開著。'; exit 0 }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Mugi 伺服器已關閉。'
