@echo off
title PC Remote
cd /d "%~dp0"

rem This copy ships with its own Node.js inside the "runtime" folder, so
rem nothing has to be installed. Falls back to a system Node.js if missing.
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo This copy expects runtime\node.exe. If that file is missing, install
  echo Node.js from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install --no-fund --no-audit
)

rem Already running? Port 8443 in use means a previous window is still open.
netstat -ano | findstr /c:":8443 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo PC Remote is already running - port 8443 is in use.
  echo Opening https://localhost:8443 ...
  start "" "https://localhost:8443"
  echo.
  echo If the page does not load, close the other PC Remote window and run this file again.
  pause
  exit /b 0
)

echo.
echo Starting PC Remote... keep this window open while using the app.
echo.
"%NODE%" server.js
echo.
echo PC Remote stopped.
pause
