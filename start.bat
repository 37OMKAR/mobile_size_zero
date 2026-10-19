@echo off
title AirTransfer - High-Speed Secure Mobile to PC File Transfer
cd /d "%~dp0"

echo ===================================================================
echo     AirTransfer - High-Speed Resumable Mobile to PC File Transfer
echo ===================================================================
echo.

:: Check Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your PATH!
    echo Please install Node.js (v18 or higher) from https://nodejs.org/
    pause
    exit /b 1
)

:: Install dependencies if not already installed
if not exist "node_modules\" (
    echo [INFO] First-time setup detected. Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install npm dependencies.
        pause
        exit /b 1
    )
    echo.
)

echo Starting local AirTransfer server...
echo.

:: Start server and open browser
start "" http://localhost:4545/pc.html
node server/server.js

pause
