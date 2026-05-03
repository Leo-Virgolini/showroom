@echo off
REM ============================================================================
REM Wrapper minimo para que el doble-click funcione sin pelearnos con la
REM execution policy de PowerShell. La logica vive en redeploy.ps1.
REM
REM Al final hace `pause` para que la ventana no se cierre y puedas leer el
REM output del docker compose ps (o el error si fallo algun paso).
REM ============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0redeploy.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
