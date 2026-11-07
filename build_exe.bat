@echo off
setlocal
cd /d "%~dp0"
title Build LLM Benchmark Server EXE

echo ========================================================
echo   Building LLM-Benchmark-Server.exe (PyInstaller)
echo ========================================================
echo.

rem 优先使用 py 启动器的新版 Python (3.10+), 规避老版本 3.7 的兼容问题
set PYCMD=python
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if %ERRORLEVEL% equ 0 set PYCMD=py -3

echo [*] 使用解释器: %PYCMD%
%PYCMD% --version

%PYCMD% build_exe.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [x] 打包失败, 请检查上方报错信息。
    pause
    exit /b 1
)

echo.
echo 完成。产物位于 dist\LLM-Benchmark-Server.exe
pause
