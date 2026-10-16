' Hidden launcher for the DSH remote proxy (used by the Run registry key).
' Starts node with no console window; keep this file ASCII-only.
Set sh = CreateObject("WScript.Shell")
sh.Run """D:\NODEJS\node.exe"" ""D:\dsh\config\dsh-tailscale-remote\proxy.mjs""", 0, False