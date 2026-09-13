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
REM    run_local.bat /port 9000   use a different port
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=8080"
set "BIND=127.0.0.1"
set "LAN="
:parseargs
if "%~1"=="" goto argsdone
if /i "%~1"=="/lan"  ( set "BIND=0.0.0.0" & set "LAN=1" & shift & goto parseargs )
if /i "%~1"=="/port" ( set "PORT=%~2" & shift & shift & goto parseargs )
shift
goto parseargs
:argsdone

REM ------------------------------------------------------- is the port free?
netstat -ano | findstr "LISTENING" | findstr ":%PORT%" >nul 2>nul
if !errorlevel! EQU 0 (
  echo ---------------------------------------------------------------
  echo  [ERROR] Port %PORT% is already in use.
  echo.
  echo   - A previous run_local window may still be open. Close it.
  echo   - Or start on another port:   run_local.bat /port 9000
  echo.
  echo  Currently listening on %PORT%:
  netstat -ano | findstr "LISTENING" | findstr ":%PORT%"
  echo ---------------------------------------------------------------
  pause & exit /b 1
)

REM ---------------------------------------------------------- find a runtime
REM  "where" only proves the command exists. Actually run it: a stub py.exe
REM  without any 3.x installed, or a broken conda shim, both pass "where".
set "SERVE="
set "RUNTIME="

py -3 -c "import sys" >nul 2>nul
if !errorlevel! EQU 0 (
  set "RUNTIME=py -3"
  set "SERVE=py -3 -m http.server !PORT! --bind !BIND!"
)

if not defined SERVE (
  python -c "import sys" >nul 2>nul
  if !errorlevel! EQU 0 (
    set "RUNTIME=python"
    set "SERVE=python -m http.server !PORT! --bind !BIND!"
  )
)

if not defined SERVE (
  python3 -c "import sys" >nul 2>nul
  if !errorlevel! EQU 0 (
    set "RUNTIME=python3"
    set "SERVE=python3 -m http.server !PORT! --bind !BIND!"
  )
)

if not defined SERVE (
  where npx >nul 2>nul
  if !errorlevel! EQU 0 (
    set "RUNTIME=npx http-server"
    set "SERVE=npx --yes http-server -p !PORT! -a !BIND! -c-1"
  )
)

if not defined SERVE (
  echo ---------------------------------------------------------------
  echo  [ERROR] No usable Python or Node.js was found.
  echo.
  echo  Tried: "py -3", "python", "python3", "npx" - none of them ran.
  echo.
  echo  Checked locations:
  where py      2>nul || echo    py      : not on PATH
  where python  2>nul || echo    python  : not on PATH
  where python3 2>nul || echo    python3 : not on PATH
  where npx     2>nul || echo    npx     : not on PATH
  echo.
  echo  If Python IS installed but listed above as "not on PATH",
  echo  re-run its installer and tick "Add Python to PATH".
  echo  With Anaconda/Miniconda, run this file from an "Anaconda Prompt".
  echo ---------------------------------------------------------------
  pause & exit /b 1
)

echo ---------------------------------------------------------------
echo  Runtime: !RUNTIME!
echo  Local  : http://localhost:!PORT!/
if defined LAN (
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
echo Server stopped (exit code !errorlevel!).
pause
