#!/bin/bash
# watchdog.sh — JuneClaw emergency recovery
# Runs via cron every 2 minutes:
#   1. Check if daemon is alive → restart if dead
#   2. Check iMessage for "restart juneclaw" → force restart
#
# crontab: */2 * * * * /Users/jp/JuneClaw/tools/watchdog.sh >> ~/.juneclaw/logs/watchdog.log 2>&1

set -uo pipefail

JUNECLAW_DIR="/Users/jp/JuneClaw"
JUNECLAW_PID="$HOME/.juneclaw/daemon.pid"
JUNECLAW_LOG="$HOME/.juneclaw/logs/daemon.log"
JUNECLAW_DIST="$JUNECLAW_DIR/dist/index.js"
IMSG="/opt/homebrew/bin/imsg"
JUNE_PHONE="+12139992143"
CHAT_ID=1

ts() { date "+%Y-%m-%d %H:%M:%S"; }

is_daemon_alive() {
  if [ -f "$JUNECLAW_PID" ]; then
    local pid
    pid=$(cat "$JUNECLAW_PID")
    kill -0 "$pid" 2>/dev/null && return 0
  fi
  # Also check by process name
  pgrep -f "JuneClaw/dist/index" > /dev/null 2>&1 && return 0
  return 1
}

restart_daemon() {
  echo "[$(ts)] Restarting JuneClaw daemon..."
  pkill -f "JuneClaw/dist/index" 2>/dev/null || true
  pkill -f "remote-control.*juneclaw" 2>/dev/null || true
  pkill -f "progress-monitor.sh" 2>/dev/null || true
  sleep 2
  rm -f "$JUNECLAW_PID"
  cd "$JUNECLAW_DIR" && node "$JUNECLAW_DIST" >> "$JUNECLAW_LOG" 2>&1 &
  echo "[$(ts)] JuneClaw restarted (PID: $!)"
  # Notify via iMessage
  $IMSG send --to "$JUNE_PHONE" --text "[Watchdog] JuneClaw 재시작 완료 (PID: $!)" 2>/dev/null || true
}

# 1. Check daemon health
if ! is_daemon_alive; then
  echo "[$(ts)] Daemon not running — auto-restarting"
  restart_daemon
  exit 0
fi

# 2. Check iMessage for restart command (last 2 minutes)
recent=$($IMSG history --chat-id "$CHAT_ID" --limit 5 --json 2>/dev/null || true)
if [ -n "$recent" ]; then
  # Look for "restart juneclaw" in recent messages (not from me)
  restart_cmd=$(echo "$recent" | while IFS= read -r line; do
    is_from_me=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('is_from_me',True))" 2>/dev/null || echo "True")
    text=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('text',''))" 2>/dev/null || echo "")
    created=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('created_at',''))" 2>/dev/null || echo "")

    if [ "$is_from_me" = "False" ]; then
      # Check if message is recent (within 3 minutes) and contains restart command
      if echo "$text" | grep -qi "restart juneclaw\|준클로 재시작\|jc restart"; then
        msg_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${created:0:19}" "+%s" 2>/dev/null || echo 0)
        now_epoch=$(date "+%s")
        age=$(( now_epoch - msg_epoch ))
        if [ "$age" -lt 180 ]; then
          echo "yes"
          break
        fi
      fi
    fi
  done)

  if [ "$restart_cmd" = "yes" ]; then
    echo "[$(ts)] Restart command received via iMessage"
    restart_daemon
    exit 0
  fi
fi

echo "[$(ts)] OK — daemon alive"
