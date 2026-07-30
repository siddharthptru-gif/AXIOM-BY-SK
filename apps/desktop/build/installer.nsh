; ============================================================================
; AXIOM — installer prerequisites & environment checks (electron-builder NSIS
; `include`). Runs inside the branded wizard BEFORE files are copied. It:
;   1. Requires Windows 10 or 11 (AXIOM targets Win10/11 only) — hard stop.
;   2. Requires a 64-bit OS (x64 or ARM64) — hard stop.
;   3. Ensures the Visual C++ runtime (node-pty's native addon) — best-effort.
; Referenced from electron-builder.yml as `nsis.include: build/installer.nsh`.
; ============================================================================

!include "WinVer.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

; --- Environment gate: block unsupported Windows before anything is written. ---
!macro preInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "AXIOM requires Windows 10 or Windows 11.$\r$\n$\r$\nYour version of Windows is not supported. Setup will now exit."
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "AXIOM requires a 64-bit edition of Windows (x64 or ARM64).$\r$\n$\r$\nSetup will now exit."
    Quit
  ${EndIf}
!macroend

; --- Custom Installation Actions ---
!macro customInstall
  ; --- Record permission granted by accepting wizard setup. Per-user (HKCU) ---
  WriteRegDWORD HKCU "Software\AXIOM\Setup" "BuildExecutionConsent" 1
  DetailPrint "Build execution permission granted."

  ; --- Editor integration: make AXIOM available from the Windows shell for ANY
  ;     file extension and for folders, WITHOUT hijacking existing file
  ;     associations. Everything is written under HKCU (per-user, no elevation):
  ;       * Applications\AXIOM.exe  -> adds AXIOM to the "Open with" list for all files
  ;       * Directory / Directory\Background -> "Open with AXIOM" folder context menu
  DetailPrint "Registering AXIOM in the Windows Open with menu..."
  WriteRegStr HKCU "Software\Classes\Applications\AXIOM.exe" "FriendlyAppName" "AXIOM"
  WriteRegStr HKCU "Software\Classes\Applications\AXIOM.exe\shell\open" "FriendlyAppName" "AXIOM"
  WriteRegStr HKCU "Software\Classes\Applications\AXIOM.exe\shell\open\command" "" '"$INSTDIR\AXIOM.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\AXIOM.exe\DefaultIcon" "" '"$INSTDIR\AXIOM.exe",0'
  ; SupportedTypes with a single "*" entry opts the app into Open With for any extension.
  WriteRegStr HKCU "Software\Classes\Applications\AXIOM.exe\SupportedTypes" "*" ""

  WriteRegStr HKCU "Software\Classes\Directory\shell\AxiomOpen" "" "Open with AXIOM"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AxiomOpen" "Icon" '"$INSTDIR\AXIOM.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\AxiomOpen\command" "" '"$INSTDIR\AXIOM.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AxiomOpen" "" "Open with AXIOM"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AxiomOpen" "Icon" '"$INSTDIR\AXIOM.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\AxiomOpen\command" "" '"$INSTDIR\AXIOM.exe" "%V"'
  DetailPrint "AXIOM is now available from right-click > Open with."
!macroend

; --- Remove only the keys the installer created; never touch other associations. ---
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\AXIOM.exe"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AxiomOpen"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\AxiomOpen"
  ; The granted permission does not outlive the installation that asked for it.
  DeleteRegKey HKCU "Software\AXIOM\Setup"
!macroend
