@echo off
chcp 65001 >nul
setlocal
title Locked Grid Lottery
cd /d "%~dp0"

rem ────────────────────────────────────────────────────────────────
rem  LOCKED GRID LOTTERY - one-click launcher for Windows
rem  Just double-click this file. It:
rem    1. finds the game folder (works even if you moved it)
rem    2. installs dependencies on first run
rem    3. starts the game and opens the admin panel
rem ────────────────────────────────────────────────────────────────

rem If server.js is not next to this .bat, look one folder down
if exist "server.js" goto :run
if exist "locked-grid-lottery\server.js" (
  cd /d "%~dp0locked-grid-lottery"
  goto :run
)

echo [X] server.js not found.
echo     Make sure you extracted the ZIP and this .bat sits inside
echo     the extracted "locked-grid-lottery" folder.
echo.
pause
exit /b 1

:run
echo ==================================================
echo    LOCKED GRID LOTTERY  -  starting...
echo ==================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Node.js was not found on this PC.
  echo     Install the LTS version from https://nodejs.org
  echo     ^(Next-Next-Finish is fine^), then double-click this file again.
  echo.
  pause
  exit /b 1
)

node -v

if not exist "node_modules" (
  echo.
  echo [1/2] First run: installing dependencies ^(about 1 minute^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [X] npm install failed.
    echo     - Check your internet connection, then double-click again.
    echo     - If a proxy/firewall blocks npm, see README.md "Troubleshooting".
    echo.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [i] Created .env from .env.example - edit it later to go LIVE on TikTok.
  )
)

echo [2/2] Starting the game server...
echo.
echo     Admin panel:  http://localhost:3000/admin.html
echo     OBS overlay:  http://localhost:3000/   ^(1080x1920 browser source^)
echo.
echo     KEEP THIS WINDOW OPEN while you stream. Close it or press
echo     Ctrl+C to stop the game.
echo.

rem open the admin panel in the default browser once the server is up
start /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:3000/admin.html"

node server.js

echo.
echo Server stopped.
pause
