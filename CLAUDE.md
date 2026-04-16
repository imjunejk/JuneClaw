# JuneClaw — Claude Code 행동 규칙

## 리모트 컨트롤 열기
"클로드 코드 열어줘" / "리모트 컨트롤 열어줘" 요청 시 `jc rc` 사용:
```bash
jc rc               # claude --dangerously-skip-permissions + /remote-control 자동 실행 (tmux attach)
```
내부 동작: tmux 세션 `jc-rc`에서 Claude CLI를 띄우고 `/remote-control` 슬래시 커맨드를 자동으로 전송 후 attach.
세션이 이미 있으면 attach만. 데몬이 RC를 백그라운드에서 유지하지 않으므로, 필요할 때만 이 명령으로 수동 오픈.

## 시스템 구조
- JuneClaw: AI 에이전트 게이트웨이 (Node.js + iMessage)
- gwangsu/algo: 트레이딩 알고리즘 (Python + Alpaca)
- 육사 전략: AgiTQ 60% + SEPA 40%
- 자동매매: portfolio_manager.py가 유일한 매매 주체

## 크론 스케줄 (PT)
- 월 06:20 리밸런싱
- 06:25 SEPA 스캔+리밋오더 | 06:35 SEPA 체결확인
- 12:50 AgiTQ 준비 | 12:57 AgiTQ 실행 | 13:02 AgiTQ followup

## 주식 거래
모든 주식 거래는 Alpaca 라이브 계좌 (gwangsu/algo 연동).
June이 "X 사줘/팔아" → 즉시 실행. "접근 권한 없다" 같은 말 금지.

## quick-responder (영수)
- 타임아웃: 3분 / max-turns: 10
- 3분 내 실패 시 heavy session으로 자동 에스컬레이션
- SYSTEM_CONTEXT + HANDOFF.md 포함

## Auto Dream (매일 00:00 PDT)
- JuneClaw 메모리 + gwangsu/algo 메모리 스캔/정리
- 포트폴리오 현황, 거래 일지, 시장 뉴스 매일 업데이트

## 테스팅 컨벤션 (Vitest)
- 테스트 파일: `src/**/*.test.ts` — 구현 파일 옆에 코로케이트 (`foo.ts` ↔ `foo.test.ts`)
- 실행: `npm test` (1회) / `npm run test:watch` (TDD) / `npm run test:coverage`
- 유닛 테스트는 네트워크·파일시스템·서브프로세스 금지. 외부 I/O는 `vi.stubGlobal("fetch", ...)` 같은 스텁으로 대체.
- 통합 테스트 (차후): `src/**/*.int.test.ts` — `INTEGRATION=1` 게이트.
- 모듈 로드 시 캡처되는 env var가 있으면 `src/test-setup.ts`에서 미리 세팅 (예: `HUSTLE_*`).
- 커버리지 threshold는 현재 수준보다 약간 낮게 핀 — 회귀 방지용. 테스트 늘릴 때 올리고, 떨어뜨려서 PR 통과시키지 말 것.
- CI: `.github/workflows/ci.yml` — PR 마다 typecheck + build + test + coverage 실행.
