@echo off
REM ===========================================================================
REM  deploy.bat - commit, push, wait for GitHub Pages, then open the page.
REM
REM  ASCII only. Japanese text in a .bat file gets corrupted by codepage
REM  mismatches (a multi-byte lead byte can swallow the next symbol).
REM
REM  Usage:
REM    deploy.bat                    commit with an automatic message
REM    deploy.bat "your message"     commit with your own message
REM    deploy.bat /open              skip git, just open the published page
REM    deploy.bat /private           same, but open a Chrome incognito window
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

where git >nul 2>nul || (echo [ERROR] git not found in PATH. & pause & exit /b 1)
where curl >nul 2>nul || (echo [ERROR] curl not found. Windows 10 1803+ required. & pause & exit /b 1)

REM ---------------------------------------------------------------- site URL
set "ORIGIN="
for /f "tokens=*" %%A in ('git config --get remote.origin.url 2^>nul') do set "ORIGIN=%%A"
if not defined ORIGIN (
  echo [ERROR] No git remote. Run this inside the repository folder.
  pause & exit /b 1
)
set "SLUG=!ORIGIN!"
set "SLUG=!SLUG:https://github.com/=!"
set "SLUG=!SLUG:git@github.com:=!"
set "SLUG=!SLUG:.git=!"
for /f "tokens=1,2 delims=/" %%A in ("!SLUG!") do (
  set "OWNER=%%A"
  set "REPO=%%B"
)
set "SITE=https://!OWNER!.github.io/!REPO!/"

echo ---------------------------------------------------------------
echo  Site : !SITE!
echo ---------------------------------------------------------------
echo.

set "MODE=%~1"
if /i "!MODE!"=="/open"    goto open
if /i "!MODE!"=="/private" goto open

REM ------------------------------------------------------- stamp asset version
REM  GitHub Pages serves js/css with max-age=600. On a normal reload the
REM  browser reuses those from its HTTP cache WITHOUT going through the
REM  service worker, so an update can stay invisible for ~10 minutes.
REM  Changing the URL is the only reliable fix, so stamp ?v=<timestamp>
REM  into index.html and into the import statements of app.js.
echo Stamping asset version...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$enc = New-Object System.Text.UTF8Encoding($false);" ^
  "$v = Get-Date -Format 'yyyyMMddHHmmss';" ^
  "foreach ($f in @('index.html','js\app.js')) {" ^
  "  $p = Join-Path (Get-Location) $f;" ^
  "  $t = [IO.File]::ReadAllText($p, $enc);" ^
  "  $t = [regex]::Replace($t, '\?v=[0-9A-Za-z]+', '?v=' + $v);" ^
  "  [IO.File]::WriteAllText($p, $t, $enc);" ^
  "}; Write-Host ('  version ' + $v)"
if errorlevel 1 (
  echo [WARN] Version stamping failed. Continuing without it.
)
echo.

REM -------------------------------------------------------- commit and push
set "MSG=%~1"
if not defined MSG set "MSG=update !DATE! !TIME!"

git add -A
git diff --cached --quiet
if !errorlevel! EQU 0 (
  echo No local changes. Skipping commit.
) else (
  echo Committing: !MSG!
  git commit -m "!MSG!" || (echo [ERROR] commit failed. & pause & exit /b 1)
)

echo Pushing...
git push || (echo [ERROR] push failed. & pause & exit /b 1)
echo.

REM ------------------------------------- wait until the CDN serves the new files
REM  Compare local files with the published ones.
REM  Checking index.html alone is NOT enough: a change limited to
REM  app.js or style.css leaves index.html untouched, so it would match
REM  immediately and report success while the old code is still served.
echo Waiting for GitHub Pages to publish (up to 3 minutes)...
set /a TRIES=0

:poll
set /a TRIES+=1
if !TRIES! GTR 36 (
  echo.
  echo [WARN] Timed out. Opening anyway - it may still be the previous build.
  goto open
)

set "MISMATCH="
for %%F in ("index.html;index.html" "js\app.js;js/app.js" "css\style.css;css/style.css" "js\domain.js;js/domain.js") do (
  for /f "tokens=1,2 delims=;" %%A in (%%~F) do (
    if not defined MISMATCH (
      call :hash "%%A" LOCALH
      curl -s -f -o "%TEMP%\_deploy_check" "!SITE!%%B?nocache=!RANDOM!!TRIES!" 2>nul
      if exist "%TEMP%\_deploy_check" (
        call :hash "%TEMP%\_deploy_check" REMOTEH
        del "%TEMP%\_deploy_check" >nul 2>nul
        if /i not "!LOCALH!"=="!REMOTEH!" set "MISMATCH=%%B"
      ) else (
        set "MISMATCH=%%B"
      )
    )
  )
)

if not defined MISMATCH (
  echo.
  echo Published. All checked files match.
  goto open
)

<nul set /p "=."
timeout /t 5 /nobreak >nul
goto poll

REM ------------------------------------------------------------------- open
:open
echo.
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if exist %%P if not defined CHROME set "CHROME=%%~P"

if /i "%~1"=="/private" (
  if defined CHROME (
    echo Opening an incognito window...
    start "" "!CHROME!" --incognito "!SITE!"
    echo.
    echo NOTE: records are NOT kept in incognito. Use it only to check the design.
    goto done
  )
  echo [WARN] Chrome not found. Opening a normal window instead.
)

echo Opening !SITE!
if defined CHROME (
  start "" "!CHROME!" --new-window "!SITE!"
) else (
  start "" "!SITE!"
)

:done
echo.
echo If the page still looks old, press Ctrl+Shift+R once.
echo.
pause
exit /b 0

REM ----------------------------------------------------- :hash file var_name
:hash
setlocal EnableDelayedExpansion
set "_H="
for /f "skip=1 tokens=*" %%H in ('certutil -hashfile %1 SHA1 2^>nul') do (
  if not defined _H set "_H=%%H"
)
set "_H=!_H: =!"
endlocal & set "%~2=%_H%"
goto :eof
