# 육사 전략 — AgiTQ 60% + SEPA 40%

## 백테스트 성과
CAGR +28.1% | MDD -34.3% | Sharpe 0.846 | Sortino 1.073

## AgiTQ 60% — TQQQ 200일선 3구간

| 구간 | 조건 | 액션 |
|------|------|------|
| 하락 | TQQQ < 200 SMA | 전량 매도 → SGOV |
| 집중투자 | SMA < TQQQ < SMA+5% | SGOV → TQQQ 풀매수 (2일 확인) |
| 과열 | TQQQ > SMA+5% | 기존 홀드, 신규 → SPY |

- 매수: 200SMA 위 2일 연속 확인 후 Day2 (기대값 +10.7%)
- 매도: 200SMA 아래 이탈 즉시 (하루도 안 기다림)
- 스탑: 없음 (200 SMA가 유일한 매도 신호)
- 익절: +10/25/50% 소익절→SPY, +100/200% 대익절→SPY

## SEPA 40% — 미너비니 개별주식

- TT 8/8 Strict (SEPA BREAKOUT이면 7/8 허용)
- VCP v2.0 (동적 2-5 contraction) + SEPA Radar 연동
- QQQ 기반 단계적 마진:
  - 2일: 1x (무마진 진입)
  - 3일+: 2x (마진 공격)
- -10% 하드 스탑
- 동적 유니버스 100+ 종목 (Alpaca Most Actives)
- ETF + 저가 모멘텀주 포함

## 스케줄 (PT)

| 시간 | 전략 | 모드 |
|------|------|------|
| 월 06:20 | 리밸런싱 | 60/40 드리프트 체크 |
| 06:25 | SEPA | 스캔 + Health + 리밋오더 |
| 06:35 | SEPA | 체결확인 + market fallback |
| 12:50 | AgiTQ | 준비 알림 |
| 12:57 | AgiTQ | 실행 (종가 3분전 market) |
| 13:02 | AgiTQ | 미체결 시 limit followup |

## 원본 참고
- 아기티큐 200일선 매매법: https://www.fmkorea.com/9574116857
- 매수/매도 타이밍 검증: https://www.fmkorea.com/9581918670
