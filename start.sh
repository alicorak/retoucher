#!/bin/sh
# Starts the bridge. Leave it running while you work in Figma.
cd "$(dirname "$0")" && exec node bridge/server.mjs
