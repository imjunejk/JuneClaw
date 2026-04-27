---
name: 사륙 V8 전략 (동적 5단계 Inverse Safety)
description: 현재 프로덕션 투자 전략. portfolio_manager.py SEPA_WEIGHT_BY_DAYS가 SoT.
type: project
---

## 전략 구조 (2026-04-22+ 동적 5단계 전환)
사륙 V8 = QQQ 200SMA 연속 상회일수 기반 동적 비중 (Inverse Safety).
백테스트 베이스라인: CAGR 38.9% | Sharpe 1.452 | MDD -30.6% | OOS 1.240

**SoT**: `strategies/portfolio_manager.py:62-77` `SEPA_WEIGHT_BY_DAYS`

## 동적 비중 — 5단계
| QQQ 200SMA 연속일수 | AgiTQ | SEPA |
|---|---|---|
| 10일+ (FULL_BULL) | 15% | 85% (공격) |
| 5일+ (BULL_STRONG) | 20% | 80% |
| 3일+ (BULL_WEAK) | 30% | 70% |
| 2일+ (CAUTION) | 40% | 60% |
| 1일/BEAR (EARLY/BEAR) | 50% | 50% (SGOV 피난) |

폴백 기본값: AgiTQ 20% / SEPA 80% (`DEFAULT_AGITQ_WEIGHT=0.20`).
드리프트 임계: 5%p 초과 시 리밸런싱 플래그.

## AgiTQ — TQQQ 200일선 + BTC 필터 + VIX 필터
- 진입: TQQQ > 200SMA 2일 연속 (env 0%)
- 퇴출: 200SMA 이탈 즉시
- 익절: +10/25/50% 소익절 20%, +100%+ 대익절 50% → SPY
- BTC 200SMA 레짐 보조 필터
- VIX 필터: 25-35 사이즈 50%, 35 이상 즉시 퇴출
- AGITQ_SYMBOLS: {TQQQ, SGOV, SPY, QQQ}

## SEPA V8 — 6가지 개선 통합
- **V3 점수가중 포지션**: score 비례 (10-35% 범위) — 단일 혁신 +32% CAGR
- **V2 섹터 분산**: max 2/섹터 (반도체 별도 버킷)
- **V4 품질 필터**: 일평균 거래대금 $50M+, 52주 고점 -25% 이내
- **V5 Chandelier Stop**: 고점 대비 -15% (8%+ 상승 후)
- **V6 Profit Ratchet**: +25% BE, +50% 이익 50% 락인
- **V7 TT 7+ 허용**: SEPA BREAKOUT 신호 있을 때만
- 기본 -10% 하드 스탑 유지

## 레짐별 마진 (MARGIN_BY_REGIME)
- FULL_BULL (10일+): 최대 마진
- BULL_STRONG (5일+): 2.0x
- BULL_WEAK (3일+): 1.5x
- CAUTION (2일+): 1.0x
- EARLY (1일): 1.0x
- BEAR (QQQ < SMA): 0.0x (전량 청산)

## 서킷브레이커
- L1 WARN: 일일 -5% or 마진 <1.10x → 1.15x까지 선별 축소
- L2 HALT: 일일 -7% or 마진 <1.05x → 1.25x까지 공격 축소
- L3 EMERG: 일일 -10% or 마진 <1.02x → 전량 플래튼 + 24h 쿨다운

## 핵심 파일
- `strategies/portfolio_manager.py` — 총괄 매니저, 동적 비중 로직 (SoT)
- `strategies/agitq_trader.py` — AgiTQ 엔진 (VIX 필터 포함)
- `strategies/vcp_margin_trader.py` — SEPA V8 엔진 (V8_* 플래그)
- `strategies/sector_limits.py` — 섹터 한도
- `strategies/circuit_breaker.py` — 선별 축소 CB

## 크론 스케줄 (PT)
- **월 06:20** 리밸런싱 (드리프트 체크)
- **매일 06:15** sepa_radar scan | **06:31** sepa-scan 알림
- **매일 12:50** check | **12:55** sepa-check (리밋) | **12:57** AgiTQ execute | **12:58** sepa-execute (market 전환) | **13:02** AgiTQ followup
- **07:10-12:40 /30min** sepa_radar breakout_check
- **일 10:30** sepa_radar weekly scan
