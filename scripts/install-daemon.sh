#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOME_DIR="$HOME"
PLIST_NAME="ai.clawd.daemon"
PLIST_DEST="$HOME_DIR/Library/LaunchAgents/$PLIST_NAME.plist"
TEMPLATE="$PROJECT_DIR/launchd/$PLIST_NAME.plist.template"

echo "==> clawd daemon installer"

# Check dist exists
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "ERROR: dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

# Create log directory
mkdir -p "$HOME_DIR/.clawd/logs"
echo "  Created ~/.clawd/logs/"

# Unload existing if present
if launchctl list | grep -q "$PLIST_NAME" 2>/dev/null; then
  echo "  Unloading existing daemon..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Generate plist from template
sed \
  -e "s|INSTALL_PATH|$PROJECT_DIR|g" \
  -e "s|HOME_PATH|$HOME_DIR|g" \
  "$TEMPLATE" > "$PLIST_DEST"

echo "  Wrote $PLIST_DEST"

# Load daemon
launchctl load "$PLIST_DEST"
echo "  Loaded $PLIST_NAME"

echo "==> Done! Check logs at ~/.clawd/logs/"
