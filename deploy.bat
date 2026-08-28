@echo off
REM Thin launcher for deploy.ps1 (all logic lives in the .ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
