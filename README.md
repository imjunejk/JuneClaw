# JuneClaw

Personal AI assistant daemon — routes iMessage conversations through Claude CLI (`claude --print`) with persistent memory and session continuity.

Replaces OpenClaw by using Claude Code CLI directly with a Max subscription.

## Prerequisites

- **Node.js** >= 20
- **claude** CLI installed and authenticated (Claude Code / Max subscription)
- **imsg** CLI installed (`brew install pashields/imsg/imsg` or build from source)
- macOS with iMessage configured

## Setup

```bash
git clone <repo> ~/JuneClaw
cd ~/JuneClaw
npm install
npm run build
```

## Configuration

Environment variables (or defaults):

| Variable | Default | Description |
|---|---|---|
| `JUNECLAW_WORKSPACE` | `~/openclaw` | Path to memory workspace (SOUL.md, USER.md, etc.) |
| `JUNECLAW_JUNE_PHONE` | `+12139992143` | Phone number to monitor |
| `JUNECLAW_MODEL` | (none) | Claude model override |

## Workspace Layout

The workspace directory should contain personality and memory files:

```
~/openclaw/
├── SOUL.md              # Persona / identity
├── USER.md              # User information
├── IDENTITY.md          # Role definition
└── memory/
    ├── lessons/
    │   └── master-rules.md   # Permanent rules
    └── daily/
        └── YYYY-MM-DD.md     # Auto-generated daily logs
```

## Running

### Development

```bash
npm run dev
```

### Production (launchd daemon)

```bash
npm run build
./scripts/install-daemon.sh
```

The daemon will:
1. Poll iMessage every 2 seconds for new messages
2. Build a system prompt from workspace memory files
3. Send the message to Claude via `claude --print`
4. Reply via iMessage
5. Log the conversation to `memory/daily/YYYY-MM-DD.md`

### Uninstall daemon

```bash
./scripts/uninstall-daemon.sh
```

### Logs

```bash
tail -f ~/.juneclaw/logs/daemon.log
tail -f ~/.juneclaw/logs/daemon.err
```

## Architecture

```
iMessage (imsg CLI)
    ↕
  daemon.ts (poll loop)
    ↓
  memory/loader.ts → system prompt
    ↓
  agent/runner.ts → claude --print
    ↓
  iMessage reply + daily log
```

## State files

- `~/.juneclaw/sessions.json` — Claude session IDs (for `--resume`)
- `~/.juneclaw/last-seen.json` — Last processed iMessage ID
- `~/.juneclaw/logs/` — Daemon stdout/stderr logs
