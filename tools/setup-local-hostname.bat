@echo off
setlocal EnableDelayedExpansion
title RJC School - Configure Local Hostnames (Staff, Parent, Admin)
color 0B

echo ===============================================================================
echo         RJC SCHOOL -- CONFIGURE LOCAL HOSTNAMES
echo         (Staff, Parent, Admin & School Portal)
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

findstr /i "staff.rjcschool.local" "%HOSTS_FILE%" >nul 2>&1
if %errorlevel% == 0 (
  echo [OK] School role hostnames are already mapped in your Windows hosts file!
) else (
  echo Adding local host mappings to %HOSTS_FILE%...
  (
    echo.
    echo # RJC School Document Portal local role mappings
    echo 127.0.0.1 rjcschool.local
    echo 127.0.0.1 staff.rjcschool.local
    echo 127.0.0.1 parent.rjcschool.local
    echo 127.0.0.1 admin.rjcschool.local
    echo 127.0.0.1 staff.local
    echo 127.0.0.1 parent.local
    echo 127.0.0.1 admin.local
    echo 127.0.0.1 rjcschool
    echo ::1 rjcschool.local
    echo ::1 staff.rjcschool.local
    echo ::1 parent.rjcschool.local
    echo ::1 admin.rjcschool.local
    echo ::1 staff.local
    echo ::1 parent.local
    echo ::1 admin.local
    echo ::1 rjcschool
  ) >> "%HOSTS_FILE%"
  echo [OK] Added staff, parent, admin, and rjcschool local mappings.
)

:: Flush DNS cache
ipconfig /flushdns >nul 2>&1

echo.
echo ===============================================================================
echo                             SETUP COMPLETE!
echo ===============================================================================
echo  On THIS School PC, you can now open dedicated role links:
echo    - Staff Portal:   http://staff.rjcschool.local:3000   (or /staff)
echo    - Parent Kiosk:   http://parent.rjcschool.local:3000  (or /parent)
echo    - Admin Portal:   http://admin.rjcschool.local:3000   (or /admin)
echo    - Main Portal:    http://rjcschool.local:3000
echo.
echo  For other phones / tablets / laptops on the SAME School Wi-Fi:
echo    - Main School Address: http://rjcschool.local:3000
echo      (To enable this across all Wi-Fi devices, rename this PC to "rjcschool":
echo       Windows Settings -^> System -^> About -^> "Rename this PC" to "rjcschool")
echo    - Or connect directly via Wi-Fi IP: http://192.168.1.5:3000
echo ===============================================================================
echo.
pause
exit /b 0
