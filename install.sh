#!/bin/sh
# Runs the bridge in the background (macOS): it starts at login and restarts if it stops,
# so no terminal has to stay open.
#   ./install.sh             install or update the background bridge
#   ./install.sh uninstall   remove it (then use ./start.sh by hand)
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
LABEL="com.figma-annotate.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${FA_PORT:-4747}"
DOMAIN="gui/$(id -u)"

if [ "$(uname)" != "Darwin" ]; then
  echo "The background bridge is macOS only. Run ./start.sh and leave it open."
  exit 1
fi

if [ "$1" = "uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Background bridge removed. Run ./start.sh when you need it."
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Get it from https://nodejs.org (version 18 or newer), then run ./install.sh again."
  exit 1
fi

# a bridge started by hand would hold the port
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
pkill -f "bridge/server.mjs" 2>/dev/null && echo "Stopped the bridge that was running in a terminal." || true
sleep 1

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$ROOT/bridge/server.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict><key>FA_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "$ROOT/data/bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$ROOT/data/bridge.log")</string>
</dict>
</plist>
EOF
launchctl bootstrap "$DOMAIN" "$PLIST"

i=0
until curl -s "localhost:$PORT/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ $i -gt 20 ]; then echo "The bridge did not start. Its log: $ROOT/data/bridge.log"; exit 1; fi
  sleep 0.5
done

cat <<EOF

Bridge is running in the background on localhost:$PORT (starts at login, log: data/bridge.log).

Next:
  1. Figma desktop: Plugins → Development → Import plugin from manifest…
     choose  $ROOT/plugin/manifest.json
  2. Claude Code: open this folder and type  /watch-notes

Remove it any time with  ./install.sh uninstall
EOF
