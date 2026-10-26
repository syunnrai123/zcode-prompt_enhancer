@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZCode Prompt Enhancer - Install
echo ============================================
echo  ZCode Prompt Enhancer - Install composer button
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js 18+ first.
  echo.
  pause
  exit /b 1
)
echo IMPORTANT: Fully quit ZCode first, including the tray icon.
echo This script refuses to write app.asar while ZCode.exe is running.
echo.
pause
node "%~dp0patch-desktop.mjs" install %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [FAILED] See the message above.
) else (
  echo [OK] Restart ZCode. A star button appears in the composer toolbar.
  echo Config: %USERPROFILE%\.zcode\zcode-prompt-enhancer\config.json
)
echo.
pause
exit /b %RC%
