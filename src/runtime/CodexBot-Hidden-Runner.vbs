Option Explicit

Dim mode
Dim scriptName
Dim waitForExit

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 64
End If

mode = LCase(WScript.Arguments(0))
Select Case mode
  Case "launcher"
    scriptName = "Launch-Codex-Bot.ps1"
    waitForExit = False
  Case "watchdog"
    scriptName = "CodexBot-Watchdog.ps1"
    waitForExit = True
  Case Else
    WScript.Quit 64
End Select

Dim shell
Dim fileSystem
Dim runtimeRoot
Dim scriptPath
Dim powershellPath
Dim command
Dim exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
runtimeRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fileSystem.BuildPath(runtimeRoot, scriptName)
powershellPath = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")

If Not fileSystem.FileExists(scriptPath) Then
  WScript.Quit 2
End If
If Not fileSystem.FileExists(powershellPath) Then
  WScript.Quit 3
End If

command = Chr(34) & powershellPath & Chr(34) & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
  Chr(34) & scriptPath & Chr(34)
exitCode = shell.Run(command, 0, waitForExit)
WScript.Quit exitCode
