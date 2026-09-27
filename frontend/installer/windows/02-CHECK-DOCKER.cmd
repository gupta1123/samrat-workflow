@echo off
setlocal EnableExtensions
title Samrat - Check Docker
cd /d "%~dp0"
echo.
echo Open Docker Desktop and wait for Engine running before this check.
echo This check does not install, stop, or modify anything in Docker.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test-DockerSetup.ps1" -OutputPath "%~dp0samrat-docker-check.txt"
if errorlevel 1 (
  echo.
  echo CHECK FAILED. Share a screenshot of the message above.
  echo If Windows requests a different administrator account for setup,
  echo run this check as that account too.
  echo.
  pause
  exit /b 1
)
echo.
echo DOCKER CHECK PASSED. You can run the Samrat Installer 2 setup EXE.
echo.
pause
exit /b 0
