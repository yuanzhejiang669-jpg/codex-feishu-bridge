Option Explicit

Dim fso, shell, scriptDir, scriptPath, workspace, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(scriptDir, "start-codex-feishu-bridge.ps1")
workspace = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\Codex\workspaces\feishu-bridge"
If WScript.Arguments.Count > 0 Then
  workspace = WScript.Arguments(0)
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Quote(scriptPath) & " -Workspace " & Quote(workspace)

shell.CurrentDirectory = scriptDir
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
