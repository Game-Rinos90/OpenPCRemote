@echo off
title PC Remote - open firewall ports
net session >nul 2>nul
if errorlevel 1 (
  echo This needs to run as administrator.
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

set HTTP_PORT=8443
set DAV_PORT=8243

if exist "%~dp0data\config.json" (
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content '%~dp0data\config.json' | ConvertFrom-Json).port"`) do set HTTP_PORT=%%p
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content '%~dp0data\config.json' | ConvertFrom-Json).webdavPort"`) do set DAV_PORT=%%p
)

echo Allowing inbound TCP %HTTP_PORT% (app) and %DAV_PORT% (WebDAV)...
netsh advfirewall firewall delete rule name="PC Remote app" >nul 2>nul
netsh advfirewall firewall delete rule name="PC Remote WebDAV" >nul 2>nul
netsh advfirewall firewall add rule name="PC Remote app" dir=in action=allow protocol=TCP localport=%HTTP_PORT% profile=private,domain,public
netsh advfirewall firewall add rule name="PC Remote WebDAV" dir=in action=allow protocol=TCP localport=%DAV_PORT% profile=private,domain,public

echo.
echo Done. Restrict these rules to the Private profile if you only use your home network.
pause
