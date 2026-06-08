Option Explicit

Dim fso, shell, scriptDir, watchdogScript, workspace, instanceName, larkProfile
Dim codexTimeoutSeconds, codexIdleTimeoutSeconds, watchdogTimeoutSeconds, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdogScript = fso.BuildPath(scriptDir, "watch-codex-feishu-bridge.ps1")
workspace = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\Codex\workspaces\feishu-bridge"
If WScript.Arguments.Count > 0 Then
  workspace = WScript.Arguments(0)
End If
instanceName = ""
If WScript.Arguments.Count > 1 Then
  instanceName = WScript.Arguments(1)
End If
larkProfile = ""
If WScript.Arguments.Count > 2 Then
  larkProfile = WScript.Arguments(2)
End If
codexTimeoutSeconds = "0"
If WScript.Arguments.Count > 3 Then
  codexTimeoutSeconds = WScript.Arguments(3)
End If
codexIdleTimeoutSeconds = "3600"
If WScript.Arguments.Count > 4 Then
  codexIdleTimeoutSeconds = WScript.Arguments(4)
End If
watchdogTimeoutSeconds = "180"
If WScript.Arguments.Count > 5 Then
  watchdogTimeoutSeconds = WScript.Arguments(5)
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Quote(watchdogScript) & " -Workspace " & Quote(workspace)
If instanceName <> "" Then
  command = command & " -Name " & Quote(instanceName)
End If
If larkProfile <> "" Then
  command = command & " -LarkProfile " & Quote(larkProfile)
End If
command = command & " -CodexTimeoutSeconds " & Quote(codexTimeoutSeconds)
command = command & " -CodexIdleTimeoutSeconds " & Quote(codexIdleTimeoutSeconds)
command = command & " -WatchdogTimeoutSeconds " & Quote(watchdogTimeoutSeconds)

shell.CurrentDirectory = scriptDir
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
