---
name: Claude CLI / 리모트 컨트롤 실행 규칙
description: 리모트 컨트롤 열기 — tmux send-keys로 /remote-control 실행 후 웹 링크 제공.
type: feedback
---

"클로드 열어줘" 요청 시:
```bash
tmux send-keys -t juneclaw-rc "/remote-control" Enter
sleep 5
tmux capture-pane -t juneclaw-rc -p -S -30 | grep "claude.ai/code/session"
```
웹 링크를 유저에게 전달.
