!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--skip-offboarding" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}

  ${If} ${isUpdated}
    Return
  ${EndIf}

  MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "Before uninstalling Sylica AI, do you want to open Sylica AI first?$\r$\n$\r$\nYes = open Sylica AI offboarding$\r$\nNo = uninstall now$\r$\nCancel = keep Sylica AI installed" IDYES openSylica IDNO continueUninstall
  Quit

  openSylica:
    Exec '"$INSTDIR\SylicaAI.exe" --uninstall-flow'
    Quit

  continueUninstall:
    Return

!macroend
