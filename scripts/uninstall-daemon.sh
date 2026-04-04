#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="ai.clawd.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "==> clawd daemon uninstaller"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm "$PLIST_PATH"
  echo "  Removed and unloaded $PLIST_NAME"
else
  echo "  Plist not found at $PLIST_PATH — nothing to do"
fi

echo "==> Done"
