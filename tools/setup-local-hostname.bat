@echo off
setlocal EnableDelayedExpansion
title RJC School - Configure Local Custom Hostname (rjcschool.local)
color 0B

echo ===============================================================================
echo         RJC SCHOOL -- CONFIGURE LOCAL HOSTNAME (rjcschool.local)
echo ===============================================================================
echo.

:: Check for Administrative privileges
net session >nul 2>&1
if not %errorLevel% == 0 (
  echo [INFO] Requesting Administrator permissions...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

set "HOSTS_FILE=%SystemRoot%\System32\drivers\etc\hosts"

echo Checking %HOSTS_FILE%...

findstr /i "rjcschool.local" "%HOSTS_FILE%" >nul 2>&1
if %errorlevel% == 0 (
  echo [OK] rjcschool.local is already mapped in your Windows hosts file!
) else (
  echo Adding local host mappings to %HOSTS_FILE%...
  (
    echo.
    echo # RJC School Document Portal local mappings
    echo 127.0.0.1 rjcschool.local
    echo 127.0.0.1 rjcschool
    echo ::1 rjcschool.local
    echo ::1 rjcschool
  ) >> "%HOSTS_FILE%"
  echo [OK] Added rjcschool.local and rjcschool mappings.
)

:: Flush DNS cache
ipconfig /flushdns >nul 2>&1

echo.
echo ===============================================================================
echo                             SETUP COMPLETE!
echo ===============================================================================
echo  On THIS School PC, you can now open the portal using friendly names:
echo    - http://rjcschool.local:3000
echo    - http://rjcschool:3000
echo    - http://localhost:3000
echo.
echo  For other phones / devices on the SAME Wi-Fi:
echo    - Windows mDNS is active: http://LaNcer07.local:3000
echo    - To make phones use http://rjcschool.local:3000, simply rename this PC:
echo      Windows Settings -^> System -^> About -^> "Rename this PC" to "rjcschool"
echo ===============================================================================
echo.
pause
exit /b 0
