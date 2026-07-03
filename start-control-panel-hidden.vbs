Set shell = CreateObject("WScript.Shell")
scriptPath = CreateObject("Scripting.FileSystemObject").BuildPath(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName), "start-control-panel.ps1")
command = "powershell.exe -NoProfile -File " & Chr(34) & scriptPath & Chr(34)
shell.Run command, 0, False
