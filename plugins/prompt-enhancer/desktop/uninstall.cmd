@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZCode Prompt Enhancer - Uninstall
echo ============================================
echo  ZCode Prompt Enhancer - Restore official state
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo.
  pause
  exit /b 1
)
echo IMPORTANT: Fully quit ZCode first, including the tray icon.
echo.
pause
node "%~dp0patch-desktop.mjs" remove --purge %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [FAILED] See the message above.
) else (
  echo [OK] app.asar restored to official contents; runtime directory removed.
  echo      To remove the plugin itself: ZCode - Settings - Plugins - Uninstall.
)
echo.
pause
exit /b %RC%
