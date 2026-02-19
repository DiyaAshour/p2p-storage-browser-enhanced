@echo off
title P2P Storage Browser Launcher
echo ==========================================
echo    P2P Storage Browser - Starting...
echo ==========================================

:: Start Backend Server in a new window
echo [1/3] Starting Backend Server...
start "P2P Backend" cmd /c "pnpm run server"

:: Start Frontend (Vite) in a new window
echo [2/3] Starting Frontend (Vite)...
start "P2P Frontend" cmd /c "pnpm dev"

:: Wait for servers to start
echo [3/3] Waiting for servers to be ready (10 seconds)...
timeout /t 10 /nobreak >nul

:: Open the Electron Launcher (which opens the browser)
echo ==========================================
echo    Opening Browser with MetaMask Support
echo ==========================================
pnpm run electron:dev

echo.
echo [SUCCESS] Everything is running! 
echo Keep the other windows open while using the app.
echo.
pause
