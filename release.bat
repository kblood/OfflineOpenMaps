@echo off
setlocal
title OpenMaps v2 release - web shell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Release failed with exit code %RC%.
)
pause
exit /b %RC%
