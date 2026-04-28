# 사륙 V8 전략 — 동적 5단계 Inverse Safety

## SoT
`gwangsu/algo/strategies/portfolio_manager.py:62-77` `SEPA_WEIGHT_BY_DAYS`.
이 문서는 **참고용**. 실제 비중 계산은 portfolio_manager.py가 수행.

## 핵심 아이디어
QQQ 200SMA 연속 상회일수가 짧을수록 **불확실성 ↑** → AgiTQ(SGOV 피난 가능 자산) 비중 ↑.
연속일수가 길수록 **추세 확신 ↑** → SEPA 종목집중 비중 ↑.
"불확실할 때 안전, 강세일 때 공격" — Inverse Safety 동적 비중.

## 동적 비중 — 5단계
| QQQ 200SMA 연속일수 | 레짐 | AgiTQ | SEPA |
|---|---|---|---|
| 10일+ | FULL_BULL | 15% | **85%** |
| 5일+ | BULL_STRONG | 20% | 80% |
| 3일+ | BULL_WEAK | 30% | 70% |
| 2일+ | CAUTION | 40% | 60% |
| 1일 | EARLY | 50% | 50% |
| BEAR (QQQ < SMA) | BEAR | 50% | 50% |

폴백 기본값: AgiTQ 20% / SEPA 80%. 드리프트 임계 5%p.

### SEPA 노티 cap (2026-04-28~)
`SEPA_BUDGET_CAP=16000` USD (env override, `0`=비활성). 동적 weight × equity > cap 시 capped → `vcp_intent_budget`. 도입 사유: $35K equity × 80% weight = $28K SEPA 책정 → 단일 사이클 drift correction에서 buying-power 에러.

### SEPA deploy throttle (2026-04-28~)
`SEPA_DEPLOY_BY_REGIME` — capped intent 중 광7으로 deploy되는 비율 (레짐별):

| Regime | Days above 200SMA | Deploy frac |
|---|---|---|
| FULL_BULL | 10+ | 1.00 |
| BULL_STRONG | 5+ | 1.00 |
| BULL_WEAK | 3+ | 0.80 |
| CAUTION | 2+ | 0.50 |
| EARLY | 1 | 0.25 |
| BEAR | < SMA | 0.00 |

파이프라인: `equity × vcp_weight → cap → × deploy_frac = vcp_budget` (deploy target). `portfolio_manager.py:analyze_portfolio()`가 SoT, 모든 다운스트림 자동 전파. **나머지 cash로 보유** — SPY/SGOV는 AgiTQ 영역 (AGITQ_SYMBOLS), SEPA 이중 관리 회피. env `SEPA_DEPLOY_MULT` (default 1.0) uniform 스케일링 (0.5 = 모든 레짐 절반). Unknown regime은 1.0 fail-open (로그 확인 필요).

로그 식별: `[SEPA 80% × 배포 50% (CAUTION)] 배분: $8,000 / 의도 $16,000` — weight/deploy/regime 모두 surface.

### AgiTQ buying-power reserve (2026-04-28~)
`agitq_trader.buy_full()`이 SEPA 영역을 침범하지 않도록 `available = max(0, buying_power − SEPA_RESERVE_FOR_AGITQ)`만 사용. default reserve는 `SEPA_BUDGET_CAP` ($16K, env 같이 사용). 12:57 PT AgiTQ market 주문이 12:58 sepa-execute가 쓸 cash를 가져가지 못하도록 보장.

**트레이드오프**: SGOV→TQQQ 같은 AgiTQ 내부 rotation 시 buying_power가 reserve 미만이면 AgiTQ가 축소된 사이즈로만 환매수. AgiTQ 성장은 SEPA가 buying_power를 회수(매도)해야만 가능 — 이게 정확히 정책 의도. env `SEPA_RESERVE_FOR_AGITQ=0`으로 일회성 풀 파워 rotation 가능.

`buy_with_proceeds`는 미적용 (TQQQ 부분 익절 → SPY 환매수에서는 자체 sell 직후 cash라 SEPA와 경쟁 X).

로그: `AgiTQ available $X = buying_power $Y − SEPA reserve $Z`

## 백테스트 베이스라인
174종목 유니버스 (11섹터): CAGR +38.9% | Sharpe 1.452 | MDD -30.6% | OOS Sharpe 1.240

## AgiTQ — TQQQ 200일선 + BTC 필터 + VIX 필터

| 구간 | 조건 | 액션 |
|------|------|------|
| 하락 | TQQQ < 200 SMA | 전량 매도 → SGOV |
| 상승 | TQQQ ≥ 200 SMA | SGOV → TQQQ 풀매수 (2일 확증) |

- 매수: 200SMA 위 2일 연속 확인 후 Day2
- 매도: 200SMA 아래 이탈 즉시
- 익절: +10/25/50% 소익절 20%, +100%+ 대익절 50% → SPY
- 엔벨로프 0% (720-조합 검증)
- BTC 200SMA 보조 레짐 필터
- **VIX 필터**: <25 정상, 25-35 사이즈 50%, ≥35 즉시 퇴출
- AGITQ_SYMBOLS: {TQQQ, SGOV, SPY, QQQ}

## SEPA V8 — 6가지 개선 통합

### 핵심 혁신: 점수가중 포지션 사이징 (V3)
- 각 종목 비중 = (종목 score / 전체 score 합)
- 제한: min 10%, max 35% (과집중 방지)
- 예시 5종목 [score 90, 80, 70, 60, 50] → [26%, 23%, 20%, 17%, 14%]
- **단일 변경으로 CAGR 4.8% → 36.5% (7.6배 개선)**

### 진입 조건
- TT 8/8 Strict (SEPA BREAKOUT이면 TT 7/8 허용)
- VCP v2.0 (동적 2-5 contraction) + 브레이크아웃
- 품질 필터:
  - 일평균 거래대금 ≥ $50M
  - 52주 고점 -25% 이내

### 리스크 관리
- **-10% 하드 스탑** (기본)
- **Chandelier Stop**: 8%+ 상승 후 고점에서 -15%
- **Profit Ratchet**:
  - +25% 도달 → 본전(entry) 스탑
  - +50% 도달 → 이익 50% 락인
- **섹터 분산**: 단일 섹터 max 2 포지션 (반도체는 별도 버킷)

### 레짐별 마진 (MARGIN_BY_REGIME)
- FULL_BULL (10일+): 최대 마진
- BULL_STRONG (5일+): 2.0x
- BULL_WEAK (3일+): 1.5x
- CAUTION (2일+): 1.0x
- EARLY (1일): 1.0x
- BEAR (QQQ < SMA): 0.0x (전량 청산)

## 서킷브레이커

| Level | 트리거 | 행동 |
|-------|--------|------|
| L1 WARN | 일일 -5% or 마진 <1.10x | 마진 1.15x까지 선별 축소 |
| L2 HALT | 일일 -7% or 마진 <1.05x | 마진 1.25x까지 공격 축소 |
| L3 EMERG | 일일 -10% or 마진 <1.02x | 전량 플래튼 + 24h 쿨다운 |

## 스케줄 (PT)

| 시간 | 작업 |
|------|------|
| 월 06:20 | 주간 리밸런싱 (드리프트 5%p 체크) |
| 매일 06:15 | sepa_radar scan |
| 매일 06:31 | sepa-scan 알림 (주문 X) |
| 매일 12:50 | check (장마감 전 상태) |
| 매일 12:55 | sepa-check (리밋 주문) |
| 매일 12:57 | AgiTQ execute (종가 3분전 market) |
| 매일 12:58 | sepa-execute (미체결 market 전환) |
| 매일 13:02 | AgiTQ followup (체결확인 + 애프터 limit) |
| 07:10-12:40 /30min | sepa_radar breakout_check |
| 일 10:30 | sepa_radar weekly scan |

## 검증된 개선 히스토리

| 시점 | 모드 | 백테스트 CAGR |
|------|------|---------------|
| 2026-04-08 | 팔이 (SEPA 80/20 고정) | +28.1% |
| 2026-04-15 | 육사 (60/40 고정) | +29.7% |
| 2026-04-16 | 사륙 V8 (40/60 고정) | +38.9% |
| 2026-04-22+ | **사륙 V8 동적 5단계** | **+38.9%** 베이스라인 (Sharpe 1.212, Calmar 1.433) |

## 원본 참고
- 아기티큐 200일선 매매법: https://www.fmkorea.com/9574116857
- Minervini SEPA 원칙 + 점수가중 포지션 사이징
