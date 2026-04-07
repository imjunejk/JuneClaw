#!/bin/bash
# progress-monitor.sh — Independent progress notification script
# Polls progress-state.json and sends iMessage updates via imsg CLI.
# No agent spawning — pure shell script.
#
# Usage: ./tools/progress-monitor.sh [--once]
#   --once: check once and exit (for cron/launchd)
#   default: loop with 5s polling interval

set -uo pipefail

STATE_FILE="$HOME/.juneclaw/progress-state.json"
FIRST_DELAY=15       # seconds before first notification
INTERVAL=300         # seconds between subsequent notifications (5 min)
POLL_INTERVAL=5      # polling frequency

last_notified=0

send_progress() {
  local agent_name="$1"
  local elapsed_sec="$2"
  local preview="$3"
  local task_type="$4"
  # Default to empty under set -u so a short-arg caller can't kill the loop.
  local phone="${5:-}"

  # Short-circuit before any expensive work (esp. agent-lifecycle.sh, which
  # currently emits spammy usage text on every call) if we have nothing to
  # send to.
  if [ -z "$phone" ]; then
    echo "[progress-monitor] skip: phone empty"
    return 0
  fi

  local elapsed_min=$(( elapsed_sec / 60 ))
  local elapsed_remainder=$(( elapsed_sec % 60 ))

  local time_str
  if [ "$elapsed_min" -ge 1 ]; then
    time_str="${elapsed_min}분 ${elapsed_remainder}초 경과"
  else
    time_str="${elapsed_sec}초 경과"
  fi

  # Task type emoji
  local emoji
  case "$task_type" in
    coding)   emoji="🔨" ;;
    research) emoji="🔍" ;;
    general)  emoji="💬" ;;
    *)        emoji="⏳" ;;
  esac

  local msg="${emoji} ${task_type} 작업 진행 중... (${agent_name}, ${time_str})"

  # Add message preview
  if [ -n "$preview" ]; then
    msg="${msg}
  └ \"${preview}\""
  fi

  # Check for active sub-agents via agent-lifecycle
  local lifecycle_script="$HOME/.juneclaw/workspace/tools/agent-lifecycle.sh"
  if [ -x "$lifecycle_script" ]; then
    local agents
    agents=$("$lifecycle_script" status 2>/dev/null | grep -c "running" || true)
    if [ "$agents" -gt 0 ]; then
      msg="${msg}
  └ 활성 에이전트: ${agents}개"
    fi
  fi

  # Capture imsg's combined output so failures include the underlying error
  # (which is how the "Missing required option: --to" regression was found).
  local imsg_out
  if imsg_out=$(imsg send --to "$phone" --text "$msg" 2>&1); then
    echo "[progress-monitor] sent: ${task_type} ${agent_name} ${time_str}"
  else
    # Collapse newlines so the failure fits on a single log line.
    local imsg_err="${imsg_out//$'\n'/ | }"
    echo "[progress-monitor] send failed (to=$phone): ${imsg_err}"
  fi
}

check_once() {
  if [ ! -f "$STATE_FILE" ]; then
    return 0
  fi

  local started_at agent_name task_type preview PHONE
  local _parsed
  _parsed=$(python3 -c '
import json, sys, os
try:
    s = json.load(open(os.path.expanduser("'"$STATE_FILE"'")))
    sys.stdout.write(str(s["startedAt"]) + "\n")
    sys.stdout.write(str(s["agentName"]) + "\n")
    sys.stdout.write(str(s["taskType"]) + "\n")
    sys.stdout.write(str(s.get("messagePreview", "")) + "\n")
    sys.stdout.write(str(s.get("phone", "")) + "\n")
except Exception:
    sys.exit(1)
' 2>/dev/null) || return 0

  {
    read -r started_at
    read -r agent_name
    read -r task_type
    read -r preview
    read -r PHONE
  } <<< "$_parsed"

  local now_ms
  now_ms=$(python3 -c "import time; print(int(time.time() * 1000))")
  local elapsed_ms=$(( now_ms - started_at ))
  local elapsed_sec=$(( elapsed_ms / 1000 ))

  # Not yet time for first notification
  if [ "$elapsed_sec" -lt "$FIRST_DELAY" ]; then
    return 0
  fi

  # Check if we should send (first time or interval passed)
  local now_sec
  now_sec=$(date +%s)
  if [ "$last_notified" -eq 0 ]; then
    send_progress "$agent_name" "$elapsed_sec" "$preview" "$task_type" "$PHONE"
    last_notified=$now_sec
  elif [ $(( now_sec - last_notified )) -ge "$INTERVAL" ]; then
    send_progress "$agent_name" "$elapsed_sec" "$preview" "$task_type" "$PHONE"
    last_notified=$now_sec
  fi
}

# --once mode: single check for cron/launchd
if [ "${1:-}" = "--once" ]; then
  check_once
  exit 0
fi

# Loop mode: continuous polling
PARENT_PID=$PPID
echo "[progress-monitor] started (poll=${POLL_INTERVAL}s, first=${FIRST_DELAY}s, interval=${INTERVAL}s, parent=${PARENT_PID})"
while true; do
  # Exit if parent daemon is dead (prevents orphan accumulation)
  if ! kill -0 "$PARENT_PID" 2>/dev/null; then
    echo "[progress-monitor] parent (PID ${PARENT_PID}) dead — exiting"
    exit 0
  fi

  check_once

  # Reset notification state when state file disappears (task completed)
  if [ ! -f "$STATE_FILE" ] && [ "$last_notified" -ne 0 ]; then
    last_notified=0
  fi

  sleep "$POLL_INTERVAL"
done
