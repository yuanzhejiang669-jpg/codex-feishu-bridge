Option Explicit

Dim fso, shell, scriptDir, watchdogScript, workspace, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdogScript = fso.BuildPath(scriptDir, "watch-codex-feishu-bridge.ps1")
workspace = fso.BuildPath(scriptDir, "workspace")
If WScript.Arguments.Count > 0 Then
  workspace = WScript.Arguments(0)
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Quote(watchdogScript) & " -Workspace " & Quote(workspace)

shell.CurrentDirectory = scriptDir
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
