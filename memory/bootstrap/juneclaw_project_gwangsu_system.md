---
name: 광수 시스템 구조
description: JuneClaw + gwangsu/algo 두 프로젝트의 전체 구조와 사륙 V8 동적 5단계 전략.
type: project
---

## Repos
- `/Users/jp/JuneClaw` — AI agent gateway (Node.js + iMessage)
- `/Users/jp/gwangsu/algo` — Trading algorithm (Python + Alpaca)

## 사륙 V8 전략 — 동적 5단계 Inverse Safety
QQQ 200SMA 연속 상회일수 기반 비중 자동 조절. SoT: `portfolio_manager.py:62-77`.
백테스트 베이스라인 (174종목): CAGR 38.9% | Sharpe 1.452 | MDD -30.6%

| 연속일수 | AgiTQ | SEPA |
|---|---|---|
| 10일+ | 15% | 85% |
| 5일+ | 20% | 80% |
| 3일+ | 30% | 70% |
| 2일+ | 40% | 60% |
| 1일/BEAR | 50% | 50% |

**SEPA 노티 cap**: $16,000 (env `SEPA_BUDGET_CAP`, 2026-04-28~) — buying-power 에러 회피. 동적 weight × equity > cap 시 cap 적용.

**SEPA deploy throttle (레짐별)**: capped 예산 → 광7 배포 비율 = FULL_BULL/STRONG 100% / WEAK 80% / CAUTION 50% / EARLY 25% / BEAR 0%. 나머지는 cash (SPY/SGOV는 AgiTQ 전담, 이중 관리 회피). env `SEPA_DEPLOY_MULT` uniform 스케일.

로그 식별: "[SEPA 80% × 배포 50% (CAUTION)] 배분: $8,000 / 의도 $16,000".

- AgiTQ: TQQQ 200SMA 2일확인 + BTC 200SMA 필터 + VIX 필터 (25/35) + 익절 20%
- SEPA V8: TT 8/8 + 점수가중 + 섹터분산 + 품질필터 + Chandelier + Ratchet
- 매매: portfolio_manager.py가 유일한 매매 주체
- AGITQ_SYMBOLS: {TQQQ, SGOV, SPY, QQQ}
- 드리프트 임계: 5%p 초과 시 리밸런싱
- 서킷브레이커: WARN -5% / HALT -7% / EMERG -10%

## 크론 (PT)
- 월 06:20 리밸런싱 | 06:15 sepa_radar scan | 06:31 sepa-scan 알림
- 12:50 check | 12:55 sepa-check (리밋) | 12:57 AgiTQ execute | 12:58 sepa-execute (market 전환) | 13:02 AgiTQ followup
- 07:10-12:40 /30min breakout_check | 일 10:30 weekly scan
