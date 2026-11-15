@echo off
setlocal
cd /d "%~dp0"
title R. J. Chaware Convent - Dual-Monitor Windows 11 Launcher

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Run Setup_Windows.bat once on a computer with internet.
  pause
  exit /b 1
)

if not exist "%~dp0node_modules" (
  echo Folder is not prepared yet. Run Setup_Windows.bat once first.
  pause
  exit /b 1
)

echo Starting RJC School Portal in Dual-Monitor Mode:
echo   - Monitor 1 (Staff Room): http://localhost:3000/staff-host (Admin Panel + Daily Queue + Auto-Print)
echo   - Monitor 2 (Parent Counter): http://localhost:3000/kiosk (QR Code + Private Parent Front Panel Only)
"%NODE%" "%~dp0tools\launch.js" --dual-monitor %*
if errorlevel 1 pause
