#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOME_DIR="$HOME"
NODE_BIN="$(which node)"
PLIST_NAME="ai.juneclaw.daemon"
PLIST_DEST="$HOME_DIR/Library/LaunchAgents/$PLIST_NAME.plist"
TEMPLATE="$PROJECT_DIR/launchd/$PLIST_NAME.plist.template"

echo "==> JuneClaw daemon installer"

# 1. Build
echo "  Building TypeScript..."
cd "$PROJECT_DIR"
npm run build

# 2. Create directories
mkdir -p "$HOME_DIR/.juneclaw/logs"
echo "  Created ~/.juneclaw/logs/"

# 3. Generate plist from template
sed \
  -e "s|INSTALL_PATH|$PROJECT_DIR|g" \
  -e "s|HOME_PATH|$HOME_DIR|g" \
  -e "s|NODE_BIN|$NODE_BIN|g" \
  "$TEMPLATE" > "$PLIST_DEST"
echo "  Wrote $PLIST_DEST"

# 4. Bootout existing if present
if launchctl print "gui/$(id -u)/$PLIST_NAME" &>/dev/null; then
  echo "  Removing existing daemon..."
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
fi

# 5. Bootstrap new daemon
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
echo "  Bootstrapped $PLIST_NAME"

# 6. Install watchdog cron (every 5 min)
WATCHDOG="$PROJECT_DIR/scripts/self-heal-watchdog.sh"
chmod +x "$WATCHDOG"
CRON_ENTRY="*/5 * * * * $WATCHDOG"
if ! crontab -l 2>/dev/null | grep -qF "$WATCHDOG"; then
  (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
  echo "  Installed watchdog cron: $CRON_ENTRY"
else
  echo "  Watchdog cron already installed"
fi

echo "==> JuneClaw daemon installed and running"
echo "    Logs: ~/.juneclaw/logs/daemon.log"
echo "    State: ~/.juneclaw/state.json"
echo "    Watchdog: crontab */5 * * * *"
