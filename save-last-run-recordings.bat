@echo off
title Tibbiyah - Save last Playwright run recordings
setlocal EnableExtensions EnableDelayedExpansion

rem Copies test-results + playwright-report into recordings\<label>_<timestamp>
rem Usage: save-last-run-recordings.bat [label]
rem Example: save-last-run-recordings.bat lead-to-quote

cd /d "%~dp0"

set "LABEL=%~1"
if "%LABEL%"=="" set "LABEL=run"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmmss"') do set "STAMP=%%i"
set "DEST=%CD%\recordings\%LABEL%_%STAMP%"

if not exist "%CD%\test-results" if not exist "%CD%\playwright-report" (
  echo ERROR: No test-results or playwright-report found in "%CD%"
  echo Run a Playwright test first, then re-run this BAT.
  pause
  exit /b 1
)

mkdir "%DEST%" 2>nul
echo Saving last run artifacts to:
echo   %DEST%
echo.

if exist "%CD%\test-results" (
  xcopy /E /I /Y "%CD%\test-results" "%DEST%\test-results" >nul
  echo   + test-results
)
if exist "%CD%\playwright-report" (
  xcopy /E /I /Y "%CD%\playwright-report" "%DEST%\playwright-report" >nul
  echo   + playwright-report
)

echo.
echo Done.
echo Videos/traces (if any): look under %DEST%\test-results
echo HTML report: %DEST%\playwright-report\index.html
pause
exit /b 0
