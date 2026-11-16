@echo off
setlocal EnableDelayedExpansion
title RJC School - Permanent Cloudflare Named Tunnel Setup
color 0B

echo ===============================================================================
echo        RJC SCHOOL -- PERMANENT CLOUDFLARE NAMED TUNNEL SETUP WIZARD
echo ===============================================================================
echo  Target Architecture:
echo    https://rjcschool.in        ^--> Parent / Student Document Portal
echo    https://verify.rjcschool.in ^--> Public Certificate Verification Portal
echo    Windows 11 School PC        ^--> localhost:3000 (Node.js + SQLite WAL)
echo ===============================================================================
echo.

set "ROOT=%~dp0..\"
cd /d "%ROOT%"

:: 1. Locate cloudflared binary
set "CLOUDFLARED="
if exist "%ROOT%tools\cloudflared.exe" set "CLOUDFLARED=%ROOT%tools\cloudflared.exe"
if not defined CLOUDFLARED if exist "%ROOT%cloudflared.exe" set "CLOUDFLARED=%ROOT%cloudflared.exe"
if not defined CLOUDFLARED (
  for /f "delims=" %%i in ('where cloudflared 2^>nul') do (
    if not defined CLOUDFLARED set "CLOUDFLARED=%%i"
  )
)

if not defined CLOUDFLARED (
  echo [ERROR] cloudflared.exe was not found.
  echo.
  echo Download it from:
  echo   https://github.com/cloudflare/cloudflared/releases/latest
  echo Place cloudflared.exe into: %ROOT%tools\cloudflared.exe
  echo.
  pause
  exit /b 1
)

echo [OK] Found cloudflared: %CLOUDFLARED%
echo.

:: 2. Choose Domain Name (Default: rjcschool.in)
set "DOMAIN=rjcschool.in"
set /p "USER_DOMAIN=Enter primary domain name [press Enter for default: %DOMAIN%]: "
if not "!USER_DOMAIN!"=="" set "DOMAIN=!USER_DOMAIN!"

set "VERIFY_DOMAIN=verify.%DOMAIN%"
set "TUNNEL_NAME=rjc-school"

echo.
echo Configuration summary:
echo   - Portal Domain:      https://!DOMAIN!
echo   - Verification Domain: https://!VERIFY_DOMAIN!
echo   - Tunnel Name:        !TUNNEL_NAME!
echo   - Local Forwarding:   http://localhost:3000
echo.
pause

:: 3. Authenticate with Cloudflare
echo.
echo -------------------------------------------------------------------------------
echo STEP 1: Authenticate with Cloudflare
echo -------------------------------------------------------------------------------
echo A browser window will open. Sign in to your Cloudflare account and authorize
echo access for the domain: !DOMAIN!
echo.
"%CLOUDFLARED%" tunnel login
if errorlevel 1 (
  echo [WARNING] Login did not complete or was cancelled.
  echo Ensure you authorize Cloudflare for !DOMAIN! before continuing.
)

:: 4. Create Named Tunnel
echo.
echo -------------------------------------------------------------------------------
echo STEP 2: Creating Named Tunnel "!TUNNEL_NAME!"
echo -------------------------------------------------------------------------------
"%CLOUDFLARED%" tunnel create !TUNNEL_NAME!
if errorlevel 1 (
  echo.
  echo If the tunnel already exists, listing existing tunnels...
  "%CLOUDFLARED%" tunnel list
)

:: 5. Locate Tunnel UUID
echo.
echo -------------------------------------------------------------------------------
echo STEP 3: Detecting Tunnel Configuration
echo -------------------------------------------------------------------------------
set "CF_DIR=%USERPROFILE%\.cloudflared"
if not exist "%CF_DIR%" mkdir "%CF_DIR%"

set "TUNNEL_ID="
for /f "tokens=1,2" %%A in ('"%CLOUDFLARED%" tunnel list 2^>nul') do (
  if "%%B"=="!TUNNEL_NAME!" set "TUNNEL_ID=%%A"
)

if not defined TUNNEL_ID (
  echo Could not automatically determine the UUID for tunnel "!TUNNEL_NAME!".
  echo Please look at the tunnel list above and enter the Tunnel ID manually:
  set /p "TUNNEL_ID=Enter Tunnel ID / UUID: "
)

if not defined TUNNEL_ID (
  echo [ERROR] No Tunnel ID provided. Setup cannot continue.
  pause
  exit /b 1
)

echo [OK] Tunnel ID is: !TUNNEL_ID!
set "CRED_FILE=%CF_DIR%\!TUNNEL_ID!.json"

:: 6. Generate config.yml
echo.
echo -------------------------------------------------------------------------------
echo STEP 4: Writing config.yml for Ingress Routing
echo -------------------------------------------------------------------------------
set "CONFIG_FILE=%CF_DIR%\config.yml"

(
  echo tunnel: !TUNNEL_ID!
  echo credentials-file: %CRED_FILE%
  echo.
  echo ingress:
  echo   - hostname: !DOMAIN!
  echo     service: http://localhost:3000
  echo   - hostname: !VERIFY_DOMAIN!
  echo     service: http://localhost:3000
  echo   - service: http_status:404
) > "%CONFIG_FILE%"

echo [OK] Ingress config created at: %CONFIG_FILE%
type "%CONFIG_FILE%"

:: 7. Create DNS Route Records in Cloudflare
echo.
echo -------------------------------------------------------------------------------
echo STEP 5: Routing Cloudflare DNS Records
echo -------------------------------------------------------------------------------
echo Routing DNS for !DOMAIN!...
"%CLOUDFLARED%" tunnel route dns !TUNNEL_NAME! !DOMAIN!

echo Routing DNS for !VERIFY_DOMAIN!...
"%CLOUDFLARED%" tunnel route dns !TUNNEL_NAME! !VERIFY_DOMAIN!

:: 8. Install as Windows Service (Auto-Start on Boot)
echo.
echo -------------------------------------------------------------------------------
echo STEP 6: Installing Cloudflare Tunnel as Windows Service
echo -------------------------------------------------------------------------------
echo This installs cloudflared as an automatic Windows Service so that
echo the tunnel starts up automatically whenever Windows boots.
echo (Requires Administrator privileges)
echo.

"%CLOUDFLARED%" service install
if errorlevel 1 (
  echo [INFO] If already installed or administrator permissions needed, starting service...
)

sc.exe config cloudflared start= auto >nul 2>&1
sc.exe start cloudflared >nul 2>&1

:: 9. Save settings to .env and Admin DB
echo.
echo -------------------------------------------------------------------------------
echo STEP 7: Updating Local Configuration (.env)
echo -------------------------------------------------------------------------------
node -e "
const fs = require('fs');
let env = '';
try { env = fs.readFileSync('.env', 'utf8'); } catch {}
const update = (key, val) => {
  const reg = new RegExp('^' + key + '=.*$', 'm');
  if (reg.test(env)) env = env.replace(reg, key + '=' + val);
  else env += (env.endsWith('\n') || !env ? '' : '\n') + key + '=' + val + '\n';
};
update('PUBLIC_PORTAL_URL', 'https://!DOMAIN!');
update('PUBLIC_VERIFY_URL', 'https://!VERIFY_DOMAIN!');
fs.writeFileSync('.env', env);
console.log('Saved PUBLIC_PORTAL_URL=https://!DOMAIN! and PUBLIC_VERIFY_URL=https://!VERIFY_DOMAIN! to .env');
"

echo.
echo ===============================================================================
echo                             SETUP COMPLETE!
echo ===============================================================================
echo  Your school is now accessible globally via permanent domains:
echo    Parent Portal:       https://!DOMAIN!
echo    Public Verification: https://!VERIFY_DOMAIN!
echo.
echo  The tunnel runs continuously in the background as a Windows service.
echo  Run tools\check-status.bat anytime to inspect live connectivity.
echo ===============================================================================
echo.
pause
exit /b 0
