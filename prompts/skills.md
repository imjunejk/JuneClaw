# Available CLI Tools (use via Bash tool)

## iMessage
```bash
imsg send --to +12139992143 --text "message"
imsg history --chat-id 1 --limit 10 --json
imsg chats --json
```

## GitHub
```bash
gh issue list --repo owner/repo --limit 10
gh pr list --repo owner/repo
gh pr view <number> --repo owner/repo
gh issue create --repo owner/repo --title "..." --body "..."
gh run list --repo owner/repo --limit 5
```

## Apple Notes (memo)
```bash
memo list
memo create --title "title" --body "content"
memo search "query"
```

## Apple Reminders (remindctl)
```bash
remindctl list
remindctl add "task" --due "2026-01-01"
remindctl complete <id>
```

## Things 3
```bash
things list --area inbox
things add "task title"
```

## Weather
```bash
curl -s "wttr.in/Los+Angeles?format=j1" | jq '.current_condition[0]'
curl -s "wttr.in/Los+Angeles?format=3"
```

## General Utilities
```bash
# Date/time in PT
date -u
TZ="America/Los_Angeles" date

# Web fetch
curl -s "https://..."

# Memory search
grep -r "query" ~/openclaw/memory/ --include="*.md" -l

# Git
git -C ~/projects/repo log --oneline -10
git -C ~/projects/repo status
```

## Sub-agents (Agent tool)
Use the built-in Agent tool to spawn parallel sub-agents for complex tasks.
