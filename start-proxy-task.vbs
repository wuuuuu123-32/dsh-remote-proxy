' Launcher for Task Scheduler: starts the DSH remote proxy with no
' console window. Running it through wscript keeps the proxy off any
' shared console, so a stray Ctrl+C in another terminal cannot kill it.
' Keep this file CRLF + pure ASCII.
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = "cmd /c ""D:\dsh\config\dsh-tailscale-remote\start-proxy-task.cmd"""
sh.Run cmd, 0, False
