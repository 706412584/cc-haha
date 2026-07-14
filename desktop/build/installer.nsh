!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
Var pid

!ifndef BUILD_UNINSTALLER
Var ccHahaRecoveryDone
Var ccHahaPerUserInstallLocation
Var ccHahaPerMachineInstallLocation
Var ccHahaPerUserUninstallString
Var ccHahaPerMachineUninstallString

Function CcHahaUninstallerParent
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R2 0

  cc_haha_uninstall_parent_find_first_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_after_first_quote
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_first_quote

  cc_haha_uninstall_parent_after_first_quote:
    IntOp $R2 $R2 + 1
    StrCpy $R0 $R0 "" $R2
    StrCpy $R2 0

  cc_haha_uninstall_parent_find_second_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_have_file
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_second_quote

  cc_haha_uninstall_parent_have_file:
    StrCpy $R0 $R0 $R2
    StrLen $R2 $R0

  cc_haha_uninstall_parent_find_slash:
    IntOp $R2 $R2 - 1
    IntCmp $R2 0 cc_haha_uninstall_parent_invalid 0 0
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "\" cc_haha_uninstall_parent_done
    Goto cc_haha_uninstall_parent_find_slash

  cc_haha_uninstall_parent_invalid:
    StrCpy $R0 ""
    Goto cc_haha_uninstall_parent_done

  cc_haha_uninstall_parent_done:
    StrCpy $R0 $R0 $R2
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaFinalInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  StrCpy $R1 "${APP_FILENAME}"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  cc_haha_final_install_find_name:
    IntCmp $R4 $R3 cc_haha_final_install_append 0 cc_haha_final_install_append
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 cc_haha_final_install_done
    IntOp $R4 $R4 + 1
    Goto cc_haha_final_install_find_name

  cc_haha_final_install_append:
    StrCpy $R0 "$R0\${APP_FILENAME}"

  cc_haha_final_install_done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaRecoverLegacy
  ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $4 == ""
  ${AndIf} $R0 != ""
    Push $R0
    Call CcHahaUninstallerParent
    Pop $4
  ${EndIf}
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R1 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $5 == ""
  ${AndIf} $R1 != ""
    Push $R1
    Call CcHahaUninstallerParent
    Pop $5
  ${EndIf}

  Push "$INSTDIR"
  Call CcHahaFinalInstallDir
  Pop $9

  ${If} $4 == ""
  ${AndIf} $5 == ""
    StrCpy $0 "0"
    StrCpy $1 "No registered installation needs legacy data recovery"
    DetailPrint "$1"
    Return
  ${EndIf}

  InitPluginsDir
  File /oname=$PLUGINSDIR\recover-legacy-install-data.ps1 "${BUILD_RESOURCES_DIR}\recover-legacy-install-data.ps1"

  ReadEnvStr $2 APPDATA
  ReadEnvStr $3 USERPROFILE
  ReadEnvStr $6 CLAUDE_CONFIG_DIR
  ReadEnvStr $7 CC_HAHA_APP_PORTABLE_DIR
  ${If} $2 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user APPDATA"
    Return
  ${EndIf}
  ${If} $3 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user USERPROFILE"
    Return
  ${EndIf}

  DetailPrint "Checking registered installations for legacy Claude Code Haha data..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\recover-legacy-install-data.ps1" -PerUserInstallDir "$4" -PerMachineInstallDir "$5" -CandidateInstallDir "$9" -UserDataDir "$2\Claude Code Haha" -RecoveryRoot "$3\Claude Code Haha Data\Recovered" -ProcessName "${PRODUCT_FILENAME}.exe" -ActiveConfigDir "$6" -ActiveConfigManaged "$7" -InstallerIdentitySafety "$8"'
  Pop $0
  Pop $1
FunctionEnd

!macro CcHahaRunLegacyRecovery
  ${If} $ccHahaRecoveryDone != "1"
    ReadRegStr $ccHahaPerUserInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerMachineInstallLocation HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $ccHahaPerUserUninstallString == ""
        ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
      ${If} $ccHahaPerMachineUninstallString == ""
        ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif

    ${If} $ccHahaPerUserInstallLocation == ""
    ${AndIf} $ccHahaPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPerUserUninstallString == ""
    ${AndIf} $ccHahaPerMachineUninstallString == ""
      StrCpy $ccHahaRecoveryDone "1"
      DetailPrint "No registered installation needs legacy data recovery"
    ${Else}
      StrCpy $8 "trusted-user"
      ${If} ${UAC_IsAdmin}
      ${AndIfNot} ${UAC_IsInnerInstance}
        StrCpy $8 "untrusted-elevated"
      ${EndIf}

      ${If} ${UAC_IsInnerInstance}
        StrCpy $8 "trusted-uac-outer"
        !insertmacro UAC_AsUser_Call Function CcHahaRecoverLegacy ${UAC_SYNCREGISTERS}|${UAC_SYNCOUTDIR}|${UAC_SYNCINSTDIR}
      ${Else}
        Call CcHahaRecoverLegacy
      ${EndIf}

      ${If} $0 != "0"
        DetailPrint "Legacy data recovery stopped the installer (helper exit code: $0; output: $1)"
        ${If} $1 == ""
          StrCpy $1 "Recovery helper failed without diagnostic output (exit code $0)"
        ${EndIf}
        StrCpy $R2 "$1" 360
        MessageBox MB_ICONSTOP|MB_OK "Claude Code Haha stopped setup before removing the old version. Reason: $R2$\r$\n$\r$\nClose the app and retry. If the reason mentions an elevated installer, launch setup normally instead of using Run as administrator.$\r$\n$\r$\nClaude Code Haha 已在删除旧版本前停止安装。原因：$R2$\r$\n$\r$\n请关闭旧程序后重试；如果原因提到安装器权限过高，请直接双击运行，不要使用“以管理员身份运行”。旧版本和原数据尚未删除。" /SD IDOK
        SetErrorLevel 20
        Quit
      ${EndIf}
      StrCpy $ccHahaRecoveryDone "1"
      DetailPrint "Legacy Claude Code Haha data safety check completed"
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro CcHahaRunLegacyRecovery
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Function CcHahaRecoveryBeforeInstall
    ${If} ${UAC_IsInnerInstance}
      !insertmacro CcHahaRunLegacyRecovery
    ${EndIf}
    Abort
  FunctionEnd
  Page custom CcHahaRecoveryBeforeInstall
!macroend

!macro customInit
  StrCpy $ccHahaRecoveryDone "0"
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${Silent}
    !insertmacro CcHahaRunLegacyRecovery
  ${EndIf}
!macroend
!endif
