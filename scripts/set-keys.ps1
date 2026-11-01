# むぎ 設定金鑰：把 Claude／DeepSeek 的金鑰用 Windows 加密（DPAPI，只有你這個 Windows 帳號解得開），
# 存到專案資料夾外面（%USERPROFILE%\.mugi-tutor\keys.json）。輸入時畫面只會顯示 ****，金鑰不會出現在任何記錄裡。
# 伺服器每次用到時自己讀，存完不用重開。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$root = Split-Path -Parent $PSScriptRoot
$dir = if ($env:MUGI_DATA_DIR) { $env:MUGI_DATA_DIR } else { Join-Path $env:USERPROFILE '.mugi-tutor' }
$file = Join-Path $dir 'keys.json'
$envFile = Join-Path $root '.env.local'
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$utf8 = New-Object Text.UTF8Encoding($false)
$names = [ordered]@{ deepseek = 'DeepSeek'; anthropic = 'Claude' }

if (-not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
  # 資料夾只開給目前的 Windows 使用者
  $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
  & icacls.exe $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
}

$keys = @{}
if (Test-Path -LiteralPath $file) {
  $j = [IO.File]::ReadAllText($file, $utf8).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ($j.keys) { foreach ($p in $j.keys.PSObject.Properties) { $keys[$p.Name] = [string]$p.Value } }
}

function Save-Vault {
  $obj = [ordered]@{ v = 1; keys = $keys }
  [IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Depth 3), $utf8)
}
function Protect-Key([string]$plain) {
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, $scope))
}
function Get-Status([string]$name) {
  if (-not $keys.ContainsKey($name) -or -not $keys[$name]) { return '未設定' }
  try {
    $plain = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($keys[$name]), $null, $scope))
    return '已設定（末四碼 ' + $plain.Substring([Math]::Max(0, $plain.Length - 4)) + '）'
  } catch { return '解不開（請重新設定）' }
}
function Read-Secret([string]$prompt) {
  $s = Read-Host $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# .env.local 裡如果有明文的 Claude 金鑰：問要不要搬進加密庫，並清掉明文
if (Test-Path -LiteralPath $envFile) {
  $lines = [IO.File]::ReadAllLines($envFile, $utf8)
  $idx = -1
  for ($i = 0; $i -lt $lines.Length; $i++) { if ($lines[$i] -match '^\s*ANTHROPIC_API_KEY\s*=\s*(\S+)\s*$') { $idx = $i; $found = $Matches[1] } }
  if ($idx -ge 0) {
    Write-Host ''
    Write-Host '發現 .env.local 裡有一把「明文」的 Claude 金鑰。'
    $ans = Read-Host '要把它搬進加密庫，並把 .env.local 裡的明文清掉嗎？(Y/N)'
    if ($ans -match '^[Yy]') {
      $keys['anthropic'] = Protect-Key $found
      Save-Vault
      $lines[$idx] = 'ANTHROPIC_API_KEY='
      [IO.File]::WriteAllLines($envFile, $lines, $utf8)
      Write-Host '已搬進加密庫，.env.local 裡的明文已清掉。' -ForegroundColor Green
    }
    $found = $null
  }
}

while ($true) {
  Write-Host ''
  Write-Host '===== むぎ 設定金鑰（加密保存在你的電腦，只有你的 Windows 帳號解得開）====='
  foreach ($n in $names.Keys) { Write-Host ('  ' + $names[$n] + '：' + (Get-Status $n)) }
  Write-Host ''
  Write-Host '  1) 設定 DeepSeek 金鑰'
  Write-Host '  2) 設定 Claude 金鑰'
  Write-Host '  3) 刪除 DeepSeek 金鑰'
  Write-Host '  4) 刪除 Claude 金鑰'
  Write-Host '  0) 結束'
  $c = Read-Host '請輸入數字'
  switch ($c) {
    { $_ -in '1', '2' } {
      $name = if ($c -eq '1') { 'deepseek' } else { 'anthropic' }
      $k = Read-Secret ('貼上 ' + $names[$name] + ' 金鑰（畫面會顯示 ****），按 Enter')
      if ($k -notmatch '^[A-Za-z0-9._-]{8,300}$') { Write-Host '這看起來不像金鑰（只能有英文、數字和 . _ -），沒有儲存。' -ForegroundColor Yellow; break }
      $keys[$name] = Protect-Key $k
      $k = $null
      Save-Vault
      Write-Host ($names[$name] + ' 金鑰已加密儲存，不用重開 App 就會生效。') -ForegroundColor Green
    }
    { $_ -in '3', '4' } {
      $name = if ($c -eq '3') { 'deepseek' } else { 'anthropic' }
      $keys.Remove($name)
      Save-Vault
      Write-Host ($names[$name] + ' 金鑰已刪除。') -ForegroundColor Green
    }
    '0' { exit 0 }
    default { Write-Host '請輸入 0 到 4。' }
  }
}
