@echo off
REM Thin launcher for start_voicevox.ps1 (all logic lives in the .ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_voicevox.ps1" %*
