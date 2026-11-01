# 在桌面建立兩個捷徑：「むぎ 日語家教」（start-mugi.bat）與「むぎ 設定金鑰」（set-keys.bat）。
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')   # 桌面被 OneDrive 搬走也找得到

# 圖示：沒有 mugi.ico 時，用 public\icon-192.png 包成 .ico（ICO 容器裡直接放 PNG，Windows Vista 以上都支援）
$ico = Join-Path $PSScriptRoot 'mugi.ico'
if (-not (Test-Path $ico)) {
  $png = [IO.File]::ReadAllBytes((Join-Path $root 'public\icon-192.png'))
  $ms = New-Object IO.MemoryStream
  $bw = New-Object IO.BinaryWriter($ms)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)          # ICONDIR
  $bw.Write([byte]192); $bw.Write([byte]192); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$png.Length); $bw.Write([uint32]22)                       # size, offset
  $bw.Write($png)
  $bw.Flush()
  [IO.File]::WriteAllBytes($ico, $ms.ToArray())
}

function New-MugiShortcut([string]$name, [string]$target, [int]$style, [string]$description) {
  $lnk = Join-Path $desktop ($name + '.lnk')
  $sh = New-Object -ComObject WScript.Shell
  # WScript.Shell uses the ANSI code page and cannot save kana in a file name: save under an ASCII name, then rename
  $tmp = Join-Path $desktop 'mugi-tmp.lnk'
  $s = $sh.CreateShortcut($tmp)
  $s.TargetPath = Join-Path $root $target
  $s.WorkingDirectory = $root
  $s.IconLocation = "$ico,0"
  $s.WindowStyle = $style
  $s.Description = $description
  $s.Save()
  if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
  Move-Item -LiteralPath $tmp -Destination $lnk -Force
  Write-Host "已建立：$lnk"
}

New-MugiShortcut 'むぎ 日語家教' 'start-mugi.bat' 7 'むぎ 日語家教（用預設瀏覽器開啟）'   # 7 = 黑視窗縮到最小
New-MugiShortcut 'むぎ 設定金鑰' 'set-keys.bat' 1 'むぎ 日語家教：加密設定 Claude／DeepSeek 金鑰'
