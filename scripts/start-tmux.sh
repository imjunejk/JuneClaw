#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SESSION="juneclaw"
LOG_FILE="$HOME/.juneclaw/logs/daemon.log"
STATE_FILE="$HOME/.juneclaw/state.json"
PLIST_NAME="ai.juneclaw.daemon"

# Create log dir if needed
mkdir -p "$HOME/.juneclaw/logs"
touch "$LOG_FILE"

# Stop launchd daemon first to prevent duplicate instances
if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "Stopping launchd daemon ($PLIST_NAME) to avoid duplicate..."
  launchctl unload "$HOME/Library/LaunchAgents/$PLIST_NAME.plist" 2>/dev/null || true
  sleep 1
fi

# Kill any existing JuneClaw node processes
pkill -f "JuneClaw/dist/index" 2>/dev/null || true

# Kill existing tmux session if any
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists. Attaching..."
  exec tmux attach-session -t "$SESSION"
fi

# Create new session with gateway window
tmux new-session -d -s "$SESSION" -n gateway

# Create additional windows
tmux new-window -t "$SESSION:1" -n logs
tmux new-window -t "$SESSION:2" -n monitor

# Start commands in each window
tmux send-keys -t "$SESSION:gateway" "cd $PROJECT_DIR && node dist/index.js 2>&1 | tee -a $LOG_FILE" Enter
tmux send-keys -t "$SESSION:logs" "tail -f $LOG_FILE" Enter
tmux send-keys -t "$SESSION:monitor" "watch -n5 'cat $STATE_FILE 2>/dev/null | jq . 2>/dev/null || echo \"no state yet\"'" Enter

# Focus gateway window
tmux select-window -t "$SESSION:gateway"

echo "JuneClaw tmux session '$SESSION' created."
echo "  Attach with: tmux attach -t $SESSION"

# Attach if interactive
if [ -t 0 ]; then
  exec tmux attach-session -t "$SESSION"
fi
