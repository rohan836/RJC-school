@echo off
rem RGC School Document Portal launcher - works on the permanent PC install (C:\RJC)
rem and on the portable USB package (any drive letter). Uses a bundled
rem portable-node\node.exe when present, otherwise the system Node.js.
cd /d "%~dp0"
if exist "%~dp0portable-node\node.exe" (
  set "NODE=%~dp0portable-node\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" --version >nul 2>nul || (echo Install Node.js LTS, or use the portable USB package with bundled portable-node. & pause & exit /b 1)
if not exist "%~dp0node_modules" (echo Run npm ci once with internet access, or use the USB export. & pause & exit /b 1)
rem Start the server only when port 3000 is free
netstat -an | findstr /C:":3000 " | findstr /C:"LISTENING" >nul 2>nul
if errorlevel 1 (
  start "RGC School Server" /min cmd /c """%NODE%"" server.js"
) else (
  echo Server already running on port 3000.
)
timeout /t 3 /nobreak >nul
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
echo Install Chrome or Edge for kiosk printing.
pause
