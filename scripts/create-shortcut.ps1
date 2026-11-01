# 在桌面建立「むぎ 日語家教」捷徑，指向專案資料夾裡的 start-mugi.bat。
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')   # 桌面被 OneDrive 搬走也找得到
$lnk = Join-Path $desktop 'むぎ 日語家教.lnk'
$sh = New-Object -ComObject WScript.Shell
# WScript.Shell uses the ANSI code page and cannot save kana in a file name: save under an ASCII name, then rename
$tmp = Join-Path $desktop 'mugi-tmp.lnk'
$s = $sh.CreateShortcut($tmp)
$s.TargetPath = Join-Path $root 'start-mugi.bat'
$s.WorkingDirectory = $root
$s.IconLocation = (Join-Path $PSScriptRoot 'mugi.ico') + ',0'
$s.WindowStyle = 7        # 啟動時黑視窗縮到最小
$s.Description = 'むぎ 日語家教（用預設瀏覽器開啟）'
$s.Save()
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
Move-Item -LiteralPath $tmp -Destination $lnk -Force
Write-Host "已建立：$lnk"
