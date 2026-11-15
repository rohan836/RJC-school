@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title R. J. Chaware Convent - Safe Database Restore

if exist "portable-node\node.exe" (
  set "RJC_NODE=%~dp0portable-node\node.exe"
) else if exist "runtime\node\node.exe" (
  set "RJC_NODE=%~dp0runtime\node\node.exe"
) else (
  set "RJC_NODE=node"
)

"%RJC_NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo Node.js 22+ is required. Run Setup_Windows.bat or install Node.js first.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   RJC School Document Portal - Verified Database Restore
echo   IMPORTANT: Close the running RJC server before restoring!
echo ============================================================
echo.

set "BACKUP_FILE=%~1"
if "%BACKUP_FILE%"=="" (
  set /p "BACKUP_FILE=Drag & drop or type full path to .rjcbackup or .db file: "
)
set "BACKUP_FILE=%BACKUP_FILE:"=%"
if "%BACKUP_FILE%"=="" (
  echo No backup file specified.
  pause
  exit /b 1
)

"%RJC_NODE%" "%~dp0tools\restore.js" "%BACKUP_FILE%"
if errorlevel 1 (
  echo.
  echo Restore did NOT complete. Your existing database was untouched.
  pause
  exit /b 1
)

echo.
pause
exit /b 0
