@echo off
setlocal EnableExtensions
title Build Samrat Case Review Installer
cd /d "%~dp0"

echo.
echo ============================================================
echo   Samrat Case Review - Windows Installer Builder (Installer 5)
echo ============================================================
echo.
echo This creates the final .exe that should be sent to the client.
echo.

set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if not exist "%ISCC%" (
  echo ERROR: Inno Setup 6 is not installed.
  echo.
  echo The official download page will now open.
  echo Install Inno Setup 6, then double-click this file again.
  start "" "https://jrsoftware.org/isdl.php"
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0payload\images\samrat-app-images.tar" (
  echo ERROR: The prepared Samrat application image is missing.
  echo Re-extract the complete release-builder ZIP and try again.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0payload\version.txt" (
  echo ERROR: The prepared Samrat version file is missing.
  echo Re-extract the complete release-builder ZIP and try again.
  echo.
  pause
  exit /b 1
)

set /p "SAMRAT_VERSION="<"%~dp0payload\version.txt"
if not defined SAMRAT_VERSION (
  echo ERROR: The prepared Samrat version is empty.
  echo.
  pause
  exit /b 1
)

echo Checking the application package and compiling the installer...
echo This can take several minutes because the complete local application is included.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Installer.ps1" -Version "%SAMRAT_VERSION%" -SkipImages
if errorlevel 1 (
  echo.
  echo BUILD FAILED. Read the error above, then see README.md for help.
  echo.
  pause
  exit /b 1
)

set "SETUP=%~dp0output\Samrat-Case-Review-Setup-%SAMRAT_VERSION%-Installer5.exe"
if not exist "%SETUP%" (
  echo.
  echo ERROR: The build finished without creating the expected setup file.
  echo Expected: %SETUP%
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   SUCCESS - THE WINDOWS INSTALLER IS READY
echo ============================================================
echo.
echo Send this ONE file to the tester or client:
echo %SETUP%
echo.
echo This is Installer 5 with Docker, migration, health-check, and API-key fixes.
echo Do not run an older setup EXE without Installer5 in its name.
echo.
explorer.exe /select,"%SETUP%"
pause
exit /b 0
