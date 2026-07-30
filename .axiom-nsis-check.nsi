; Syntax harness for AXIOM's electron-builder NSIS include.
;
; electron-builder inserts `preInit` into Function .onInit, `customInstall` into the
; install Section, and `customUnInstall` into the uninstall Section. This harness
; reproduces exactly those three insertion points and nothing else, so makensis
; compiles the real macro bodies the same way the release build will. It exists
; because a syntax error in installer.nsh only surfaces during packaging, which is
; the most expensive place to find one.

Name "AXIOM installer.nsh syntax check"
OutFile "$%TEMP%\axiom-nsh-syntax-check.exe"
InstallDir "$TEMP\axiom-nsh-syntax-check"
RequestExecutionLevel user

!include "apps\desktop\build\installer.nsh"

Function .onInit
  !insertmacro preInit
FunctionEnd

Section "Install"
  SetOutPath $INSTDIR
  WriteUninstaller "$INSTDIR\uninstall.exe"
  !insertmacro customInstall
SectionEnd

Section "Uninstall"
  !insertmacro customUnInstall
SectionEnd
