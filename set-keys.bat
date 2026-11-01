@echo off
chcp 65001 >nul
title Mugi keys
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-keys.ps1"
pause
