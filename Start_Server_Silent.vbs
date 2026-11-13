' RGC School Document Portal - silent background server launcher.
' Starts node.exe server.js hidden in the background with C:\RJC as the working directory.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = "C:\RJC"
If fso.FileExists(base & "\portable-node\node.exe") Then
  node = base & "\portable-node\node.exe"
Else
  node = "node.exe"
End If
shell.CurrentDirectory = base
shell.Run Chr(34) & node & Chr(34) & " server.js", 0, False
