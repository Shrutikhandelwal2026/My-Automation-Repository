@echo off
title Tibbiyah - Lead to Quote Creation
setlocal

rem =============================================================================
rem  SYNC: Keep this BAT in sync with:
rem    tests\Lead to Quote creation\lead-to-quote-creation.spec.js
rem  Flow: Login -^> Lead list -^> New Lead -^> Convert
rem        -^> Opportunity Related -^> Choose Price Book -^> Add Products -^> New Quote
rem  Cred: test-data Credentials CSV OR set SF_LOGIN_URL SF_USERNAME SF_PASSWORD
rem  Optional: SF_PRICEBOOK_SEARCH  SF_PRODUCT_SEARCH  SF_STEP_DELAY_MS  SF_PASSKEY_WAIT_MS
rem  After login, script PAUSES on Passkey/MFA page until Lightning home opens.
rem =============================================================================

cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found in "%CD%"
  echo Place this BAT next to Tibbiyah Automation package.json.
  pause
  exit /b 1
)

echo ========================================
echo  Lead to Quote Creation ^(Playwright^)
echo  Directory: %CD%
echo  Spec:       tests/Lead to Quote creation/lead-to-quote-creation.spec.js
echo  Started:    %DATE% %TIME%
echo ========================================
echo.
echo  Paths use forward slashes - Playwright treats CLI args as regex.
echo  Live: Playwright list + [Automation] lines. Report: npx playwright show-report
echo.

call npx playwright test lead-to-quote-creation

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
