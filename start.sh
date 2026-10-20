#!/bin/sh
# Starts the bridge in this terminal. Leave it running while you work in Figma.
# To run it in the background instead (starts at login, no terminal needed): ./install.sh
cd "$(dirname "$0")"
if curl -s "localhost:${FA_PORT:-4747}/health" >/dev/null 2>&1; then
  echo "A bridge is already running on localhost:${FA_PORT:-4747}. Nothing to do."
  exit 0
fi
exec node bridge/server.mjs
