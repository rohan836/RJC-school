@echo off
title RJC School - DuckDNS IP Updater
cd /d "%~dp0..\"

echo Updating rjc-school.duckdns.org...
node tools\update-duckdns.js
echo.
pause
