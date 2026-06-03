Option Explicit

Dim fso, shell, scriptDir, scriptPath, workspace, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(scriptDir, "start-codex-feishu-bridge.ps1")
workspace = fso.BuildPath(scriptDir, "workspace")
If WScript.Arguments.Count > 0 Then
  workspace = WScript.Arguments(0)
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Quote(scriptPath) & " -Workspace " & Quote(workspace)
shell.CurrentDirectory = scriptDir
shell.Run cmd, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
