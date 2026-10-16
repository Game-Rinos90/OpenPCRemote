@echo off
title PC Remote - trust this PC's certificate
net session >nul 2>nul
if errorlevel 1 (
  echo This needs to run as administrator (certificates in the machine store).
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

if not exist "%~dp0data\cert\cert.pem" (
  echo No certificate yet. Start PC Remote once (start.bat), then run this again.
  pause
  exit /b 1
)

echo Adding PC Remote's certificate to the Windows trusted root store...
certutil -addstore -f Root "%~dp0data\cert\cert.pem"

echo.
echo Done. Windows Explorer can now map the WebDAV address without warnings.
echo (On your phone, tap "Advanced - Proceed" once in the browser instead.)
pause
