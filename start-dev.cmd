@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"
title vc-agent development launcher

echo.
echo [vc-agent] Checking development environment...

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [vc-agent] pnpm was not found. Install pnpm and try again.
  goto :failed
)

if not exist "node_modules" (
  echo [vc-agent] Dependencies are not installed.
  echo [vc-agent] Run "pnpm install" once, then launch this script again.
  goto :failed
)

echo [vc-agent] Building current source code...
call pnpm build
if errorlevel 1 (
  echo [vc-agent] Build failed. Review the errors above.
  goto :failed
)

echo.
echo [vc-agent] Opening the development application...
echo [vc-agent] Keep this window open to view runtime logs.
echo.

set "NODE_ENV=development"
call pnpm exec electron apps/desktop/dist/main/main.js

set "APP_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%APP_EXIT_CODE%"=="0" (
  echo [vc-agent] Application exited with code %APP_EXIT_CODE%.
) else (
  echo [vc-agent] Application closed normally.
)
pause
exit /b %APP_EXIT_CODE%

:failed
echo.
pause
exit /b 1
