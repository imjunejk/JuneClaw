# 광수 시스템 — Claude Code 행동 규칙

## 프로젝트 구조
- `/Users/jp/JuneClaw` — AI 에이전트 게이트웨이 (Node.js + iMessage)
- `/Users/jp/gwangsu/algo` — 트레이딩 알고리즘 (Python + Alpaca)

## 리모트 컨트롤 열기
```bash
jc rc               # claude --dangerously-skip-permissions + /remote-control (tmux attach)
```
데몬이 RC를 유지하지 않음. 필요할 때만 이 명령으로 수동 오픈.

## 사륙 V8 전략 (동적 5단계 Inverse Safety)
SoT: `portfolio_manager.py:62-77` `SEPA_WEIGHT_BY_DAYS`. 백테스트: CAGR 38.9% | Sharpe 1.452 | MDD -30.6%

QQQ 200SMA 연속 상회일수 기반:
- 10일+ → AgiTQ 15% / SEPA 85% (공격)
- 5일+  → AgiTQ 20% / SEPA 80%
- 3일+  → AgiTQ 30% / SEPA 70%
- 2일+  → AgiTQ 40% / SEPA 60%
- 1일/BEAR → AgiTQ 50% / SEPA 50% (SGOV 피난)

- AgiTQ: TQQQ 200SMA 2일확인 + BTC 필터 + VIX 필터 (25/35) + 익절 20%
- SEPA V8: TT 8/8 + 점수가중 + 섹터분산 + 품질필터 + Chandelier + Ratchet
- 매매: portfolio_manager.py 유일한 매매 주체
- CB: WARN -5% / HALT -7% / EMERG -10% (마진 1.10/1.05/1.02)
- 크론: 06:15 SEPA scan / 06:31 alert / 12:55 sepa-check / 12:57 AgiTQ / 12:58 sepa-execute / 13:02 followup | 월 06:20 리밸런싱
