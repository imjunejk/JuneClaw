---
name: Claude CLI / 리모트 컨트롤 실행 규칙
description: "클로드 코드 열어줘" 요청 시 `jc rc`로 tmux 세션 생성 + /remote-control 자동 실행.
type: feedback
---

"클로드 코드 열어줘" / "리모트 컨트롤 열어줘" 요청 시:
```bash
jc rc               # claude --dangerously-skip-permissions + /remote-control 자동 실행 (tmux attach)
```

**Why:** 2026-04-11에 데몬이 remote-control을 백그라운드로 유지하는 시스템을 폐기함. 이제 필요할 때만 사용자가 `jc rc` 명령으로 tmux 세션에서 Claude CLI를 수동 오픈하고 /remote-control 슬래시 커맨드를 자동 실행.

**How to apply:** 해당 요청이 오면 `jc rc`를 실행. 이미 세션이 있으면 자동으로 attach. 웹 링크(`https://claude.ai/code/session_XXXXX`)는 세션 안에서 사용자가 직접 확인.
