# 下載本機語音辨識模型（SenseVoice，約 160 MB），放到專案的 stt_model\。已經有了就跳過。
# 用 2024-07-17 版：2025-09-09 版是粵語特化（WSYue），日文會辨識錯。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
$dir = Join-Path $root 'stt_model'
if (Test-Path -LiteralPath (Join-Path $dir "$name\model.int8.onnx")) { Write-Host '語音辨識模型已經在了。'; exit 0 }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$archive = Join-Path $dir 'sv.tar.bz2'
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$name.tar.bz2"
Write-Host '下載語音辨識模型（約 160 MB）……'
& curl.exe -L --fail --retry 3 -o $archive $url
if ($LASTEXITCODE -ne 0) { Write-Host '下載失敗，請確認網路後再試。' -ForegroundColor Red; exit 1 }
Push-Location $dir
try { & tar.exe -xjf sv.tar.bz2 } finally { Pop-Location }
Remove-Item -LiteralPath $archive -Force
if (-not (Test-Path -LiteralPath (Join-Path $dir "$name\model.int8.onnx"))) { Write-Host '解壓縮失敗。' -ForegroundColor Red; exit 1 }
Write-Host '語音辨識模型安裝完成：中文、日文會自動判斷。' -ForegroundColor Green
