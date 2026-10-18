@echo off
title AirTransfer - High-Speed Secure Mobile to PC File Transfer
cd /d "%~dp0"

echo ===================================================================
echo     AirTransfer - High-Speed Resumable Mobile to PC File Transfer
echo ===================================================================
echo.
echo Starting local AirTransfer server...
echo.

:: Start server and open browser
start "" http://localhost:4545/pc.html
node server/server.js

pause
