# OMC × Paperclip 합체 분석 — 비주얼 에이전트 컨트롤 플레인

> **분석일**: 2026-04-15  
> **기반**: oh-my-claudecode v4.11.6 + Paperclip v0.3.1  
> **목적**: 두 시스템의 상보성 분석 → 합체 아키텍처 설계

---

## 1. 두 시스템은 서로 다른 레이어다

### 핵심 발견: 이 둘은 경쟁이 아닌 **상보 관계**

```
┌─────────────────────────────────────────────────────────────┐
│  PAPERCLIP = 조직 레이어 (Company-level Control Plane)        │
│  "AI 직원들로 구성된 회사를 운영한다"                            │
│  에이전트 고용/해고, 예산, 승인, 태스크 할당, 감사 추적           │
│  PostgreSQL, REST API, React UI, 하트비트 스케줄링              │
├─────────────────────────────────────────────────────────────┤
│  OMC = 세션 레이어 (Session-level Orchestration)               │
│  "AI 직원 한 명이 일하는 방식을 극대화한다"                      │
│  19개 전문 에이전트, 매직 키워드, 지속 실행, 팀 병렬화            │
│  Hook, MCP Tools, 스킬 마크다운, 상태 관리                     │
└─────────────────────────────────────────────────────────────┘
```

| 차원 | Paperclip | OMC |
|------|-----------|-----|
| **범위** | 조직 전체 (N 에이전트, M 태스크) | 단일 세션 (1 에이전트, 내부 위임) |
| **시간** | 하트비트 간격 (분~시간) | 세션 내 (초~분) |
| **데이터** | PostgreSQL 68 테이블 | JSON 파일 (.omc/state/) |
| **UI** | React 웹앱 (대시보드, 이슈 보드) | 터미널 (HUD 상태바) |
| **거버넌스** | 승인 게이트, 예산 하드스탑, 감사 로그 | 없음 (세션 레벨) |
| **에이전트 모델** | 어댑터 (Claude, Codex, Gemini, Cursor) | Claude 전용 (Task 위임) |
| **비용 제어** | 2단계 예산 (소프트 80%/하드 100%) | 3-티어 모델 라우팅 (비용 최적화) |
| **실행 보장** | 하트비트 재시도 + 고아 감지 | persistent-mode (Stop 차단) |

---

## 2. 합체의 핵심 가치

### "Paperclip이 회사를 운영하고, OMC가 각 직원의 능력을 극대화한다"

```
지금:
  Paperclip → Claude Code (vanilla) → 결과
  
합체 후:
  Paperclip → Claude Code + OMC → 19개 전문 에이전트, 자동 계획, 
  팀 모드, 검증 루프, 지속 실행 → 10배 더 좋은 결과
```

**구체적 시나리오:**
1. Paperclip이 "인증 모듈 리팩토링" 이슈를 Agent-1에게 할당
2. Agent-1의 Claude Code 세션이 시작됨 (OMC 플러그인 활성화)
3. OMC의 autopilot이 자동으로:
   - analyst → 요구사항 분석
   - planner → 계획 수립 (critic 검증)
   - executor → 구현 (verifier 검증)
   - code-reviewer + security-reviewer → 최종 리뷰
4. 결과가 Paperclip에 보고됨 (비용, 토큰, 상태)
5. Paperclip의 승인 게이트 → 시니어 에이전트가 리뷰
6. 승인 → Paperclip이 이슈를 done으로 이동

---

## 3. 상보적 매핑 — 무엇이 어디서 연결되나

### 3.1 스킬 시스템 통합

| Paperclip | OMC | 합체 방식 |
|-----------|-----|----------|
| `company_skills` 테이블 (DB 저장) | `skills/*/SKILL.md` (파일 저장) | Paperclip이 스킬을 DB에서 관리 → 실행 시 OMC 형식으로 변환해서 주입 |
| 스킬 소스: local, github, skills_sh | 스킬 소스: 파일, 매직 키워드 | Paperclip의 다양한 소스 → OMC의 SKILL.md 형식으로 머티리얼라이즈 |
| `syncSkills()` 어댑터 메서드 | `skill-injector.mjs` 훅 | 어댑터가 OMC 스킬을 Paperclip DB와 동기화 |

**구현**: Claude 어댑터의 `syncSkills()`가 OMC의 skills/ 디렉토리를 스캔해서 Paperclip DB에 등록. 실행 시 Paperclip DB의 스킬을 OMC 형식으로 변환.

### 3.2 에이전트 조직도 ↔ OMC 에이전트 티어

| Paperclip 역할 | OMC 에이전트 | 합체 매핑 |
|---------------|------------|----------|
| CEO | planner (Opus) | 전략 결정, 계획 수립 |
| Senior Engineer | architect + code-reviewer (Opus) | 설계, 리뷰, 합의 |
| Engineer | executor + debugger (Sonnet) | 구현, 디버깅 |
| Contractor | explore + writer (Haiku) | 탐색, 문서 |

**구현**: Paperclip의 `agent.role`에 따라 OMC의 기본 실행 모드를 자동 설정:
```
CEO → /ralplan (합의 기획) 기본 모드
Senior → /ralph (검증 루프) 기본 모드  
Engineer → /autopilot (자율 실행) 기본 모드
Contractor → /ultrawork (병렬 실행) 기본 모드
```

### 3.3 거버넌스 통합

| Paperclip 거버넌스 | OMC 대응 | 합체 |
|-------------------|---------|------|
| 승인 게이트 | 없음 | OMC 세션 완료 → Paperclip 승인 게이트 트리거 |
| 예산 하드스탑 | 3-티어 라우팅 | Paperclip 예산 → OMC 모델 라우팅 제약 (예산 50% 이하 → Haiku 우선) |
| 감사 로그 | .omc/logs/ | OMC 세션 로그 → Paperclip activity_log 테이블 |
| 다단계 실행 정책 | 없음 | execution → review → approval 파이프라인에 OMC 에이전트 매핑 |

### 3.4 비용 추적 통합

```
OMC 세션 내:
  - 3-티어 라우팅으로 불필요한 Opus 사용 방지
  - background-tasks로 빌드/테스트 병렬화 (토큰 절약)
  
Paperclip 레벨:
  - cost_events API로 세션별 토큰 사용량 보고
  - 에이전트별, 프로젝트별 예산 강제
  - 2단계 방어 (80% 경고, 100% 자동 정지)

합체:
  OMC가 각 에이전트 위임의 토큰을 추적 →
  세션 종료 시 Paperclip cost_events로 일괄 보고 →
  Paperclip이 회사 전체 비용 대시보드 표시
```

### 3.5 UI 통합 — Paperclip의 React UI + OMC 시각화

**Paperclip이 이미 가진 것:**
- 이슈 보드, 에이전트 대시보드, 비용 차트
- 실시간 WebSocket 업데이트
- 플러그인 UI 슬롯 시스템

**OMC가 추가하는 것:**
- 세션 내 에이전트 위임 트리 (어떤 에이전트가 어떤 하위 에이전트를 호출했는지)
- 실시간 스킬 실행 상태 (autopilot Phase 표시)
- 팀 모드 워커 현황 (tmux 패인 상태)
- 매직 키워드 활성화 이력

**구현**: Paperclip 플러그인으로 OMC 대시보드 구현:
```typescript
// paperclip-plugin-omc/manifest.ts
{
  id: "paperclip.omc-dashboard",
  capabilities: ["issues.read", "agents.read", "events.subscribe", "ui.dashboardWidget.register", "ui.detailTab.register"],
  ui: {
    slots: [
      { type: "dashboardWidget", key: "omc-overview" },
      { type: "detailTab", key: "omc-session", entityType: "issue" }
    ]
  }
}
```

---

## 4. 합체 아키텍처

### 4.1 전체 구조

```
┌─────────────────────────────────────────────────────────────────┐
│  PAPERCLIP CONTROL PLANE                                         │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐      │
│  │ React UI   │  │ REST API     │  │ PostgreSQL (68 tbl)  │      │
│  │ + OMC      │  │ + Heartbeat  │  │ + cost_events       │      │
│  │   Plugin   │  │   Engine     │  │ + agent_sessions    │      │
│  └──────┬─────┘  └──────┬───────┘  └─────────────────────┘      │
│         │               │                                        │
│         │   ┌───────────┴──────────────┐                         │
│         │   │  CLAUDE ADAPTER (강화)     │                         │
│         │   │  + OMC 플러그인 자동 설치   │                         │
│         │   │  + 스킬 동기화             │                         │
│         │   │  + 비용 보고              │                         │
│         │   │  + 세션 상태 매핑          │                         │
│         │   └───────────┬──────────────┘                         │
│         │               │                                        │
├─────────│───────────────│────────────────────────────────────────┤
│         │               ▼                                        │
│  ┌──────┴────────────────────────────────────────────┐           │
│  │  CLAUDE CODE SESSION (OMC 강화)                    │           │
│  │  ┌─────────────────────────────────────────────┐  │           │
│  │  │  OMC PLUGIN                                  │  │           │
│  │  │  ├── Hooks (keyword-detector, persistent)    │  │           │
│  │  │  ├── 19 Agents (analyst→executor→verifier)   │  │           │
│  │  │  ├── Skills (autopilot, ralph, team...)      │  │           │
│  │  │  ├── MCP Tools (LSP, AST, Python REPL)      │  │           │
│  │  │  └── Paperclip Bridge Hook (NEW)             │  │           │
│  │  │      ├── 비용 이벤트 전송                       │  │           │
│  │  │      ├── 상태 업데이트 전송                     │  │           │
│  │  │      └── 승인 요청 전송                        │  │           │
│  │  └─────────────────────────────────────────────┘  │           │
│  └───────────────────────────────────────────────────┘           │
│                                                                   │
│  OMC-ENHANCED CLAUDE CODE SESSION                                 │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 Paperclip Bridge Hook — 핵심 연결 조각

```javascript
// OMC 쪽: scripts/paperclip-bridge.mjs (새로 추가)
// 이벤트: PostToolUse, Stop, SessionEnd

const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_RUN_ID = process.env.PAPERCLIP_RUN_ID;
const PAPERCLIP_TASK_ID = process.env.PAPERCLIP_TASK_ID;

// PostToolUse: 에이전트 위임 비용 추적
if (input.tool_name === 'Task') {
  await fetch(`${PAPERCLIP_API_URL}/api/cost-events`, {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      'X-Paperclip-Run-Id': PAPERCLIP_RUN_ID 
    },
    body: JSON.stringify({
      agentId: process.env.PAPERCLIP_AGENT_ID,
      companyId: process.env.PAPERCLIP_COMPANY_ID,
      issueId: PAPERCLIP_TASK_ID,
      costCents: estimatedCost,
      costMetadata: { model, inputTokens, outputTokens, omcAgent: subagentType }
    })
  });
}

// Stop: 세션 결과를 Paperclip에 보고
if (input.stop_reason) {
  await fetch(`${PAPERCLIP_API_URL}/api/issues/${PAPERCLIP_TASK_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` },
    body: JSON.stringify({
      status: allTasksComplete ? 'review' : 'in_progress',
      comment: { body: sessionSummary }
    })
  });
}
```

### 4.3 Claude 어댑터 강화 — OMC 자동 활성화

```typescript
// Paperclip 쪽: adapters/claude-local/src/server/execute.ts 수정

async function execute(ctx: AdapterExecutionContext) {
  const args = [
    'claude', '--print', '-', '--output-format', 'stream-json',
    '--verbose'
  ];
  
  // OMC 플러그인 자동 활성화
  if (ctx.config.enableOmc !== false) {
    args.push('--plugin-dir', getOmcPluginPath());
  }
  
  // OMC 스킬 동기화: Paperclip DB → OMC 형식
  if (ctx.config.enableOmc) {
    await syncSkillsToOmc(ctx);
  }
  
  // Paperclip 환경변수 + OMC 환경변수 병합
  const env = {
    ...paperclipEnv,
    // OMC가 Paperclip 환경을 인식하도록
    OMC_PAPERCLIP_ENABLED: '1',
    OMC_PAPERCLIP_API_URL: ctx.config.paperclipApiUrl,
    OMC_PAPERCLIP_AGENT_ROLE: ctx.agent.role,
  };
  
  return spawnClaude(args, env, ctx);
}
```

---

## 5. 구현 로드맵

### Phase 1: 최소 통합 (1-2주)

**OMC를 Paperclip의 Claude 어댑터에 연결**

1. Paperclip의 `claude_local` 어댑터에 `--plugin-dir` 플래그 추가
2. OMC 플러그인 경로를 어댑터 설정에 추가
3. Paperclip 환경변수를 OMC 세션에 전달
4. OMC의 PostToolUse 훅에서 Paperclip cost_events API 호출

**결과**: Paperclip이 OMC 강화된 Claude Code를 실행. 비용이 Paperclip에 보고됨.

### Phase 2: 양방향 통신 (2-3주)

**OMC ↔ Paperclip 실시간 연동**

1. OMC Paperclip Bridge Hook 구현 (비용, 상태, 승인)
2. Paperclip의 스킬 DB → OMC 스킬 형식 변환기
3. Paperclip의 `agent.role` → OMC 기본 실행 모드 매핑
4. OMC 세션 로그 → Paperclip activity_log

**결과**: 세션 중에도 Paperclip 대시보드에서 실시간 상태 확인. 에이전트 역할에 맞는 자동 모드 선택.

### Phase 3: 시각화 플러그인 (3-4주)

**Paperclip 플러그인으로 OMC 대시보드 구현**

1. `paperclip-plugin-omc` 플러그인 개발
2. 대시보드 위젯: 활성 세션, 에이전트 위임 트리, 비용 추적
3. 이슈 상세 탭: OMC 세션 히스토리, 스킬 실행 로그
4. 에이전트 상세 탭: OMC 설정, 모델 라우팅 현황

**결과**: Paperclip UI에서 OMC의 모든 동작을 시각적으로 모니터링.

### Phase 4: 거버넌스 통합 (4-5주)

**Paperclip의 거버넌스 → OMC 세션 제약**

1. 예산 연동: Paperclip 예산 잔량 → OMC 모델 라우팅 제약
2. 승인 게이트: OMC 세션 완료 → Paperclip 승인 워크플로우
3. 다단계 실행 정책: execution(OMC executor) → review(OMC code-reviewer) → approval(Paperclip board)
4. 조직도 연동: Paperclip의 reportsTo → OMC의 에스컬레이션 경로

---

## 6. 기술적 도전과 해결책

### 6.1 세션 상태 동기화

**문제**: OMC는 파일 기반 (.omc/state/), Paperclip은 PostgreSQL. 어떻게 동기화?

**해결**: Paperclip의 `agent_task_sessions` 테이블이 OMC 세션 상태를 저장.
```
실행 시작 → Paperclip이 이전 OMC 상태를 .omc/state/에 복원
실행 종료 → OMC 상태를 Paperclip DB에 직렬화
```

Paperclip의 `sessionCodec`이 이미 이 패턴을 지원:
```typescript
sessionCodec: {
  serialize: (result) => ({
    sessionId: result.sessionId,
    omcState: readOmcState(),  // .omc/state/ 전체 스냅샷
  }),
  deserialize: (params) => {
    restoreOmcState(params.omcState);  // DB → 파일 복원
    return params;
  }
}
```

### 6.2 프롬프트 캐시와 OMC CLAUDE.md 충돌

**문제**: Paperclip의 `--append-system-prompt-file`과 OMC의 CLAUDE.md 주입이 중복될 수 있음.

**해결**: OMC 플러그인 모드에서는 CLAUDE.md를 Paperclip의 `agent-instructions.md`에 병합:
```
Paperclip agent-instructions.md
  + OMC CLAUDE.md 내용 (에이전트 카탈로그, 스킬 목록)
  + Paperclip 컨텍스트 (회사, 조직도, 할당 태스크)
  = 단일 시스템 프롬프트
```

### 6.3 비용 이중 계산 방지

**문제**: OMC의 하위 에이전트 위임은 Claude Code 내부에서 일어나므로 Paperclip이 직접 보지 못함.

**해결**: 
- Claude의 `stream-json` 출력에서 `usage` 필드가 **세션 전체 누적**
- Paperclip이 세션 종료 시 이 누적값을 사용 → 이중 계산 없음
- OMC의 세부 비용 (에이전트별)은 보조 메트릭으로만 기록

### 6.4 팀 모드와 하트비트 충돌

**문제**: OMC의 팀 모드는 tmux 워커를 spawn하는데, Paperclip도 에이전트를 관리.

**해결**: OMC 팀 모드는 **세션 내부** 병렬화 (Claude → Claude/Codex/Gemini 워커). Paperclip은 **세션 간** 병렬화 (Agent-1, Agent-2가 다른 이슈). 충돌 없음.

단, OMC 팀 워커의 비용도 Paperclip에 보고되어야 함 → Bridge Hook이 팀 워커 생성/종료도 추적.

---

## 7. 핵심 인사이트

### 7.1 "오케스트레이션의 2레벨 이론"

```
Level 1 (Paperclip): WHO does WHAT — 어떤 에이전트가 어떤 태스크를
Level 2 (OMC): HOW to do it — 에이전트가 어떻게 일하는지

대부분의 프로젝트는 한 레벨만 해결:
- Paperclip만: 에이전트가 vanilla Claude Code로 작업 → 품질 한계
- OMC만: 단일 세션은 강력하지만 조직적 관리 불가

합체: 양쪽 문제를 동시에 해결
```

### 7.2 비용 제어의 시너지

```
Paperclip 단독: 에이전트 전체 비용만 추적 (블랙박스)
OMC 단독: 세션 내 모델 라우팅 최적화 (조직 수준 부재)

합체:
- Paperclip이 에이전트별 월간 예산 설정 ($100/월)
- OMC가 세션 내에서 Haiku/Sonnet/Opus 자동 라우팅으로 30-50% 절약
- 예산 50% 소진 → OMC에 "비용 절약 모드" 신호 → Opus 사용 제한
- 예산 80% → Paperclip 경고 + OMC가 Haiku 우선 전환
- 예산 100% → Paperclip 하드스탑

결과: 예산 내에서 최대 품질의 작업 자동 수행
```

### 7.3 거버넌스 + 품질의 결합

```
지금의 문제:
- Paperclip은 결과물의 품질을 모름 (어댑터가 exit 0이면 성공)
- OMC는 조직 정책을 모름 (누가 승인해야 하는지)

합체 후:
1. OMC의 code-reviewer가 코드 품질 판정 (APPROVE/REJECT)
2. 이 결과가 Paperclip의 execution_decisions에 기록
3. Paperclip의 다단계 정책에 따라:
   - OMC reviewer APPROVE + Paperclip auto-approve → done
   - OMC reviewer APPROVE + Paperclip manual review → 보드 승인 대기
   - OMC reviewer REJECT → 자동 재실행

코드 품질이 거버넌스 파이프라인에 자동 통합됨
```

### 7.4 Paperclip의 "문제를 숨기지 마라" + OMC의 "The Boulder Never Stops"

```
이 두 철학은 완벽하게 상호보완:

Paperclip: "실패하면 가시적으로 드러내라" (auto-recovery 최소화)
OMC: "완료될 때까지 멈추지 마라" (persistent-mode)

합체:
- OMC가 세션 내에서 끝까지 밀어붙임 (ralph 루프)
- 그래도 실패하면 Paperclip이 가시적으로 blocked 표시
- 보드가 확인하고 다음 조치 결정

= "최선을 다하되, 실패하면 숨기지 마라"
```

### 7.5 스킬 에코시스템의 확장

```
Paperclip의 스킬 소스: local, github, skills_sh, builtin, project scan
OMC의 스킬 소스: 파일 (skills/*/SKILL.md), 매직 키워드, 학습 (/learner)

합체:
- Paperclip이 스킬의 "레지스트리" (DB 저장, 버전 관리, 신뢰 수준)
- OMC가 스킬의 "런타임" (실행, 주입, 에이전트 위임)
- GitHub/skills.sh 스킬 → Paperclip DB → OMC SKILL.md 형식 → 세션에 주입
- OMC의 /learner가 추출한 스킬 → Paperclip DB에 저장 → 다른 에이전트도 사용

= 조직 전체의 지식이 자동으로 축적되고 공유됨
```

---

## 8. 우리(JuneClaw)에게 의미하는 것

### JuneClaw 특화 응용

```
JuneClaw = AI 에이전트 게이트웨이 (iMessage)
gwangsu-algo = 트레이딩 알고리즘

Paperclip 패턴 적용:
- "Company" = JuneClaw 시스템
- "Agent: CEO" = 메인 June 에이전트 (OMC planner 모드)
- "Agent: Trader" = gwangsu-algo 연동 에이전트 (OMC executor 모드)
- "Agent: Analyst" = 시장 분석 에이전트 (OMC analyst 모드)

거버넌스:
- 매매 승인 게이트 (금액 임계값 초과 시)
- 월간 거래 예산 (하드스탑)
- 포트폴리오 변경 감사 로그

하트비트:
- 06:20 리밸런싱 → Paperclip 하트비트
- 12:57 AgiTQ → Paperclip 하트비트  
- 각 하트비트에서 OMC가 분석→계획→실행→검증
```

### 핵심: 지금 당장 할 수 있는 것

1. **OMC 플러그인 설치** → Claude Code 세션 즉시 강화 (0 비용)
2. **Paperclip 로컬 설치** → `pnpm dev`로 즉시 컨트롤 플레인 (내장 PostgreSQL)
3. **Claude 어댑터에 --plugin-dir 추가** → OMC + Paperclip 최소 통합
4. **Paperclip Bridge Hook** → 비용 보고 + 상태 동기화

---

## 부록: 파일 맵 — 합체 시 수정/생성 필요한 파일

| 위치 | 파일 | 변경 | 목적 |
|------|------|------|------|
| OMC | `scripts/paperclip-bridge.mjs` | 생성 | Paperclip 연동 Hook |
| OMC | `hooks/hooks.json` | 수정 | PostToolUse/Stop에 bridge hook 추가 |
| OMC | `src/config/loader.ts` | 수정 | PAPERCLIP_* 환경변수 인식 |
| Paperclip | `adapters/claude-local/execute.ts` | 수정 | --plugin-dir 플래그 추가 |
| Paperclip | `adapters/claude-local/config-schema.ts` | 수정 | OMC 관련 설정 필드 |
| Paperclip | `plugins/omc-dashboard/` | 생성 | OMC 시각화 플러그인 |
| Paperclip | `server/src/services/heartbeat.ts` | 수정 | OMC 세션 상태 복원/저장 |

---

> **결론**: OMC와 Paperclip은 서로 다른 레이어의 문제를 해결한다. OMC는 "하나의 에이전트가 최고의 작업을 하게 만드는 것", Paperclip은 "여러 에이전트를 조직적으로 관리하는 것". 합체하면 **조직적으로 관리되면서 각 에이전트가 최고 성능을 내는** 시스템이 된다. 최소 통합은 Claude 어댑터에 `--plugin-dir` 한 줄 추가로 시작할 수 있다.
