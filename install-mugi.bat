@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Mugi installer
echo ===== むぎ 日語家教：安裝 =====
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，正在用 winget 安裝（長期支援版）……
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo Node.js 安裝完了。請「關掉這個視窗」，再對 install-mugi.bat 按兩下一次，繼續後面的步驟。
  pause
  exit /b 0
)

echo 安裝套件（需要網路，約一兩分鐘）……
call npm install
if errorlevel 1 (
  echo [錯誤] 套件安裝失敗，請確認網路後再試一次。
  pause
  exit /b 1
)

if not exist .env.local copy .env.example .env.local >nul

echo 建立桌面捷徑……
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1"
if errorlevel 1 (
  echo [錯誤] 桌面捷徑建立失敗。
  pause
  exit /b 1
)

echo.
echo 安裝完成！桌面上多了「むぎ 日語家教」和「むぎ 設定金鑰」兩個捷徑。
echo 金鑰請用桌面的「むぎ 設定金鑰」加密保存（Claude 或 DeepSeek），或在 App 的設定裡用 ChatGPT 登入。
echo.
choice /m "現在就開啟嗎"
if not errorlevel 2 call "%~dp0start-mugi.bat"
exit /b 0
