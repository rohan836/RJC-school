@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js LTS first. & pause & exit /b 1)
if not exist node_modules (echo Run npm ci once with internet access. & pause & exit /b 1)
start "RGC School Server" /min cmd /c "node server.js"
timeout /t 3 /nobreak >nul
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --kiosk --kiosk-printing http://localhost:3000 & exit /b)
echo Install Chrome or Edge for kiosk printing.
pause
