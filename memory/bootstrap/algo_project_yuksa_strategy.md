---
name: 육사 전략 (AgiTQ 60% + SEPA 40%)
description: 현재 프로덕션 투자 전략. 3구간 레짐, 매매 규칙, 크론 스케줄.
type: project
---

## 전략 구조
육사 전략 = AgiTQ 60% + SEPA 40%

## AgiTQ 60% — TQQQ 200일선 3구간 레짐
- 하락 (TQQQ < 200SMA): 전량 매도 → SGOV
- 집중투자 (SMA ~ SMA+5%): SGOV → TQQQ 풀매수 (2일 확인)
- 과열 (TQQQ > SMA+5%): 기존 TQQQ 홀드, 신규자금 → SPY
- 매도: SMA 이탈 즉시. 스탑로스 없음.
- 익절: +10/25/50% 소익절(10%→SPY), +100/200% 대익절(50%→SPY)

## SEPA 40% — 미너비니 개별주식
- TT 8/8 Strict (SEPA BREAKOUT이면 7/8 허용)
- VCP v2.0 + SEPA Radar 연동
- QQQ 기반 단계적 마진 (2일 1x, 3일+ 2x)
- -10% 하드 스탑, 최대 5포지션

## 핵심 파일
- strategies/portfolio_manager.py — 총괄 매니저 (유일한 매매 주체)
- strategies/agitq_trader.py — AgiTQ 엔진
- strategies/vcp_margin_trader.py — SEPA 스캔 엔진
