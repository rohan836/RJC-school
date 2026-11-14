@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if exist "portable-node\node.exe" (
  set "RJC_NODE=%~dp0portable-node\node.exe"
) else (
  where node >nul 2>&1
  if errorlevel 1 (
    echo.
    echo Node.js 22+ is required to run RJC School Document Portal.
    echo Install Node.js LTS from https://nodejs.org/ or run:
    echo   winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
  )
  set "RJC_NODE=node"
)

if not exist "node_modules\express" (
  echo First-time setup: installing dependencies and preparing database...
  "%RJC_NODE%" setup.js
  if errorlevel 1 (
    echo Setup failed. Check your internet connection for first-time npm install.
    pause
    exit /b 1
  )
)

"%RJC_NODE%" tools\launch.js
if errorlevel 1 pause
