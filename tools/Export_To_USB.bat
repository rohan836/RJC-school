@echo off
rem RGC School Document Portal - 1-click USB / portable package exporter.
rem Copies the app, a matching portable Node.js binary, and a clean SQLite snapshot
rem of school.db (via the SQLite online backup API - never a raw copy of a live database).
rem Usage: double-click, or pass the drive letter as an argument, e.g. Export_To_USB.bat E
setlocal EnableExtensions
cd /d "%~dp0..\"

if not "%~1"=="" set "DRIVE=%~1"
if "%DRIVE%"=="" set /p "DRIVE=Enter the USB drive letter (example E): "
set "DRIVE=%DRIVE:~0,1%"
if "%DRIVE%"=="" (
  echo No drive letter entered.
  pause
  exit /b 1
)
if not exist "%DRIVE%:\" (
  echo Drive %DRIVE%: does not exist or is not ready.
  pause
  exit /b 1
)
set "TARGET=%DRIVE%:\RJC_Portable"
echo.
echo Exporting the portal to %DRIVE%:\RJC_Portable ...
echo.
mkdir "%TARGET%" 2>nul
if errorlevel 1 (
  echo Cannot create %TARGET%. Check that the USB drive is writable.
  pause
  exit /b 1
)

for %%F in (server.js db.js certificate.js whatsapp.js parent-auth.js student-search.js package.json package-lock.json README.md Start_RJC.bat) do (
  copy /Y "%%F" "%TARGET%\" >nul
  if errorlevel 1 (
    echo Failed to copy %%F.
    pause
    exit /b 1
  )
)

robocopy "%~dp0..\public" "%TARGET%\public" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo Failed to copy the public folder.
  pause
  exit /b 1
)

robocopy "%~dp0..\tools" "%TARGET%\tools" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 exit /b 1

echo Copying node_modules (this can take a minute)...
robocopy "%~dp0..\node_modules" "%TARGET%\node_modules" /E /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
if errorlevel 8 (
  echo Failed to copy node_modules.
  pause
  exit /b 1
)

rem Resolve the host PC's node.exe so the USB build matches this PC's native better-sqlite3 ABI
set "NODEPATH="
for /f "delims=" %%i in ('where node') do if not defined NODEPATH set "NODEPATH=%%i"
if "%NODEPATH%"=="" (
  echo Could not resolve node.exe with "where node".
  pause
  exit /b 1
)
mkdir "%TARGET%\portable-node" 2>nul
copy /Y "%NODEPATH%" "%TARGET%\portable-node\node.exe" >nul
if errorlevel 1 (
  echo Failed to copy portable-node\node.exe.
  pause
  exit /b 1
)
echo Portable Node: %NODEPATH%

rem Clean, checkpointed copy of school.db via SQLite's online backup API (never a raw copy of the live WAL)
if not exist "school.db" (
  echo school.db not found next to this script.
  pause
  exit /b 1
)
if exist "%TARGET%\school.db" del /Q "%TARGET%\school.db"
if exist "%TARGET%\school.db-wal" del /Q "%TARGET%\school.db-wal"
if exist "%TARGET%\school.db-shm" del /Q "%TARGET%\school.db-shm"
"%NODEPATH%" -e "const db=require('better-sqlite3')(process.argv[1],{readonly:true});db.backup(process.argv[2]).then(()=>{console.log('Database snapshot written.')}).catch((e)=>{console.error('Database backup failed: '+e.message);process.exit(1)})" "%~dp0..\school.db" "%TARGET%\school.db"
if errorlevel 1 (
  echo Database snapshot failed - school.db was NOT exported.
  pause
  exit /b 1
)

if exist "admin-credentials.txt" copy /Y "admin-credentials.txt" "%TARGET%\" >nul

echo.
echo ============================================================
echo   Portable package ready at %TARGET%
echo.
echo   On any Windows PC: plug in the USB stick and double-click
echo   %TARGET%\Start_RJC.bat
echo   No Node.js installation is required.
echo.
echo   Note: admin-credentials.txt was copied if present.
echo   Keep the USB stick secure.
echo ============================================================
pause
exit /b 0
