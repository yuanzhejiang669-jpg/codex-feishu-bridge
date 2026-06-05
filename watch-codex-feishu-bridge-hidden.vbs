Option Explicit

Dim fso, shell, scriptDir, watchdogScript, workspace, instanceName, larkProfile, command

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

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Quote(watchdogScript) & " -Workspace " & Quote(workspace)
If instanceName <> "" Then
  command = command & " -Name " & Quote(instanceName)
End If
If larkProfile <> "" Then
  command = command & " -LarkProfile " & Quote(larkProfile)
End If

shell.CurrentDirectory = scriptDir
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
