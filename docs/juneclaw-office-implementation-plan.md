# JuneClaw Office — AI Agent Visual Management System 구현 계획

> **작성일**: 2026-04-15  
> **비전**: 누구나 AI 에이전트 팀을 만들고, 인격을 설정하고, 플로우를 노드로 연결하는 비주얼 앱  
> **기반 분석**: OMC 리버스 엔지니어링 + Paperclip 리버스 엔지니어링 + 합체 분석  
> **프로덕트명**: JuneClaw Office (가칭)

---

## 1. 프로덕트 비전

### 한 줄 정의
> **"AI 에이전트 팀을 비주얼하게 조립하고 운영하는 앱. Figma가 디자인을 민주화했듯, 우리는 AI 오케스트레이션을 민주화한다."**

### 핵심 UX 흐름 (사용자 관점)

```
1. 회원가입 / 로그인 (웹)
2. "팀" 생성 (= Paperclip의 Company)
3. 에이전트 추가
   ├── 프리셋에서 선택 (Developer, Researcher, PM, Designer...)
   └── 커스텀 인격 설정 (이름, 역할, 성격, 전문성, 말투)
4. 워크플로우 캔버스
   ├── 노드: 에이전트, 도구, 조건, 게이트
   ├── 엣지: 데이터 흐름 연결
   └── 실행: 한 클릭으로 전체 플로우 실행
5. 실시간 모니터링 대시보드
   └── 각 에이전트의 진행 상황, 비용, 산출물
```

### Paperclip / OMC에서 가져오는 것 vs 새로 만드는 것

| 컴포넌트 | Paperclip에서 | OMC에서 | 새로 만드는 것 |
|---------|-------------|--------|-------------|
| 에이전트 관리 | 역할, 조직도, 어댑터 | 19개 전문 프롬프트, 실패 모드 | **비주얼 인격 에디터** |
| 워크플로우 | 다단계 실행 정책 | autopilot 5단계, ralph 루프 | **노드 기반 플로우 캔버스** |
| 비용 제어 | 예산 하드스탑 | 3-티어 모델 라우팅 | 통합 비용 대시보드 |
| 태스크 관리 | 이슈 보드, 체크아웃 | PRD 스토리 | 칸반 + 자동 할당 |
| 인증/멀티테넌시 | BetterAuth, company_id | — | **SaaS 멀티테넌트** |
| UI | React 19, Radix | — | **노드 에디터 (React Flow)** |
| 실행 | 하트비트 + 어댑터 | Hook + MCP + Agent SDK | 통합 실행 엔진 |

---

## 2. 아키텍처

### 2.1 전체 구조

```
┌─────────────────────────────────────────────────────────────┐
│  JuneClaw Office — Web App                                    │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  FRONTEND (React 19 + React Flow)                        │ │
│  │  ├── 에이전트 인격 에디터 (비주얼 폼)                       │ │
│  │  ├── 플로우 캔버스 (노드 + 엣지)                           │ │
│  │  ├── 실행 모니터 (실시간 WebSocket)                        │ │
│  │  ├── 팀 대시보드 (비용, 활동, 통계)                        │ │
│  │  └── 칸반 보드 (태스크 관리)                               │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                             │ REST + WebSocket                 │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │  BACKEND (Node.js + Express/Hono)                        │ │
│  │  ├── Auth (BetterAuth — 소셜 로그인, 팀 초대)             │ │
│  │  ├── Teams API (CRUD, 멤버 관리)                          │ │
│  │  ├── Agents API (CRUD, 인격 설정, 어댑터)                 │ │
│  │  ├── Flows API (워크플로우 정의 CRUD)                     │ │
│  │  ├── Execution Engine (플로우 실행, 상태 추적)             │ │
│  │  ├── Cost Tracker (토큰/비용 집계)                        │ │
│  │  └── WebSocket Server (실시간 이벤트)                     │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                             │                                  │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │  DATABASE (PostgreSQL)                                    │ │
│  │  teams, users, agents, flows, flow_nodes, flow_edges,     │ │
│  │  executions, execution_steps, cost_events, activity_log   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                             │                                  │
│  ┌─────────────────────────┴───────────────────────────────┐ │
│  │  EXECUTION LAYER                                          │ │
│  │  ├── Claude Adapter (Agent SDK / CLI spawn)               │ │
│  │  ├── Codex Adapter (CLI spawn)                            │ │
│  │  ├── Gemini Adapter (API call)                            │ │
│  │  └── Custom Adapter (플러그인)                             │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 기술 스택

| 레이어 | 기술 | 이유 |
|--------|------|------|
| **Frontend** | React 19, Vite, Tailwind 4, React Flow | Paperclip과 동일 스택 (검증됨) + 노드 에디터 |
| **Backend** | Hono (또는 Express 5), Drizzle ORM | 경량 + TypeScript 퍼스트 |
| **DB** | PostgreSQL (Supabase or Neon) | Paperclip 패턴 그대로 활용 |
| **Auth** | BetterAuth | Paperclip에서 검증됨, 소셜 로그인 지원 |
| **Realtime** | WebSocket (ws) | Paperclip 패턴 |
| **Node Editor** | React Flow (@xyflow/react) | 최고의 React 노드 에디터 |
| **State** | TanStack Query + Zustand | 서버 상태 + 클라이언트 상태 |
| **배포** | Vercel (FE) + Railway/Fly (BE) + Supabase (DB) | 즉시 스케일 |

---

## 3. 데이터 모델

### 3.1 핵심 테이블 (Paperclip 68개 → 우리는 15개로 시작)

```sql
-- 1. 사용자
users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatarUrl TEXT,
  createdAt TIMESTAMPTZ DEFAULT now()
)

-- 2. 팀 (= Paperclip의 Company)
teams (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,       -- URL: /teams/{slug}
  ownerId UUID REFERENCES users,
  plan TEXT DEFAULT 'free',        -- free, pro, enterprise
  budgetMonthlyCents INTEGER,      -- 월간 예산 (센트)
  createdAt TIMESTAMPTZ DEFAULT now()
)

-- 3. 팀 멤버
team_members (
  id UUID PRIMARY KEY,
  teamId UUID REFERENCES teams,
  userId UUID REFERENCES users,
  role TEXT DEFAULT 'member',      -- owner, admin, member
  UNIQUE(teamId, userId)
)

-- 4. 에이전트 (핵심)
agents (
  id UUID PRIMARY KEY,
  teamId UUID REFERENCES teams NOT NULL,
  name TEXT NOT NULL,               -- "June", "광수"
  role TEXT NOT NULL,               -- developer, researcher, pm, designer, custom
  avatarUrl TEXT,                   -- 에이전트 아바타
  
  -- 인격 설정 (비주얼 에디터로 설정)
  persona JSONB NOT NULL DEFAULT '{}',
  -- {
  --   personality: "꼼꼼하고 체계적인 시니어 개발자",
  --   expertise: ["TypeScript", "React", "시스템 설계"],
  --   communication_style: "간결하고 기술적",
  --   failure_modes: ["scope creep", "over-engineering"],
  --   instructions: "마크다운 전체 시스템 프롬프트"
  -- }
  
  -- 실행 설정
  adapterType TEXT DEFAULT 'claude',  -- claude, codex, gemini, custom
  adapterConfig JSONB DEFAULT '{}',   -- 모델, 온도, 도구 설정
  modelTier TEXT DEFAULT 'sonnet',    -- haiku, sonnet, opus
  
  -- 상태
  status TEXT DEFAULT 'active',       -- active, paused, archived
  budgetMonthlyCents INTEGER,         -- 에이전트별 예산
  
  createdAt TIMESTAMPTZ DEFAULT now(),
  updatedAt TIMESTAMPTZ DEFAULT now()
)

-- 5. 워크플로우 정의
flows (
  id UUID PRIMARY KEY,
  teamId UUID REFERENCES teams NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  
  -- 플로우 캔버스 데이터 (React Flow 직렬화)
  canvasData JSONB NOT NULL DEFAULT '{}',
  -- {
  --   nodes: [{ id, type, position, data }],
  --   edges: [{ id, source, target, data }]
  -- }
  
  status TEXT DEFAULT 'draft',        -- draft, active, archived
  triggerType TEXT,                    -- manual, schedule, webhook, event
  triggerConfig JSONB,                -- cron 표현식, webhook URL 등
  
  createdAt TIMESTAMPTZ DEFAULT now(),
  updatedAt TIMESTAMPTZ DEFAULT now()
)

-- 6. 플로우 실행
executions (
  id UUID PRIMARY KEY,
  flowId UUID REFERENCES flows NOT NULL,
  teamId UUID REFERENCES teams NOT NULL,
  status TEXT DEFAULT 'running',      -- queued, running, completed, failed, cancelled
  input JSONB,                        -- 실행 입력 데이터
  output JSONB,                       -- 최종 출력
  startedAt TIMESTAMPTZ DEFAULT now(),
  finishedAt TIMESTAMPTZ,
  totalCostCents INTEGER DEFAULT 0,
  totalTokens INTEGER DEFAULT 0
)

-- 7. 실행 스텝 (노드별)
execution_steps (
  id UUID PRIMARY KEY,
  executionId UUID REFERENCES executions NOT NULL,
  nodeId TEXT NOT NULL,               -- 플로우 노드 ID
  agentId UUID REFERENCES agents,     -- 실행한 에이전트
  status TEXT DEFAULT 'pending',      -- pending, running, completed, failed, skipped
  input JSONB,
  output JSONB,
  costCents INTEGER DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  startedAt TIMESTAMPTZ,
  finishedAt TIMESTAMPTZ,
  logs TEXT[]                         -- 실행 로그
)

-- 8. 비용 이벤트
cost_events (
  id UUID PRIMARY KEY,
  teamId UUID REFERENCES teams NOT NULL,
  agentId UUID REFERENCES agents,
  executionId UUID REFERENCES executions,
  costCents INTEGER NOT NULL,
  model TEXT,
  inputTokens INTEGER,
  outputTokens INTEGER,
  createdAt TIMESTAMPTZ DEFAULT now()
)

-- 9. 활동 로그 (불변 감사)
activity_log (
  id UUID PRIMARY KEY,
  teamId UUID REFERENCES teams NOT NULL,
  actorType TEXT NOT NULL,            -- user, agent, system
  actorId UUID,
  action TEXT NOT NULL,               -- agent.created, flow.executed, etc.
  entityType TEXT,
  entityId UUID,
  details JSONB,
  createdAt TIMESTAMPTZ DEFAULT now()
)
```

### 3.2 노드 타입 정의

```typescript
// 플로우 캔버스의 노드 타입
type FlowNodeType =
  // 에이전트 노드 (핵심)
  | 'agent'           // AI 에이전트가 작업 수행
  
  // 제어 노드
  | 'trigger'         // 플로우 시작점 (수동, 스케줄, 웹훅)
  | 'condition'       // 조건 분기 (if/else)
  | 'loop'            // 반복 (ralph 스타일 검증 루프)
  | 'parallel'        // 병렬 실행 (ultrawork 스타일)
  | 'gate'            // 승인 게이트 (사람이 승인)
  | 'merge'           // 병렬 결과 합류
  
  // 도구 노드
  | 'code_execute'    // 코드 실행 (Python, JS)
  | 'api_call'        // 외부 API 호출
  | 'file_operation'  // 파일 읽기/쓰기
  | 'notification'    // 알림 (이메일, 슬랙, iMessage)
  
  // 데이터 노드
  | 'input'           // 사용자 입력
  | 'output'          // 결과 출력
  | 'transform'       // 데이터 변환
  | 'memory'          // 에이전트 메모리 읽기/쓰기

// 노드 데이터 (React Flow)
interface AgentNodeData {
  agentId: string;
  prompt: string;             // 이 스텝에서의 구체적 지시
  inputMapping: Record<string, string>;  // 이전 노드 출력 → 이 노드 입력
  outputMapping: Record<string, string>; // 이 노드 출력 키
  maxRetries: number;         // 서킷 브레이커 (OMC 패턴)
  escalateToAgentId?: string; // 실패 시 에스컬레이션 대상
  modelOverride?: string;     // 이 스텝만 다른 모델 사용
}
```

---

## 4. 핵심 화면 설계

### 4.1 에이전트 인격 에디터

```
┌──────────────────────────────────────────────────────────────┐
│  🤖 에이전트 설정 — "광수"                              [저장] │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  [아바타]  이름: [광수          ]                              │
│  🎭       역할: [Developer    ▼]                              │
│                                                              │
│  ┌─── 인격 설정 ───────────────────────────────────────────┐ │
│  │                                                          │ │
│  │  성격 슬라이더:                                           │ │
│  │  꼼꼼함  ████████░░  80%                                  │ │
│  │  창의성  ██████░░░░  60%                                  │ │
│  │  독립성  ███████░░░  70%                                  │ │
│  │  커뮤니케이션  █████░░░░░  50%                             │ │
│  │                                                          │ │
│  │  전문성 태그: [+ 추가]                                     │ │
│  │  [TypeScript] [React] [Node.js] [시스템 설계]             │ │
│  │                                                          │ │
│  │  커뮤니케이션 스타일: [간결하고 기술적 ▼]                   │ │
│  │  ○ 친절하고 상세한  ○ 간결하고 기술적  ○ 격식있는          │ │
│  │                                                          │ │
│  │  실패 모드 (하지 말 것): [+ 추가]                          │ │
│  │  [⚠ scope creep] [⚠ over-engineering] [⚠ 테스트 건너뛰기] │ │
│  │                                                          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─── 실행 설정 ───────────────────────────────────────────┐ │
│  │  AI 모델: [Claude Sonnet ▼]   예산: [$50/월     ]        │ │
│  │  도구: [☑ 코드 실행] [☑ 웹 검색] [☑ 파일 편집]           │ │
│  │  서킷 브레이커: 3회 실패 → [architect에게 에스컬레이션 ▼]  │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─── 시스템 프롬프트 (고급) ──────────────────────────────┐  │
│  │  # 광수의 시스템 프롬프트                                 │  │
│  │  당신은 "광수", 시니어 풀스택 개발자입니다.                │  │
│  │  TypeScript와 React 전문가이며...                         │  │
│  │  (마크다운 에디터)                                        │  │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
│  [프리뷰: 이 에이전트에게 "인증 모듈 만들어줘" 라고 하면?]      │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  광수: 인증 모듈 구현을 시작하겠습니다.                     │ │
│  │  1. 먼저 기존 코드베이스를 분석하겠습니다...               │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 플로우 캔버스 (핵심 화면)

```
┌──────────────────────────────────────────────────────────────┐
│  🔀 워크플로우 — "PR 리뷰 파이프라인"        [실행] [저장]     │
├──────────────┬───────────────────────────────────────────────┤
│ 노드 팔레트   │                                               │
│              │    ┌──────────┐                                │
│ 🤖 에이전트   │    │ ▶ Trigger │                               │
│ ├ 광수       │    │  "PR 생성" │                               │
│ ├ 미나       │    └────┬─────┘                                │
│ └ 철수       │         │                                      │
│              │    ┌────┴─────┐                                │
│ ⚙ 제어       │    │🤖 미나    │                               │
│ ├ 조건       │    │"코드 분석" │                               │
│ ├ 반복       │    └────┬─────┘                                │
│ ├ 병렬       │         │                                      │
│ └ 승인 게이트 │    ┌────┴─────────┐                            │
│              │    │    ⑃ 병렬     │                            │
│ 🔧 도구      │    └──┬─────┬─────┘                            │
│ ├ 코드실행   │       │     │                                   │
│ ├ API 호출   │  ┌────┴──┐ ┌┴────────┐                         │
│ └ 알림       │  │🤖 광수 │ │🤖 철수   │                        │
│              │  │"보안"  │ │"성능"    │                        │
│ 📊 데이터    │  └────┬──┘ └┬────────┘                         │
│ ├ 입력       │       │     │                                   │
│ ├ 출력       │    ┌──┴─────┴──┐                               │
│ └ 변환       │    │   합류     │                               │
│              │    └────┬──────┘                                │
│              │         │                                       │
│              │    ┌────┴──────┐                                │
│              │    │ 🚦 조건    │                                │
│              │    │ "이슈 수"  │                                │
│              │    └──┬────┬──┘                                 │
│              │  >5개 │    │ ≤5개                               │
│              │  ┌────┴──┐ ┌┴─────────┐                        │
│              │  │🔒 승인 │ │📤 출력    │                       │
│              │  │게이트  │ │"리뷰 완료" │                       │
│              │  └───────┘ └──────────┘                        │
├──────────────┴───────────────────────────────────────────────┤
│  노드 속성 (선택된 노드: 🤖 광수 — "보안 리뷰")                │
│  프롬프트: [이 PR의 보안 취약점을 분석해주세요...]              │
│  입력: [코드분석결과 ← 미나.output]  출력: [보안이슈]          │
│  모델: [Opus ▼] (보안 리뷰는 최고 모델)  재시도: [2]           │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 실행 모니터

```
┌──────────────────────────────────────────────────────────────┐
│  ▶ 실행 #47 — "PR 리뷰 파이프라인"    진행중 (3/5 완료)      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  타임라인:                                                    │
│                                                              │
│  ✅ Trigger (PR #123)                    0.1s    $0.00       │
│  ✅ 🤖 미나 "코드 분석"                  12.3s   $0.08       │
│     └─ 42개 파일 분석, 3개 핵심 이슈 발견                      │
│  ⏳ ⑃ 병렬 실행 중...                                        │
│  │  ✅ 🤖 광수 "보안 리뷰"              8.7s    $0.45       │
│  │     └─ 2개 CRITICAL, 1개 HIGH 발견                        │
│  │  🔄 🤖 철수 "성능 리뷰"              진행중...             │
│  │     └─ N+1 쿼리 분석 중...                                │
│  ⏸ 합류 (광수 완료 대기 중, 철수 진행 중)                      │
│  ⬚ 조건 분기 (대기)                                          │
│  ⬚ 출력 (대기)                                               │
│                                                              │
│  ┌────────────────────────────────────────────┐              │
│  │ 실시간 로그 — 🤖 철수 "성능 리뷰"           │              │
│  │ > 쿼리 실행 계획 분석 중...                  │              │
│  │ > users 테이블 풀스캔 감지                   │              │
│  │ > 인덱스 추가 권고 작성 중...                │              │
│  └────────────────────────────────────────────┘              │
│                                                              │
│  비용: $0.53 / 예산 $5.00 (10.6%)    토큰: 12,340            │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. 구현 Phase

### Phase 0: 프로젝트 뼈대 (1주)

```
목표: 모노레포 + 로그인 + 팀 생성까지

juneclaw-office/
├── apps/
│   ├── web/              # React + Vite + Tailwind
│   └── server/           # Hono + Drizzle
├── packages/
│   ├── db/               # Drizzle 스키마 + 마이그레이션
│   ├── shared/           # 타입, 밸리데이터 (Zod)
│   └── ui/               # 공유 UI 컴포넌트
├── package.json          # pnpm workspace
└── turbo.json            # Turborepo

작업:
□ pnpm + turborepo 모노레포 초기화
□ Supabase PostgreSQL 프로비저닝 (또는 로컬 Docker)
□ Drizzle 스키마: users, teams, team_members
□ BetterAuth 설정 (Google/GitHub 소셜 로그인)
□ 로그인 → 팀 생성 → 팀 대시보드 UI
□ 기본 레이아웃 (사이드바 + 메인 + 헤더)
```

### Phase 1: 에이전트 시스템 (2주)

```
목표: 에이전트 CRUD + 비주얼 인격 에디터

작업:
□ Drizzle 스키마: agents 테이블
□ 에이전트 API: CRUD + 팀 범위 필터링
□ 에이전트 인격 에디터 UI:
  ├── 기본 정보 (이름, 역할, 아바타)
  ├── 성격 슬라이더 (꼼꼼함, 창의성, 독립성, 소통)
  ├── 전문성 태그 입력
  ├── 커뮤니케이션 스타일 선택
  ├── 실패 모드 목록 (OMC 패턴)
  └── 시스템 프롬프트 마크다운 에디터
□ 에이전트 프리셋 라이브러리:
  ├── Developer (OMC executor 기반)
  ├── Architect (OMC architect 기반)
  ├── Code Reviewer (OMC code-reviewer 기반)
  ├── Researcher (OMC analyst 기반)
  ├── PM (OMC planner 기반)
  ├── QA (OMC qa-tester 기반)
  └── Writer (OMC writer 기반)
□ 인격 → 시스템 프롬프트 자동 생성기
  (슬라이더 값 + 태그 + 스타일 → 마크다운 프롬프트)
□ 에이전트 목록 UI (카드 그리드 or 조직도)
```

### Phase 2: 플로우 캔버스 (3주) — 핵심

```
목표: React Flow 기반 노드 에디터 + 플로우 정의 저장/로드

작업:
□ React Flow 통합 (@xyflow/react)
□ 커스텀 노드 컴포넌트 구현:
  ├── AgentNode — 에이전트 아바타 + 이름 + 프롬프트 요약
  ├── TriggerNode — 시작점 (수동/스케줄/웹훅)
  ├── ConditionNode — 조건 분기 (if/else)
  ├── ParallelNode — 병렬 실행 (OMC ultrawork 패턴)
  ├── LoopNode — 반복 (OMC ralph 패턴: 검증 실패 시 재실행)
  ├── GateNode — 사람 승인 (Paperclip 승인 게이트)
  ├── MergeNode — 병렬 결과 합류
  ├── OutputNode — 결과 출력
  └── CodeNode — 코드 스니펫 실행
□ 노드 연결 규칙 (엣지 밸리데이션):
  ├── Trigger는 시작점만 가능
  ├── Agent 출력 → Agent/Condition/Gate/Output 입력
  ├── Condition은 2+ 출력 필수
  ├── Parallel은 2+ 출력 + Merge 필수
  └── Loop은 조건 + 본문 연결 필수
□ 노드 속성 패널 (우측 사이드바):
  ├── Agent 노드: 프롬프트, 입출력 매핑, 모델, 재시도
  ├── Condition 노드: 조건식 편집기
  ├── Gate 노드: 승인자 설정
  └── Loop 노드: 최대 반복, 종료 조건
□ 플로우 직렬화 → JSONB (DB 저장)
□ 플로우 목록 UI
□ 플로우 템플릿 라이브러리:
  ├── "코드 리뷰 파이프라인" (분석→병렬리뷰→합류→판정)
  ├── "기능 개발" (요구분석→설계→구현→테스트→리뷰)
  ├── "버그 수정" (재현→원인분석→수정→검증)
  └── "리서치" (질문정제→조사→합성→보고)
```

### Phase 3: 실행 엔진 (3주)

```
목표: 플로우를 실제로 실행하고 결과를 추적

작업:
□ Drizzle 스키마: executions, execution_steps, cost_events
□ 플로우 실행 엔진 (서버사이드):
  ├── 토폴로지 정렬 (DAG 순서 결정)
  ├── 노드별 실행기 구현:
  │   ├── AgentExecutor: AI 모델 호출 (Claude API / CLI spawn)
  │   ├── ConditionExecutor: 조건 평가
  │   ├── ParallelExecutor: Promise.all로 병렬 실행
  │   ├── LoopExecutor: 조건 만족까지 반복
  │   ├── GateExecutor: 사람 승인 대기 (WebSocket 알림)
  │   └── CodeExecutor: 안전한 코드 실행 (sandbox)
  ├── 데이터 흐름: 노드 출력 → 다음 노드 입력 매핑
  ├── 에러 핸들링: 재시도 + 서킷 브레이커 (OMC 패턴)
  └── 비용 추적: 각 API 호출의 토큰/비용 기록
□ Claude 어댑터 구현:
  ├── Anthropic SDK 직접 호출 (API 키 기반)
  ├── 또는 Claude CLI spawn (구독 기반)
  ├── 에이전트 인격 → system prompt 변환
  └── 스트리밍 응답 → WebSocket으로 클라이언트에 전달
□ WebSocket 실시간 업데이트:
  ├── 실행 시작/완료 이벤트
  ├── 스텝별 진행 상태
  ├── 에이전트 출력 스트리밍
  └── 비용 업데이트
□ 실행 모니터 UI:
  ├── 타임라인 뷰 (Phase 4.3 디자인)
  ├── 캔버스 오버레이 (실행 중인 노드 하이라이트)
  ├── 실시간 로그 패널
  └── 비용 프로그레스 바
```

### Phase 4: 대시보드 + 비용 (2주)

```
목표: 팀 대시보드, 비용 추적, 활동 로그

작업:
□ 팀 대시보드:
  ├── 활성 에이전트 수, 실행 중인 플로우
  ├── 최근 활동 타임라인
  ├── 비용 차트 (일별/주별/월별)
  └── 에이전트별 성과 요약
□ 비용 제어:
  ├── 팀 월간 예산 설정
  ├── 에이전트별 예산 설정
  ├── 80% 경고 + 100% 자동 정지 (Paperclip 패턴)
  └── 비용 상세 분석 (모델별, 플로우별, 에이전트별)
□ 활동 로그:
  ├── 불변 감사 추적 (Paperclip 패턴)
  ├── 필터: 액터, 액션, 엔티티, 날짜
  └── 실행 히스토리 (입력/출력/비용)
□ 칸반 보드 (간단한 태스크 관리):
  ├── 컬럼: Backlog → In Progress → Review → Done
  ├── 카드: 제목, 할당 에이전트, 우선순위
  └── 드래그앤드롭 (dnd-kit)
```

### Phase 5: 공개 준비 (2주)

```
목표: 랜딩 페이지, 온보딩, 배포

작업:
□ 랜딩 페이지:
  ├── 히어로: "AI 팀을 5분 만에 만드세요"
  ├── 데모 비디오/GIF
  ├── 요금제: Free (3 에이전트, 100 실행/월) / Pro / Enterprise
  └── 소셜 증명
□ 온보딩 마법사:
  ├── 팀 이름 입력
  ├── 첫 에이전트 프리셋 선택
  ├── 샘플 플로우 자동 생성
  └── 첫 실행 가이드
□ 배포:
  ├── Vercel (프론트엔드)
  ├── Railway 또는 Fly.io (백엔드)
  ├── Supabase (DB + Auth)
  └── Upstash (Redis, rate limiting)
□ 모니터링: Sentry (에러), PostHog (분석)
□ 결제: Stripe 연동 (Pro 플랜)
```

---

## 6. OMC에서 가져오는 핵심 패턴 (정확한 구현 방법)

### 6.1 에이전트 프리셋 → OMC 에이전트 프롬프트 기반

```typescript
// OMC agents/executor.md에서 핵심 추출
const DEVELOPER_PRESET = {
  name: 'Developer',
  role: 'developer',
  persona: {
    personality: '최소 변경 원칙을 따르는 실용적 개발자',
    expertise: [],  // 사용자가 설정
    communication_style: 'concise_technical',
    failure_modes: [
      'scope creep — 요청 범위를 넘어서 리팩토링하지 말 것',
      'over-engineering — 한 번만 쓸 로직을 추상화하지 말 것',
      'debug code — 임시 디버그 코드를 남기지 말 것',
    ],
    instructions: `# Developer Agent
당신은 집중력 있는 구현 전문가입니다.
핵심 원칙: 작고 정확한 변경이 크고 화려한 변경보다 낫습니다.

## 성공 기준
- 최소한의 diff
- 빌드/테스트 통과
- 단일 사용 로직에 추상화 없음
- 임시 코드 없음

## 서킷 브레이커
3회 연속 실패 → 상위 에이전트에게 에스컬레이션
`,
  },
  adapterConfig: { model: 'sonnet', maxRetries: 3 },
};

// 다른 프리셋도 OMC 에이전트에서 동일하게 추출:
// Architect ← agents/architect.md
// Code Reviewer ← agents/code-reviewer.md
// Researcher ← agents/analyst.md
// PM ← agents/planner.md
// QA ← agents/qa-tester.md + test-engineer.md
// Writer ← agents/writer.md
```

### 6.2 노드 기반 플로우 → OMC 워크플로우 매핑

```
OMC autopilot 5단계 → 플로우 템플릿:

[Trigger] → [Analyst: 요구분석] → [Planner: 계획수립]
  → [Parallel: 구현] → [Merge] → [Code Reviewer + Security Reviewer: 병렬 리뷰]
  → [Condition: 통과?] → Yes → [Output: 완료]
                        → No → [Loop: 수정 후 재리뷰]

OMC ralph 루프 → Loop 노드:

[Loop(max=5)] → [Executor: 구현] → [Verifier: 검증]
  → [Condition: 통과?] → Yes → [Loop 탈출]
                        → No → [Loop 계속]
```

### 6.3 서킷 브레이커 패턴 (OMC에서)

```typescript
// 실행 엔진에서 에이전트 노드 실행 시
async function executeAgentNode(node, input, context) {
  const maxRetries = node.data.maxRetries ?? 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await callAgent(node.data.agentId, input);
      return result;
    } catch (error) {
      if (attempt === maxRetries - 1) {
        // 서킷 브레이커: 에스컬레이션
        if (node.data.escalateToAgentId) {
          return await callAgent(node.data.escalateToAgentId, {
            ...input,
            previousFailures: attempt + 1,
            lastError: error.message,
          });
        }
        throw error;
      }
    }
  }
}
```

### 6.4 3-티어 모델 라우팅 (OMC에서)

```typescript
// 노드별 모델 자동 결정
function resolveModelForNode(node: FlowNode, teamBudget: Budget): string {
  // 에이전트 역할 기반 기본 모델
  const roleDefaults = {
    developer: 'sonnet',    // 구현 = Sonnet
    architect: 'opus',      // 설계 = Opus
    researcher: 'opus',     // 분석 = Opus
    reviewer: 'opus',       // 리뷰 = Opus
    writer: 'haiku',        // 문서 = Haiku
    qa: 'sonnet',           // QA = Sonnet
  };
  
  // 예산 압박 시 다운그레이드 (Paperclip 패턴)
  const budgetUsage = teamBudget.usedCents / teamBudget.limitCents;
  if (budgetUsage > 0.8) {
    // 80% 이상: Opus → Sonnet, Sonnet → Haiku
    return downgrade(roleDefaults[node.data.role]);
  }
  
  // 노드별 오버라이드 우선
  return node.data.modelOverride ?? roleDefaults[node.data.role] ?? 'sonnet';
}
```

---

## 7. Paperclip에서 가져오는 핵심 패턴

### 7.1 원자적 실행 (409 Conflict)

```typescript
// 같은 플로우가 동시에 실행되지 않도록
async function startExecution(flowId: string) {
  return await db.transaction(async (tx) => {
    // SELECT FOR UPDATE로 플로우 잠금
    const flow = await tx.query.flows.findFirst({
      where: eq(flows.id, flowId),
      for: 'update',
    });
    
    // 이미 실행 중이면 409
    const running = await tx.query.executions.findFirst({
      where: and(
        eq(executions.flowId, flowId),
        eq(executions.status, 'running'),
      ),
    });
    if (running) throw new ConflictError('Flow already executing');
    
    // 새 실행 생성
    return await tx.insert(executions).values({ flowId, status: 'running' });
  });
}
```

### 7.2 승인 게이트 노드 (Paperclip 패턴)

```typescript
// GateNode 실행 시
async function executeGateNode(node, input, context) {
  // 1. 승인 요청 생성
  const approval = await createApproval({
    teamId: context.teamId,
    executionId: context.executionId,
    nodeId: node.id,
    payload: input,
    status: 'pending',
  });
  
  // 2. WebSocket으로 팀에 알림
  ws.broadcast(context.teamId, {
    type: 'approval.requested',
    approvalId: approval.id,
    flowName: context.flowName,
    summary: input.summary,
  });
  
  // 3. 대기 (사용자가 UI에서 승인/거부)
  // 승인 → 다음 노드로 진행
  // 거부 → 실행 취소 또는 이전 노드로 돌아가기
  return await waitForApproval(approval.id);
}
```

### 7.3 비용 2단계 하드스탑 (Paperclip 패턴)

```typescript
// 에이전트 호출 전 예산 체크
async function checkBudget(teamId: string, agentId: string) {
  const budget = await getBudget(teamId, agentId);
  const usage = budget.usedCents / budget.limitCents;
  
  if (usage >= 1.0) {
    // HARD STOP: 실행 거부 + 에이전트 일시정지
    await pauseAgent(agentId, 'budget_exceeded');
    throw new BudgetExceededError('Monthly budget exceeded');
  }
  
  if (usage >= 0.8) {
    // SOFT WARNING: 경고만 (실행은 계속)
    await logActivity(teamId, 'system', 'budget.warning', {
      agentId, usage: Math.round(usage * 100) + '%',
    });
  }
}
```

---

## 8. 타임라인 요약

| Phase | 기간 | 산출물 | 핵심 |
|-------|------|--------|------|
| **0: 뼈대** | 1주 | 로그인, 팀 생성 | 모노레포 + Auth + DB |
| **1: 에이전트** | 2주 | 인격 에디터, 프리셋 7개 | OMC 프롬프트 기반 |
| **2: 플로우** | 3주 | 노드 캔버스, 템플릿 4개 | React Flow + 직렬화 |
| **3: 실행** | 3주 | 실행 엔진, 모니터 | Claude API + WebSocket |
| **4: 대시보드** | 2주 | 비용, 활동, 칸반 | Paperclip 패턴 |
| **5: 공개** | 2주 | 랜딩, 온보딩, 배포 | Vercel + Supabase |
| **합계** | **~13주** | **MVP 공개** | |

---

## 9. 경쟁 우위 — 왜 이 앱이 다른가

| vs | 우리의 차별점 |
|----|-------------|
| **Paperclip** | 비주얼 노드 에디터 (Paperclip은 코드/CLI 중심) |
| **n8n / Make** | AI 에이전트 특화 (일반 자동화가 아닌 AI 팀 관리) |
| **CrewAI** | 웹 UI + 비주얼 인격 에디터 (CrewAI는 Python 코드) |
| **AutoGen** | 유저 프렌들리 + SaaS (AutoGen은 개발자 도구) |
| **Claude Projects** | 멀티 에이전트 + 워크플로우 (Projects는 단일 에이전트) |

**핵심 메시지**: "코드 한 줄 없이 AI 팀을 만들고 운영하세요"

---

> **다음 단계**: Phase 0 시작 — 모노레포 초기화 + Supabase 설정 + BetterAuth + 기본 UI
