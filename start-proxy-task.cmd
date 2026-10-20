@echo off
REM ============================================================
REM  DSH remote proxy launcher for Task Scheduler.
REM
REM  Rotates the previous log, then runs the proxy with both
REM  stdout and stderr captured, so a failed start is visible.
REM  Keep this file CRLF + pure ASCII.
REM ============================================================
cd /d "D:\dsh\config\dsh-tailscale-remote"
if exist ".proxy.log" move /y ".proxy.log" ".proxy.log.prev" >nul 2>&1
"D:\NODEJS\node.exe" "D:\dsh\config\dsh-tailscale-remote\proxy.mjs" > ".proxy.log" 2>&1
