# Master Rules v1.1

Last updated: 2026-04-09

## Trading Logic Rules
1. **매매 주문 로직 변경 시 반드시 단위 테스트 작성** — mock order로 price/qty/side 검증. (2026-04-08, VCP 리밋오더 버그 4건)
2. **전략 할당 비율 변경은 1일 1회 이내, 변경 사유 문서화** — 같은 날 3번 변경은 노이즈. (2026-04-08, 70/30→50/50→60/40)
3. **갭/가격 필터는 방향별(up/down) 분리 설계** — 갭업과 갭다운은 시장 의미가 다름. (2026-04-08, 갭업 차단 오류)

## Code Quality Rules
4. **리팩토링 후 `python -c "import module"` 로 import 검증** — NameError 방지. (2026-04-08, drift_from_scan)

## Operations Rules
6. **파라미터 변경은 데이터 분석 후 1회 결정** — 실행 시간, 티커, 비율 등 운영 파라미터는 비교 데이터 수집 후 1회에 확정. 같은 날 3회 이상 변경은 금지. (2026-04-09, AgiTQ 시간 3번 + 티커 3단계)
7. **신규 전략 추가 시 통합 체크리스트 필수** — 기존 매니저/트레이더와의 포지션 인식·주문 충돌·매도 범위를 사전 검증. (2026-04-09, SEPA Manager 충돌)
8. **차단/제한 규칙은 config 파일로 분리** — 코드 내 하드코딩 금지. 리팩토링에도 보존되도록 별도 config 관리. (2026-04-09, tuner override 재발)

## Process Rules
5. **PR 머지 후 항상 `git checkout main && git pull`** — 브랜치 동기화 누락 방지. (기존 피드백)
