@echo off
setlocal
cd /d "%~dp0..\"
node "%~dp0check-status.js"
echo.
pause
