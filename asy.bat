@echo off
rem ============================================================
rem  asy - AnyShare CLI launcher (Windows)
rem  Usage: asy login / asy ls / asy put ... / asy help
rem ============================================================
setlocal
set "SCRIPT_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
node "%SCRIPT_DIR%asy.js" %*
endlocal