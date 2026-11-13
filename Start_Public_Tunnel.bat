@echo off
rem RGC School Document Portal - Public internet access via Cloudflare quick tunnel.
rem Starts a free cloudflared tunnel to http://localhost:3000 and feeds the live
rem https://<name>.trycloudflare.com URL into the portal (C:\RJC\public-url), so the
rem single QR on the Front Panel works for phones on ANY internet (4G/5G or Wi-Fi).
rem No account, token or configuration is needed. Admin -^> Branding can override the URL.
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================================
echo   RGC School Document Portal - Public Internet Access
echo ============================================================
echo.
set "CLOUDFLARED="
if exist "%~dp0cloudflared.exe" set "CLOUDFLARED=%~dp0cloudflared.exe"
if not defined CLOUDFLARED (
  for /f "delims=" %%i in ('where cloudflared 2^>nul') do (
    if not defined CLOUDFLARED set "CLOUDFLARED=%%i"
  )
)
if not defined CLOUDFLARED (
  echo cloudflared.exe was not found.
  echo.
  echo Install it once with either:
  echo   - Download: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  echo   - winget:   winget install Cloudflare.cloudflared
  echo.
  echo Then copy cloudflared.exe into this folder ^(%~dp0^) and run this script again.
  pause
  exit /b 1
)
echo Using: %CLOUDFLARED%
echo.
if exist "%~dp0public-url" del /Q "%~dp0public-url"
if exist "%~dp0cloudflared-tunnel.log" del /Q "%~dp0cloudflared-tunnel.log"
start "RGC Cloudflare Tunnel" /min cmd /c """%CLOUDFLARED%" tunnel --url http://localhost:3000 > "%~dp0cloudflared-tunnel.log" 2>&1 & del /Q "%~dp0public-url" 2>nul"
echo Waiting for the Cloudflare tunnel URL (up to 60 seconds)...
set "FOUND="
for /l %%i in (1,1,30) do (
  powershell -NoProfile -Command "if (Test-Path '%~dp0cloudflared-tunnel.log') { $c = Get-Content -Raw '%~dp0cloudflared-tunnel.log'; if ($c -match 'https://[a-z0-9-]+\.trycloudflare\.com') { Set-Content -NoNewline '%~dp0public-url' $Matches[0]; Write-Output ('TUNNEL_URL=' + $Matches[0]); exit 0 } }; exit 1"
  if not errorlevel 1 (
    set "FOUND=1"
    goto :found
  )
  timeout /t 2 /nobreak >nul
)
:found
if not defined FOUND (
  echo.
  echo Could not detect the tunnel URL. Check the log at %~dp0cloudflared-tunnel.log
  pause
  exit /b 1
)
echo.
echo The single QR on the Front Panel now uses the public link.
echo Phones can scan it on ANY internet - no Wi-Fi or LAN connection is required.
echo The link is removed automatically when the tunnel window is closed.
echo Keep the tunnel window minimized while the school needs public access.
pause
exit /b 0
