@echo off
setlocal
cd /d "%~dp0"
title IceBreaker - LLM & GPU Stress Benchmark

echo ========================================================
echo       IceBreaker - LLM & GPU Stress Benchmark
echo ========================================================
echo.

rem ---- kill stale server instances holding port 8765 ----
set FOUND_OLD=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":8765 " ^| findstr /C:"LISTENING"') do (
    set FOUND_OLD=1
    echo [!] Port 8765 is held by old process PID %%P, killing it now...
    taskkill /F /PID %%P >nul 2>&1
)
if %FOUND_OLD% equ 1 timeout /t 1 /nobreak >nul

python --version >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [*] Python detected. Starting server...
    echo [*] Login: admin / admin123
    start "" "http://127.0.0.1:8765"
    python server.py
) else (
    echo [!] Python not found. Opening index.html directly...
    echo [!] Note: login/proxy/GPU features need Python 3.8+
    start "" "%~dp0index.html"
    pause
)
