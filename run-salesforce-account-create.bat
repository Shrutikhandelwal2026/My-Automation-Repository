@echo off
title Tibbiyah - Salesforce Account Create
setlocal

rem =============================================================================
rem  SYNC: Keep this BAT in sync with tests/salesforce-account-create.spec.js
rem  Runs: Login -^> /lightning/o/Account/list?filterName=AllAccounts -^> New
rem  Fill: random values one-by-one, then Save (see spec for SAP date etc.)
rem  Parent: skip if already set -^> click -^> clear -^> test -^> Enter -^> wait modal + first radio
rem         -^> first-row slds-radio_faux -^> footer Select -^> verify field populated
rem  Cred: test-data Credentials CSV OR set SF_LOGIN_URL SF_USERNAME SF_PASSWORD
rem =============================================================================

cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found in "%CD%"
  echo Place this BAT next to Tibbiyah Automation package.json.
  pause
  exit /b 1
)

echo ========================================
echo  Salesforce Account Create ^(Playwright^)
echo  Directory: %CD%
echo  Spec:       tests/salesforce-account-create.spec.js
echo  Started:    %DATE% %TIME%
echo ========================================
echo.
echo  Paths use forward slashes - Playwright treats CLI args as regex.
echo  Live: Playwright list + [Automation] lines. Report: npx playwright show-report
echo.

call npx playwright test "tests/salesforce-account-create.spec.js"

set "EXITCODE=%ERRORLEVEL%"
echo.
echo ========================================
if %EXITCODE% equ 0 (
  echo  Finished OK - exit code %EXITCODE%
) else (
  echo  Finished with errors - exit code %EXITCODE%
)
echo  HTML report: npx playwright show-report
echo ========================================
pause
exit /b %EXITCODE%
