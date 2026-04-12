# 광수 시스템 — Claude Code 행동 규칙

## 프로젝트 구조
- `/Users/jp/JuneClaw` — AI 에이전트 게이트웨이 (Node.js + iMessage)
- `/Users/jp/gwangsu-algo` — 트레이딩 알고리즘 (Python + Alpaca)

## 리모트 컨트롤 열기
```bash
jc rc               # claude --dangerously-skip-permissions + /remote-control (tmux attach)
```
데몬이 RC를 유지하지 않음. 필요할 때만 이 명령으로 수동 오픈.

## 육사 전략 (AgiTQ 60% + SEPA 40%)
- AgiTQ: TQQQ 200일선 3구간 (하락→SGOV / 집중투자→TQQQ 2일확인 / 과열→SPY)
- SEPA: TT 8/8 + VCP v2.0, QQQ 기반 단계적 마진
- 매매: portfolio_manager.py 유일한 매매 주체
- 크론: 06:25/06:35 SEPA | 12:50/12:57/13:02 AgiTQ | 월 06:20 리밸런싱
