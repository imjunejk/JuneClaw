---
name: 광수 시스템 구조
description: JuneClaw + gwangsu/algo 두 프로젝트의 전체 구조와 육사 전략.
type: project
---

## Repos
- `/Users/jp/JuneClaw` — AI agent gateway (Node.js + iMessage)
- `/Users/jp/gwangsu/algo` — Trading algorithm (Python + Alpaca)

## 육사 전략 (AgiTQ 60% + SEPA 40%)
- AgiTQ: TQQQ 200일선 3구간 (하락→SGOV / 집중투자→TQQQ / 과열→SPY)
- SEPA: TT 8/8 개별주식 + ETF, VCP v2.0, QQQ 기반 단계적 마진
- 매매: portfolio_manager.py가 유일한 매매 주체
- AGITQ_SYMBOLS: {TQQQ, SGOV, SPY}

## 크론 (PT)
- 월 06:20 리밸런싱 | 06:25 SEPA 스캔 | 06:35 SEPA 체결
- 12:50 AgiTQ 준비 | 12:57 AgiTQ 실행 | 13:02 followup
