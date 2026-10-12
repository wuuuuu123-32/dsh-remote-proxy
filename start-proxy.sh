#!/usr/bin/env sh
# dsh-remote-proxy launcher (macOS / Linux)
#
# Bridges Tailscale (127.0.0.1:3080) to the DSH desktop app (127.0.0.1:19387)
# and auto-injects the login cookie, so the phone needs no token.
#
# Requires: DSH desktop app running, Tailscale logged in, Node.js 18+ on PATH.
exec node "$(dirname "$0")/proxy.mjs"
