Option Explicit

Dim arguments
Dim commandLine
Dim exitCode
Dim index
Dim shell

Set arguments = WScript.Arguments
If arguments.Count = 0 Then
  WScript.Quit 87
End If

commandLine = QuoteWindowsArgument(arguments.Item(0))
For index = 1 To arguments.Count - 1
  commandLine = commandLine & " " & QuoteWindowsArgument(arguments.Item(index))
Next

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function QuoteWindowsArgument(ByVal value)
  Dim character
  Dim position
  Dim quoted
  Dim slashCount

  quoted = Chr(34)
  slashCount = 0

  For position = 1 To Len(value)
    character = Mid(value, position, 1)
    If character = "\" Then
      slashCount = slashCount + 1
    ElseIf character = Chr(34) Then
      quoted = quoted & String(slashCount * 2 + 1, "\") & Chr(34)
      slashCount = 0
    Else
      quoted = quoted & String(slashCount, "\") & character
      slashCount = 0
    End If
  Next

  QuoteWindowsArgument = quoted & String(slashCount * 2, "\") & Chr(34)
End Function
