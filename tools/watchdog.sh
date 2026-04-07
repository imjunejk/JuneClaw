#!/bin/bash
# watchdog.sh — JuneClaw emergency recovery
# Runs via cron every 2 minutes:
#   1. Check if daemon is alive → restart via launchctl if dead
#   2. Kill orphan child processes
#   3. Check iMessage for "restart juneclaw" → force restart via launchctl
#
# IMPORTANT: This script never spawns the daemon directly.
# All restarts go through launchctl to prevent multiple restart sources
# racing against each other (launchd KeepAlive, watchdog, self-heal).
#
# crontab: */2 * * * * /Users/jp/JuneClaw/tools/watchdog.sh >> ~/.juneclaw/logs/watchdog.log 2>&1

set -uo pipefail

JUNECLAW_DIR="/Users/jp/JuneClaw"
JUNECLAW_PID="$HOME/.juneclaw/daemon.pid"
JUNECLAW_LOCK="$HOME/.juneclaw/daemon.lock"
PLIST_LABEL="ai.juneclaw.daemon"
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
  pgrep -f "dist/index\\.js" > /dev/null 2>&1 && return 0
  return 1
}

# Restart via launchctl — single restart authority
restart_daemon() {
  echo "[$(ts)] Restarting JuneClaw via launchctl..."

  # Kill orphan children first (remote-control, progress-monitor)
  pkill -f "remote-control.*juneclaw" 2>/dev/null || true
  pkill -f "progress-monitor.sh" 2>/dev/null || true

  # Remove stale lock/pid files so the new daemon can start cleanly
  rm -f "$JUNECLAW_PID" "$JUNECLAW_LOCK"

  # Restart through launchd (the ONLY restart path)
  launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
    || launchctl kickstart "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
    || {
      echo "[$(ts)] launchctl kickstart failed — trying bootout+bootstrap"
      local plist="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
      launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
    }

  echo "[$(ts)] JuneClaw restart requested via launchctl"
  $IMSG send --to "$JUNE_PHONE" --text "[Watchdog] JuneClaw 재시작 요청됨 (launchctl)" 2>/dev/null || true
}

# 1. Check daemon health
if ! is_daemon_alive; then
  echo "[$(ts)] Daemon not running — restarting via launchctl"
  restart_daemon
  exit 0
fi

# 2. Kill orphan children whose parent daemon is dead
daemon_pid=""
if [ -f "$JUNECLAW_PID" ]; then
  daemon_pid=$(cat "$JUNECLAW_PID")
fi
for orphan_pid in $(pgrep -f "remote-control.*juneclaw" 2>/dev/null) $(pgrep -f "progress-monitor.sh" 2>/dev/null); do
  parent=$(ps -p "$orphan_pid" -o ppid= 2>/dev/null | tr -d ' ')
  # If parent is init (1) or a dead process, it's an orphan
  if [ -n "$parent" ] && [ "$parent" != "$daemon_pid" ]; then
    if ! kill -0 "$parent" 2>/dev/null || [ "$parent" = "1" ]; then
      echo "[$(ts)] Killing orphan (PID $orphan_pid, dead parent $parent)"
      kill -9 "$orphan_pid" 2>/dev/null || true
    fi
  fi
done

# 3. Check iMessage for restart command (last 2 minutes)
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

# 4. Check for auth errors in recent logs (last 5 minutes)
AUTH_ALERT_FILE="$HOME/.juneclaw/.auth-alert-sent"
if grep -q "authentication_error\|401\|not logged in\|please run /login" ~/.juneclaw/logs/daemon.log 2>/dev/null; then
  # Only check recent lines (last 50)
  if tail -50 ~/.juneclaw/logs/daemon.log | grep -qi "authentication_error\|Invalid authentication credentials"; then
    # Don't spam — only alert once per hour
    if [ ! -f "$AUTH_ALERT_FILE" ] || [ "$(( $(date +%s) - $(stat -f%m "$AUTH_ALERT_FILE" 2>/dev/null || echo 0) ))" -gt 3600 ]; then
      echo "[$(ts)] Auth error detected!"
      touch "$AUTH_ALERT_FILE"
      $IMSG send --to "$JUNE_PHONE" --text "[JuneClaw] 인증 만료됨. SSH 접속 후 'claude setup-token' 또는 'claude auth login' 실행 필요." 2>/dev/null || true
    fi
  fi
fi

echo "[$(ts)] OK — daemon alive"
