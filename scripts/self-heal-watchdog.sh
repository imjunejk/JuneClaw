#!/bin/zsh
# self-heal-watchdog.sh — Zero-LLM JuneClaw self-healing watchdog
# Cron: */5 * * * * /Users/jp/JuneClaw/scripts/self-heal-watchdog.sh
#
# Detection:
#   1) Daemon health (PID file + process alive)
#   2) Error signature scan (daemon.err heuristic)
#   3) Silence detection (Messages DB — no outbound in N seconds)
#
# Recovery:
#   unhealthy → launchctl kickstart → re-check
#            → still unhealthy → bootout + bootstrap → re-check
#            → still unhealthy → iMessage alert (once, no spam)

set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────
CLAWD_HOME="$HOME/.clawd"
PROJECT_DIR="$HOME/JuneClaw"
PID_FILE="$CLAWD_HOME/daemon.pid"
LOG_DIR="$CLAWD_HOME/logs"
STATE_FILE="$CLAWD_HOME/watchdog-state.txt"
IMSG_TARGET="+12139992143"
MAX_LOG_LINES=1000
LOG="$LOG_DIR/self-heal-watchdog.log"
LOCK_FILE="/tmp/juneclaw-watchdog.lockd"
PLIST_NAME="ai.juneclaw.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

# Error log rotation
DAEMON_ERR_LOG="$LOG_DIR/daemon.err"
MAX_ERR_BYTES=1048576  # 1MB

# Silence detection
SILENCE_THRESHOLD_SECS=300   # 5 min without outbound → suspicious
SILENCE_ESCALATE_SECS=900    # 15 min → force restart
APPLE_EPOCH_OFFSET=978307200

# Cooldown
COOLDOWN_SECS=600
COOLDOWN_FILE="/tmp/juneclaw-watchdog-lastfix.txt"

# ── Concurrency guard ─────────────────────────────────────────────────────
mkdir "$LOCK_FILE" 2>/dev/null || exit 0
trap "rmdir '$LOCK_FILE' 2>/dev/null; true" EXIT INT TERM

# ── Init ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR" "$(dirname "$STATE_FILE")"
[[ -f "$STATE_FILE" ]] || echo "healthy" > "$STATE_FILE"

NOW=$(date +%s)
HOUR=$(date +%H)

now() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(now)] $*" >> "$LOG"; }

# ── Cooldown check ────────────────────────────────────────────────────────
if [[ -f "$COOLDOWN_FILE" ]]; then
  LAST_FIX=$(cat "$COOLDOWN_FILE")
  ELAPSED=$(( NOW - LAST_FIX ))
  if [[ "$ELAPSED" -lt "$COOLDOWN_SECS" ]]; then
    log "Cooldown active (${ELAPSED}s/${COOLDOWN_SECS}s). Skipping."
    exit 0
  fi
fi

# ── Helpers ───────────────────────────────────────────────────────────────
send_imsg() {
  local msg="$1"
  imsg send --to "$IMSG_TARGET" --text "$msg" >/dev/null 2>&1 || true
}

trim_log() {
  if [[ -f "$LOG" ]] && [[ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ]]; then
    tail -n "$MAX_LOG_LINES" "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi
}

rotate_err_log() {
  if [[ -f "$DAEMON_ERR_LOG" ]]; then
    local size
    size=$(stat -f%z "$DAEMON_ERR_LOG" 2>/dev/null || echo 0)
    if [[ "$size" -gt "$MAX_ERR_BYTES" ]]; then
      tail -n 5000 "$DAEMON_ERR_LOG" > "${DAEMON_ERR_LOG}.tmp" && \
        mv "${DAEMON_ERR_LOG}.tmp" "$DAEMON_ERR_LOG"
      log "Rotated daemon.err (was ${size} bytes)"
    fi
  fi
}

# ── Health check ──────────────────────────────────────────────────────────
is_healthy() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null)
  if [[ -z "$pid" ]]; then
    return 1
  fi

  kill -0 "$pid" 2>/dev/null
}

# ── Error signature scan ─────────────────────────────────────────────────
has_error_signatures() {
  [[ -f "$DAEMON_ERR_LOG" ]] || return 1
  tail -n 200 "$DAEMON_ERR_LOG" 2>/dev/null \
    | grep -Evi "(watchdog|recovered|cooldown)" \
    | grep -Eqi "(unhandled.*(error|exception)|fatal|crash|SIGABRT|SIGSEGV)" 2>/dev/null
}

# ── Silence detection (Messages DB) ──────────────────────────────────────
SILENT_SECS=0

is_silent() {
  if [[ "$HOUR" -ge 23 ]] || [[ "$HOUR" -lt 6 ]]; then
    return 1
  fi

  # Validate IMSG_TARGET is a phone number before using in SQL
  if [[ ! "$IMSG_TARGET" =~ ^\+[0-9]+$ ]]; then
    log "Invalid IMSG_TARGET format: $IMSG_TARGET"
    return 1
  fi

  local last_msg_apple
  last_msg_apple=$(sqlite3 "$HOME/Library/Messages/chat.db" \
    "SELECT MAX(m.date) FROM message m
     JOIN handle h ON m.handle_id = h.ROWID
     WHERE h.id = '$IMSG_TARGET'
     AND m.is_from_me = 1
     LIMIT 1;" 2>/dev/null) || return 1

  if [[ -z "$last_msg_apple" ]] || [[ "$last_msg_apple" = "NULL" ]] || [[ "$last_msg_apple" = "0" ]]; then
    return 1
  fi

  local last_msg_unix
  last_msg_unix=$(( last_msg_apple / 1000000000 + APPLE_EPOCH_OFFSET ))
  SILENT_SECS=$(( NOW - last_msg_unix ))

  [[ "$SILENT_SECS" -gt "$SILENCE_THRESHOLD_SECS" ]]
}

# ── Main ──────────────────────────────────────────────────────────────────
PREV_STATE=$(cat "$STATE_FILE")
needs_fix=0
reasons=()
force_restart=0

if ! is_healthy; then
  needs_fix=1
  reasons+=("daemon_not_healthy")
fi

if has_error_signatures; then
  needs_fix=1
  reasons+=("error_signature_detected")
fi

if is_silent; then
  needs_fix=1
  reasons+=("silent_${SILENT_SECS}s")
  if [[ "$SILENT_SECS" -gt "$SILENCE_ESCALATE_SECS" ]]; then
    force_restart=1
  fi
fi

# All good
rotate_err_log
if [[ "$needs_fix" -eq 0 ]]; then
  if [[ "$PREV_STATE" = "unhealthy" ]]; then
    log "Gateway recovered (healthy)."
    echo "healthy" > "$STATE_FILE"
    send_imsg "JuneClaw daemon recovered."
  fi
  trim_log
  exit 0
fi

# ── Step 1: launchctl kickstart ──────────────────────────────────────────
log "Issues: ${reasons[*]}. Running: launchctl kickstart"
launchctl kickstart "gui/$(id -u)/$PLIST_NAME" >> "$LOG" 2>&1 || true
sleep 5

if [[ "$force_restart" -eq 0 ]] && is_healthy; then
  log "Recovered via kickstart."
  echo "healthy" > "$STATE_FILE"
  echo "$NOW" > "$COOLDOWN_FILE"
  if [[ "$PREV_STATE" = "healthy" ]]; then
    send_imsg "JuneClaw issue detected (${reasons[*]}) — recovered via kickstart"
  fi
  trim_log
  exit 0
fi

# ── Step 2: full bootout + bootstrap ─────────────────────────────────────
log "Running: bootout + bootstrap"
launchctl bootout "gui/$(id -u)/$PLIST_NAME" >> "$LOG" 2>&1 || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" >> "$LOG" 2>&1 || true
sleep 10

if is_healthy; then
  log "Recovered via bootout + bootstrap."
  echo "healthy" > "$STATE_FILE"
  echo "$NOW" > "$COOLDOWN_FILE"
  if [[ "$PREV_STATE" = "healthy" ]]; then
    send_imsg "JuneClaw issue detected (${reasons[*]}) — recovered via restart"
  fi
  trim_log
  exit 0
fi

# ── Step 3: All failed ────────────────────────────────────────────────────
log "Still unhealthy after kickstart + restart. Manual intervention required."
echo "unhealthy" > "$STATE_FILE"
echo "$NOW" > "$COOLDOWN_FILE"
if [[ "$PREV_STATE" = "healthy" ]]; then
  send_imsg "JuneClaw auto-recovery failed (${reasons[*]}). Manual check needed."
fi
trim_log
exit 1
