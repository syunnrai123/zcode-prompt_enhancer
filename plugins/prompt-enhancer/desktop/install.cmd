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
echo The installer waits until every ZCode.exe process exits.
echo It will not force-close or restart ZCode. Keep this window open.
echo.
node "%~dp0patch-desktop.mjs" install --wait-for-exit %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [FAILED] See the message above.
) else (
  echo [OK] Restart ZCode. A star button appears in the composer toolbar.
  echo Generation uses the current session model - no API key needed.
)
echo.
pause
exit /b %RC%
