@echo off
REM ============================================================
REM  dsh-remote-proxy launcher (Windows)
REM
REM  Bridges Tailscale (127.0.0.1:3080) to the DSH desktop app
REM  (127.0.0.1:19387) and auto-injects the login cookie, so the
REM  phone needs no token.
REM
REM  Requires: DSH desktop app running, Tailscale logged in,
REM            Node.js 18+ on PATH.
REM  Keep this window open while remote access is wanted.
REM ============================================================
node "%~dp0proxy.mjs"
echo.
echo [proxy stopped] press any key to close...
pause >nul
