@echo off
REM AXIOM Windows x64 package wrapper.
REM The PowerShell script is the single authoritative build path.
REM Public/signed build: build-axiom-exe.cmd
REM Local unsigned build: build-axiom-exe.cmd -AllowUnsigned
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-axiom-exe.ps1" %*
set "AXIOM_BUILD_RC=%ERRORLEVEL%"
if not "%AXIOM_BUILD_RC%"=="0" pause
exit /b %AXIOM_BUILD_RC%
