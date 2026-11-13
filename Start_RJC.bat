@echo off
cd /d "%~dp0"
if exist "portable-node\node.exe" (set "RJC_NODE=%~dp0portable-node\node.exe") else (set "RJC_NODE=node.exe")
"%RJC_NODE%" tools\launch.js
if errorlevel 1 pause
