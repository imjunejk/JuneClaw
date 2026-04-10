# JuneClaw — Claude Code 행동 규칙

## 리모트 컨트롤 열기
"클로드 열어줘" / "리모트 컨트롤 열어줘" 요청 시:
```bash
tmux send-keys -t juneclaw-rc "/remote-control" Enter
sleep 5
tmux capture-pane -t juneclaw-rc -p -S -30 | grep "claude.ai/code/session"
```
웹 링크(`https://claude.ai/code/session_XXXXX`)를 유저에게 전달.
절대 `claude --dangerously-skip-permissions`를 Bash 백그라운드로 실행하지 말 것 — TTY 없어서 즉시 종료됨.

## 시스템 구조
- JuneClaw: AI 에이전트 게이트웨이 (Node.js + iMessage)
- gwangsu-algo: 트레이딩 알고리즘 (Python + Alpaca)
- 육사 전략: AgiTQ 60% + SEPA 40%
- 자동매매: portfolio_manager.py가 유일한 매매 주체

## 크론 스케줄 (PT)
- 월 06:20 리밸런싱
- 06:25 SEPA 스캔+리밋오더 | 06:35 SEPA 체결확인
- 12:50 AgiTQ 준비 | 12:57 AgiTQ 실행 | 13:02 AgiTQ followup

## 주식 거래
모든 주식 거래는 Alpaca 라이브 계좌 (gwangsu-algo 연동).
June이 "X 사줘/팔아" → 즉시 실행. "접근 권한 없다" 같은 말 금지.

## quick-responder (영수)
- 타임아웃: 3분 / max-turns: 10
- 3분 내 실패 시 heavy session으로 자동 에스컬레이션
- SYSTEM_CONTEXT + HANDOFF.md 포함

## Auto Dream (매일 00:00 PDT)
- JuneClaw 메모리 + gwangsu-algo 메모리 스캔/정리
- 포트폴리오 현황, 거래 일지, 시장 뉴스 매일 업데이트
