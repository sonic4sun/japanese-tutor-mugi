@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Mugi launcher

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 這台電腦還沒安裝 Node.js。
  echo 請先對 install-mugi.bat 按兩下，它會幫你安裝。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次使用，正在安裝套件，請稍候……
  call npm install
  if errorlevel 1 (
    echo [錯誤] 套件安裝失敗，請確認網路後再試一次。
    pause
    exit /b 1
  )
)

if not exist .env.local copy .env.example .env.local >nul

rem 伺服器已經開著就不重開，直接開網頁
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-port.ps1" -Seconds 1
if not errorlevel 1 goto open

rem VOICEVOX 用顯示卡（DirectML 版）加速
set VOICEVOX_USE_GPU=1
start "Mugi Server - close this window to stop" /min cmd /c npm run dev
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-port.ps1" -Seconds 90
if errorlevel 1 (
  echo [錯誤] 伺服器沒有在 90 秒內啟動。請看工作列上最小化的 Mugi Server 視窗裡的訊息。
  pause
  exit /b 1
)

:open
rem 用系統預設瀏覽器開（你的預設是 Comet）
start "" "http://localhost:3004"
exit /b 0
