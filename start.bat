@echo off
REM ANP Chat launcher (Windows: double-click me). Requires Node.js.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org からインストールしてください。
  pause
  exit /b 1
)
set ANP_OPEN=1
node server.mjs
pause
