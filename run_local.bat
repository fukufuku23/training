@echo off
REM ===========================================================================
REM  run_local.bat - serve this folder on localhost and open it.
REM
REM  Why a server is needed:
REM    This app uses ES Modules and a Service Worker. Neither works from
REM    file:// . A localhost origin is treated as secure, so everything
REM    (including offline mode) behaves exactly like the published site.
REM
REM  ASCII only. Japanese text in a .bat gets corrupted by codepage mismatches.
REM
REM  Usage:
REM    run_local.bat          serve on 127.0.0.1 only (recommended)
REM    run_local.bat /lan     also allow other devices on the same Wi-Fi
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=8080"
set "BIND=127.0.0.1"
if /i "%~1"=="/lan" set "BIND=0.0.0.0"

REM -------------------------------------------------------------- find runtime
set "SERVE="
where py >nul 2>nul
if !errorlevel! EQU 0 set "SERVE=py -3 -m http.server !PORT! --bind !BIND!"
if not defined SERVE (
  where python >nul 2>nul
  if !errorlevel! EQU 0 set "SERVE=python -m http.server !PORT! --bind !BIND!"
)
if not defined SERVE (
  where npx >nul 2>nul
  if !errorlevel! EQU 0 set "SERVE=npx --yes http-server -p !PORT! -a !BIND! -c-1"
)
if not defined SERVE (
  echo [ERROR] Python or Node.js is required to run a local server.
  echo         Install Python from https://www.python.org/ and try again.
  pause & exit /b 1
)

echo ---------------------------------------------------------------
echo  Local  : http://localhost:!PORT!/
if /i "%~1"=="/lan" (
  for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%J in ("%%I") do echo  Network: http://%%J:!PORT!/
  )
  echo.
  echo  NOTE: on a plain http:// LAN address the Service Worker will NOT
  echo        register, so offline mode and "add to home screen" cannot be
  echo        tested there. Use the published site for that.
)
echo ---------------------------------------------------------------
echo.
echo  Records saved here are stored under localhost and are SEPARATE from
echo  the published site. They are not shared between the two.
echo.
echo  Press Ctrl+C or close this window to stop the server.
echo.

REM open the browser a moment later, while the server runs in this window
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:!PORT!/"

!SERVE!

echo.
echo Server stopped.
pause
