@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js LTS first. & pause & exit /b 1)
if not exist node_modules (echo Run npm ci once with internet access. & pause & exit /b 1)
start "School Kiosk Server" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000 & exit /b)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 & exit /b)
start "" http://localhost:3000
