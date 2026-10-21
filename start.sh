#!/bin/sh
# Starts the bridge in this terminal. Leave it running while you work in Figma.
# For development from a checkout. Installed as a Claude Code plugin, the bridge starts by itself.
cd "$(dirname "$0")"
if curl -s "localhost:${FA_PORT:-4747}/health" >/dev/null 2>&1; then
  echo "A bridge is already running on localhost:${FA_PORT:-4747}. Nothing to do."
  exit 0
fi
exec node bridge/server.mjs
