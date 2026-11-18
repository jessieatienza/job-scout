#!/bin/zsh
# Installs (or refreshes) two launchd agents: the scout (08:00, 13:00, 18:00) and the page server (always up at http://127.0.0.1:4747).
set -e
ROOT="$HOME/job-scout"
NODE="$(command -v node)"
NODEDIR="$(dirname "$NODE")"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
for NAME in scout server; do
  PLIST="$HOME/Library/LaunchAgents/io.jobscout.$NAME.plist"
  sed -e "s#__NODE__#$NODE#g" -e "s#__ROOT__#$ROOT#g" -e "s#__HOME__#$HOME#g" -e "s#__NODEDIR__#$NODEDIR#g" "$ROOT/launchd/$NAME.plist.template" > "$PLIST"
  launchctl bootout "gui/$(id -u)/io.jobscout.$NAME" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
done
echo "Installed: scout at 08:00, 13:00, 18:00 (a run missed while asleep fires on wake); page at http://127.0.0.1:4747."
