# oh-my-claudecode (OMC) 리버스 엔지니어링 정밀 분석서 v2

> **분석 대상**: https://github.com/yeachan-heo/oh-my-claudecode  
> **버전**: v4.11.6 (npm: oh-my-claude-sisyphus)  
> **분석일**: 2026-04-15  
> **분석 수준**: 소스 코드 전 라인 정밀 분석  
> **목적**: 정확한 리빌드 또는 응용을 위한 아키텍처 완전 해부

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [아키텍처 총괄 — 6개 레이어](#2-아키텍처-총괄)
3. [플러그인 시스템 — Claude Code 연결점](#3-플러그인-시스템)
4. [Hook 시스템 — 정확한 프로토콜 명세](#4-hook-시스템)
5. [핵심 소스 코드 정밀 분석](#5-핵심-소스-코드-정밀-분석)
6. [에이전트 시스템 — 19개 전문 에이전트 전체 명세](#6-에이전트-시스템)
7. [스킬 시스템 — 45+ 워크플로우 전체 명세](#7-스킬-시스템)
8. [MCP 도구 서버 — 커스텀 도구 상세](#8-mcp-도구-서버)
9. [상태 관리 — 정확한 구현 명세](#9-상태-관리)
10. [팀 오케스트레이션 — 멀티 프로세스 상세](#10-팀-오케스트레이션)
11. [매직 키워드 — 감지 알고리즘 상세](#11-매직-키워드)
12. [설정 시스템 — 전체 설정 키 맵](#12-설정-시스템)
13. [핵심 워크플로우 상세 분석](#13-핵심-워크플로우-상세)
14. [빌드 시스템](#14-빌드-시스템)
15. [하드코딩된 상수 & 임계값 전체 목록](#15-하드코딩된-상수)
16. [의존성 분석](#16-의존성-분석)
17. [핵심 인사이트 — 설계 판단과 교훈](#17-핵심-인사이트)
18. [리빌드 가이드](#18-리빌드-가이드)
19. [JuneClaw 응용 전략](#19-juneclaw-응용-전략)

---

## 1. 프로젝트 개요

### 코드 규모
- **TypeScript 소스**: src/ 디렉토리 ~247K+ 라인
- **핵심 파일**: 12개 코어 모듈, 51개 훅 구현, 47개 팀 파일
- **에이전트**: 19개 (29개 티어 변형 포함)
- **스킬**: 45+ 워크플로우
- **MCP 도구**: 18+개 커스텀 도구

### 한 줄 정의
Claude Code의 **플러그인/Hook/MCP 시스템을 활용**해서 19개 전문 에이전트 + 45개 스킬 워크플로우 + 매직 키워드 트리거를 제공하는 멀티 에이전트 오케스트레이션 레이어.

---

## 2. 아키텍처 총괄

### 6개 레이어 + 정확한 데이터 흐름

```
┌───────────────────────────────────────────────────────────────┐
│ L1. USER INPUT                                                 │
│     프롬프트 → hooks/hooks.json의 UserPromptSubmit 트리거       │
├───────────────────────────────────────────────────────────────┤
│ L2. HOOK LAYER (scripts/*.mjs)                                 │
│     keyword-detector (891줄) → skill-injector (332줄)          │
│     stdout JSON → <system-reminder> 태그로 변환                 │
├───────────────────────────────────────────────────────────────┤
│ L3. FEATURE LAYER (src/features/)                              │
│     magic-keywords (489줄) + continuation-enforcement (197줄)   │
│     + background-tasks (357줄) + delegation-enforcer (305줄)    │
├───────────────────────────────────────────────────────────────┤
│ L4. ORCHESTRATION LAYER (src/index.ts, 406줄)                  │
│     createOmcSession() → queryOptions 조합                     │
│     agents + MCP servers + tools + system prompt               │
├───────────────────────────────────────────────────────────────┤
│ L5. SDK LAYER (Claude Agent SDK)                               │
│     query(prompt, { agents, mcpServers, allowedTools })        │
│     permissionMode = 'acceptEdits'                             │
├───────────────────────────────────────────────────────────────┤
│ L6. TOOL + TEAM LAYER                                          │
│     MCP 서버 "t" → LSP/AST/Python/State/Notepad 도구           │
│     팀: tmux 워커 + JSONL inbox/outbox                         │
└───────────────────────────────────────────────────────────────┘
```

### 핵심 데이터 흐름 (정확한 함수 호출 체인)

```
사용자 프롬프트 제출
  ↓
hooks.json → UserPromptSubmit 이벤트
  ├─ scripts/run.cjs → keyword-detector.mjs 실행
  │   stdin: { prompt, session_id, cwd }
  │   stdout: { continue: true, hookSpecificOutput: { additionalContext: "<system-reminder>..." } }
  └─ scripts/run.cjs → skill-injector.mjs 실행
      stdin: { prompt, session_id, cwd }
      stdout: { continue: true, hookSpecificOutput: { additionalContext: "<mnemosyne>..." } }
  ↓
createOmcSession() [src/index.ts:265-377]
  ├─ loadConfig() [src/config/loader.ts:442-484]
  │   1. buildDefaultConfig()
  │   2. deepMerge(user: ~/.config/claude-omc/config.jsonc)
  │   3. deepMerge(project: .claude/omc.jsonc)
  │   4. deepMerge(loadEnvConfig())
  │   5. auto-enable forceInherit if isNonClaudeProvider()
  ├─ findContextFiles() → AGENTS.md, CLAUDE.md 발견
  ├─ getAgentDefinitions() [src/agents/definitions.ts:201-280]
  │   19개 에이전트 등록, 모델 해석 체인 적용
  ├─ getDefaultMcpServers() [src/mcp/servers.ts:84-110]
  │   Exa(기본 on) + Context7(기본 on)
  ├─ getOmcToolNames() [src/mcp/omc-tools-server.ts:156-205]
  │   mcp__t__<도구명> 형식 목록
  └─ buildSystemPrompt
      omcSystemPrompt + continuationSystemPromptAddition + context files
  ↓
SDK query() 실행
  ├─ PreToolUse 훅 → pre-tool-enforcer.mjs (862줄)
  │   에이전트 모델 검증 + 컨텍스트 안전 경고 + 모드 상태 알림
  ├─ 도구 실행 (Bash, Read, Write 등)
  ├─ PostToolUse 훅 → post-tool-verifier.mjs (899줄)
  │   실패 감지 + 세션 통계 + 선제적 컴팩션 경고
  └─ Task 도구 → 하위 에이전트 위임
      enforceModel() [src/features/delegation-enforcer.ts:146-241]
  ↓
Stop 이벤트
  ├─ context-guard-stop.mjs: 컨텍스트 75% 경고, 95% 임계
  ├─ persistent-mode.cjs (1321줄): 활성 모드 시 중단 차단
  │   ├─ ralph: active=true & iteration < max & !awaiting_confirmation → 차단
  │   ├─ autopilot/ultrawork: active=true & !awaiting_confirmation → 차단
  │   ├─ team/pipeline: 20회 재차단 제한, 5분 TTL
  │   └─ ralplan: 30회 재차단 제한, 45분 TTL
  └─ code-simplifier.mjs: 선택적 수정 파일 정리 (opt-in)
```

---

## 3. 플러그인 시스템

### 정확한 매니페스트

```json
// .claude-plugin/plugin.json
{
  "name": "oh-my-claudecode",
  "version": "4.11.6",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}

// .claude-plugin/marketplace.json
{
  "id": "omc",
  "category": "productivity",
  "skillCount": 32,
  "agentCount": 29
}

// .mcp.json
{
  "mcpServers": {
    "t": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/mcp-server.cjs"]
    }
  }
}
```

**핵심 포인트**: MCP 서버 이름이 `"t"` → 모든 도구는 `mcp__t__<도구명>` 형식. `${CLAUDE_PLUGIN_ROOT}`는 Claude Code가 플러그인 경로로 치환.

### 설치 경로

```
~/.claude/plugins/cache/omc/oh-my-claudecode/{version}/
```

---

## 4. Hook 시스템

### Hook JSON 정확한 구조 (hooks/hooks.json, 212줄)

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node $CLAUDE_PLUGIN_ROOT/scripts/run.cjs $CLAUDE_PLUGIN_ROOT/scripts/SCRIPT.mjs",
            "timeout": N
          }
        ]
      }
    ]
  }
}
```

### 전체 이벤트-훅 매핑 (타임아웃 포함)

| 이벤트 | 훅 스크립트 | 타임아웃 | 역할 |
|--------|-----------|---------|------|
| **UserPromptSubmit** | keyword-detector.mjs | 5초 | 매직 키워드 감지 |
| | skill-injector.mjs | 3초 | 학습된 스킬 주입 |
| **SessionStart** | session-start.mjs | 5초 | 영속 모드 복원, 메모리 로드 |
| | project-memory-session.mjs | 5초 | 프로젝트 메모리 주입 |
| | wiki-session-start.mjs | 5초 | Wiki 컨텍스트 |
| | setup-init.mjs | 30초 | 초기 설정 (matcher: "init") |
| | setup-maintenance.mjs | 60초 | 유지보수 (matcher: "maintenance") |
| **PreToolUse** | pre-tool-enforcer.mjs | 3초 | 모델 검증, 컨텍스트 경고 |
| **PermissionRequest** | permission-handler.mjs | 5초 | Bash 권한 추적 |
| **PostToolUse** | post-tool-verifier.mjs | 3초 | 결과 검증, 통계 |
| | project-memory-posttool.mjs | 3초 | 지식 추출 |
| | post-tool-rules-injector.mjs | 3초 | 규칙 주입 |
| **PostToolUseFailure** | post-tool-use-failure.mjs | 3초 | 에러 복구 |
| **SubagentStart** | subagent-tracker.mjs start | 3초 | 에이전트 추적 시작 |
| **SubagentStop** | subagent-tracker.mjs stop | 5초 | 에이전트 추적 종료 |
| | verify-deliverables.mjs | 5초 | 산출물 검증 |
| **PreCompact** | pre-compact.mjs | 10초 | 컴팩션 전 상태 저장 |
| | project-memory-precompact.mjs | 5초 | 메모리 보존 |
| | wiki-pre-compact.mjs | 3초 | Wiki 보존 |
| **Stop** | context-guard-stop.mjs | 5초 | 컨텍스트 사용량 경고 |
| | persistent-mode.cjs | 10초 | **미완료 시 중단 차단** |
| | code-simplifier.mjs | 5초 | 선택적 코드 정리 |
| **SessionEnd** | session-end.mjs | 30초 | 정리, 아카이브 |
| | wiki-session-end.mjs | 30초 | Wiki 정리 |

### 훅 입출력 프로토콜 (정확한 JSON 스키마)

**입력** (stdin으로 전달):
```json
{
  "prompt": "사용자 텍스트",           // UserPromptSubmit
  "session_id": "sid",
  "cwd": "/project/path",
  "tool_name": "Bash",               // PreToolUse/PostToolUse
  "tool_output": "실행 결과",         // PostToolUse
  "exit_code": 0,                    // PostToolUse
  "stop_reason": "user_requested",   // Stop
  "transcript_path": "/path/to/transcript.json",
  "subagent_type": "oh-my-claudecode:executor"  // PreToolUse
}
```

**출력** (stdout JSON, 3가지 형태):

```json
// 1. 컨텍스트 주입
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<system-reminder>주입할 내용</system-reminder>"
  }
}

// 2. 조용한 통과
{
  "continue": true,
  "suppressOutput": true
}

// 3. 중단 차단 (Stop 이벤트 전용)
{
  "continue": false,
  "decision": "block",
  "reason": "설명 텍스트"
}
```

**실패 안전 정책**: exit code != 0 → `{ continue: true, suppressOutput: true }` 처리. Hook은 절대 Claude Code를 블록하지 않음.

### Hook 실행기 — scripts/run.cjs (163줄)

**핵심 로직**: 스테일(stale) CLAUDE_PLUGIN_ROOT 해결
```
1. 빠른 경로: 파일이 그대로 존재 → 실행
2. realpath 폴백: 심볼릭 링크 따라감
3. 플러그인 캐시 스캔: semver 정렬, 최신 매칭 스크립트 선택
4. 못 찾으면: exit 0 (조용히 종료)
```

- `process.execPath`로 Node 실행 (셸 PATH 문제 회피, Windows PE32+ 이슈)
- hooks.json에서 해당 스크립트의 타임아웃을 파싱해서 적용

### stdin 유틸리티 — scripts/lib/stdin.mjs (65줄)

```javascript
export async function readStdin(timeoutMs = 5000) {
  // 타임아웃 보호 (Linux/Windows 행 방지, issue #240, #459)
  // EOF, 에러, 타임아웃 시 축적된 청크 반환
  // TTY readableEnded 체크
}
```

---

## 5. 핵심 소스 코드 정밀 분석

### src/index.ts (406줄) — 메인 진입점

**주요 인터페이스:**

```typescript
interface OmcOptions {
  config?: Partial<PluginConfig>;
  workingDirectory?: string;      // 기본: process.cwd()
  skipConfigLoad?: boolean;
  skipContextInjection?: boolean;
  customSystemPrompt?: string;
  apiKey?: string;
}

interface OmcSession {
  queryOptions: {
    options: {
      systemPrompt: string;
      agents: Record<string, AgentDefinition>;
      mcpServers: McpServersConfig;
      allowedTools: string[];
      permissionMode: 'acceptEdits';  // 하드코딩
    }
  };
  state: SessionState;
  config: PluginConfig;
  processPrompt: (prompt: string) => string;
  detectKeywords: (prompt: string) => string[];
  backgroundTasks: BackgroundTaskManager;
  shouldRunInBackground: (command: string) => TaskExecutionDecision;
}
```

**createOmcSession() 정확한 로직 (265-377줄):**
```
1. loadConfig() (skipConfigLoad가 아닌 경우)
2. options.config과 deepMerge
3. findContextFiles() → AGENTS.md/CLAUDE.md 발견 (autoContextInjection !== false)
4. 시스템 프롬프트 조합:
   - omcSystemPrompt (289-404줄, 핵심 오케스트레이션 지시)
   - continuationSystemPromptAddition (features.continuationEnforcement !== false)
   - customSystemPrompt (있으면)
   - loadContextFromFiles() 결과 (있으면)
5. getAgentDefinitions(config)
6. getDefaultMcpServers({ exaApiKey, enableExa, enableContext7 })
7. allowedTools 배열 구성:
   - 항상: 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite'
   - permissions.allowBash !== false → 'Bash'
   - permissions.allowEdit !== false → 'Edit'
   - permissions.allowWrite !== false → 'Write'
   - MCP 도구 패턴: mcp__serverName__*
   - OMC 커스텀 도구: getOmcToolNames()
8. OmcSession 반환
```

### src/shared/types.ts (381줄) — 전체 타입 시스템

**PluginConfig 핵심 필드 (정확한 구조):**

```typescript
interface PluginConfig {
  agents: {
    // 19개 에이전트 + omc 자체
    omc: { model?: string };
    explore: { model?: string };
    analyst: { model?: string };
    planner: { model?: string };
    architect: { model?: string };
    debugger: { model?: string };
    executor: { model?: string };
    verifier: { model?: string };
    securityReviewer: { model?: string };
    codeReviewer: { model?: string };
    testEngineer: { model?: string };
    designer: { model?: string };
    writer: { model?: string };
    qaTester: { model?: string };
    scientist: { model?: string };
    tracer: { model?: string };
    gitMaster: { model?: string };
    codeSimplifier: { model?: string };
    critic: { model?: string };
    documentSpecialist: { model?: string };
  };
  features: {
    parallelExecution?: boolean;      // 기본 true
    lspTools?: boolean;               // 기본 true
    astTools?: boolean;               // 기본 true
    continuationEnforcement?: boolean; // 기본 true
    autoContextInjection?: boolean;   // 기본 true
  };
  permissions: {
    allowBash?: boolean;              // 기본 true
    allowEdit?: boolean;              // 기본 true
    allowWrite?: boolean;             // 기본 true
    maxBackgroundTasks?: number;      // 기본 5
  };
  routing: {
    enabled?: boolean;                // 기본 true
    defaultTier?: 'LOW' | 'MEDIUM' | 'HIGH';  // 기본 MEDIUM
    forceInherit?: boolean;           // 기본 false (비-Claude 시 auto true)
    escalationEnabled?: boolean;      // 기본 true
    maxEscalations?: number;          // 기본 2
    tierModels?: { LOW?, MEDIUM?, HIGH? };
    agentOverrides?: Record<string, { tier, reason }>;
    modelAliases?: { haiku?, sonnet?, opus? };
    escalationKeywords?: string[];
    simplificationKeywords?: string[];
  };
  // ... delegationRouting, externalModels, planOutput, guards, taskSizeDetection
}
```

### src/config/loader.ts (887줄) — 설정 로더

**buildDefaultConfig() 핵심 기본값:**

| 에이전트 | 기본 티어 |
|---------|----------|
| omc, analyst, planner, architect, codeReviewer, codeSimplifier, critic | HIGH (Opus) |
| debugger, executor, verifier, securityReviewer, testEngineer, designer, qaTester, scientist, tracer, gitMaster, documentSpecialist | MEDIUM (Sonnet) |
| explore, writer | LOW (Haiku) |

**에스컬레이션 키워드 (하드코딩):**
```
"critical", "production", "urgent", "security", "breaking",
"architecture", "refactor", "redesign", "root cause"
```

**단순화 키워드 (하드코딩):**
```
"find", "list", "show", "where", "search", "locate", "grep"
```

**외부 모델 기본값:**
```
codexModel: "gpt-5.3-codex"
geminiModel: "gemini-3.1-pro-preview"
```

**isNonClaudeProvider() 감지 로직 [src/config/models.ts:281-321]:**
```
1. OMC_ROUTING_FORCE_INHERIT === 'true' → true
2. isBedrock() → true (CLAUDE_CODE_USE_BEDROCK=1 또는 ARN 패턴)
3. isVertexAI() → true (CLAUDE_CODE_USE_VERTEX=1 또는 vertex_ai/ 접두사)
4. CLAUDE_MODEL/ANTHROPIC_MODEL에 'claude' 없음 → true
5. ANTHROPIC_BASE_URL 설정 + 'anthropic.com' 미포함 → true
```

### src/config/models.ts (322줄) — 모델 티어

**정확한 기본 모델 ID:**
```typescript
HAIKU:  'claude-haiku-4-5'
SONNET: 'claude-sonnet-4-6'
OPUS:   'claude-opus-4-6'
```

**환경변수 해석 체인 (티어별):**
```
LOW:    OMC_MODEL_LOW → CLAUDE_CODE_BEDROCK_HAIKU_MODEL → ANTHROPIC_DEFAULT_HAIKU_MODEL
MEDIUM: OMC_MODEL_MEDIUM → CLAUDE_CODE_BEDROCK_SONNET_MODEL → ANTHROPIC_DEFAULT_SONNET_MODEL
HIGH:   OMC_MODEL_HIGH → CLAUDE_CODE_BEDROCK_OPUS_MODEL → ANTHROPIC_DEFAULT_OPUS_MODEL
```

### src/agents/definitions.ts (405줄) — 에이전트 등록

**모델 해석 우선순위 (253-264줄):**
```
1. options.overrides?.[name].model (최우선)
2. inheritModel (forceInherit 시: CLAUDE_MODEL || ANTHROPIC_MODEL)
3. config.agents[key].model (설정 파일)
4. agent.defaultModel (폴백)
```

**parseDisallowedTools() — 에이전트 마크다운 프론트매터에서 도구 차단 파싱:**
```yaml
# agents/analyst.md 예시
---
name: analyst
model: claude-opus-4-6
disallowedTools: Write, Edit
---
```

### src/features/delegation-enforcer.ts (305줄) — 모델 강제

**enforceModel() 핵심 로직:**
```
1. subagent_type 정규화 (oh-my-claudecode: 접두사 처리)
2. forceInherit → model 필드 제거 (부모 모델 상속)
3. 명시적 model → CC alias로 정규화 (sonnet/opus/haiku)
4. 없으면:
   - 에이전트 정의에서 기본 모델 조회
   - modelAliases 적용 (설정에 있으면)
   - 'inherit' → model 필드 제거
   - CC alias로 정규화
5. modifiedInput + injected 플래그 반환
```

### src/features/continuation-enforcement.ts (197줄) — 지속 실행

**시스템 프롬프트 추가 핵심 (THE BOULDER NEVER STOPS):**
```
4가지 신성한 규칙:
1. 미완료 작업 절대 포기 금지
2. 검증 필수
3. 차단 요소는 극복 대상
4. 완료 체크리스트

중단 가능 조건:
1. 모든 TodoWrite 항목 완료
2. 검증 완료 (주장 아닌 증거)
3. 더 이상 에러 없음
```

**완료 신호 감지 (139-181줄):**
```javascript
// 완료 패턴
/all (?:tasks?|work|items?) (?:are |is )?(?:now )?(?:complete|done|finished)/i
/I(?:'ve| have) (?:completed|finished|done) (?:all|everything)/i

// 불확실성 패턴 → confidence 낮춤
/(?:should|might|could) (?:be|have)/i
/I think|I believe|probably|maybe/i
```

### src/features/background-tasks.ts (357줄) — 백그라운드 결정

**백그라운드 실행 패턴 (LONG_RUNNING, 30-69줄):**
```
npm/yarn/pnpm/bun install|ci|update
pip install, cargo build|test, go build|test
tsc, webpack, rollup, esbuild, vite build
jest, mocha, vitest, pytest
docker build|pull|push, docker-compose
prisma migrate, typeorm migration
eslint, prettier (대규모), git clone|fetch|pull
```

**포그라운드 실행 패턴 (BLOCKING, 75-101줄):**
```
git status|diff|log|branch
ls, pwd, cat, echo, head, tail, wc, which
cp, mv, rm, mkdir, touch
env, printenv, node -v, npm -v, python --version
```

---

## 6. 에이전트 시스템

### 전체 에이전트 카탈로그 (정밀 명세)

#### Tier 1 — Haiku (빠른 조회)

**explore** (claude-haiku-4-5, READ-ONLY)
- 역할: 코드베이스 검색, 파일/패턴/관계 발견
- 핵심 규칙: 모든 경로 절대경로, 3+ 병렬 검색, 2라운드 후 수확 체감 시 중단
- 컨텍스트 보호: 200줄 이상 → `lsp_document_symbols`, 500줄 이상 → 반드시 symbols
- 도구 우선순위: Glob → Grep → ast_grep_search → lsp_document_symbols

**writer** (claude-haiku-4-5)
- 역할: 기술 문서, README, API 문서, 가이드
- 핵심 규칙: 모든 코드 예시 테스트 검증, 모든 커맨드 실행 검증, 기존 스타일 매칭

#### Tier 2 — Sonnet (표준 구현)

**executor** (claude-sonnet-4-6)
- 역할: 코드 구현 (가장 작은 유효한 변경)
- 서킷 브레이커: 3회 실패 → architect 에스컬레이션
- 제약: 단일 사용 로직 추상화 금지, 디버그 코드 남기기 금지
- 작업 분류: trivial (직접) / scoped (TodoWrite 2+ 단계) / complex (explore 먼저)

**debugger** (claude-sonnet-4-6, READ-ONLY)
- 프로토콜: REPRODUCE → GATHER EVIDENCE (병렬) → HYPOTHESIZE → FIX → CIRCUIT BREAKER
- 서킷 브레이커: 3회 실패 가설 → architect 에스컬레이션
- 성공 기준: 근본 원인 식별, 모든 에러 수정, 빌드 exit 0, 변경 < 5%

**tracer** (claude-sonnet-4-6, READ-ONLY)
- 증거 계층: 통제된 재현 > 1차 아티팩트(file:line) > 다중 출처 수렴 > 코드 추론 > 정황 > 추측
- 반증 의무: 각 가설에 대해 능동적으로 반증 증거 탐색
- 기본 레인: 코드 경로, 설정/환경, 측정/아티팩트/가정 불일치

**verifier** (claude-sonnet-4-6, READ-ONLY)
- 판정: PASS | FAIL | INCOMPLETE + confidence
- 핵심: "should/probably/seems" 언어 사용 금지, 신선한 증거만

**qa-tester** (claude-sonnet-4-6)
- tmux 세션으로 대화형 CLI 테스트
- 세션 이름: `qa-{service}-{test}-{timestamp}`
- 항상 정리 (실패 시에도)

**test-engineer** (claude-sonnet-4-6)
- 피라미드: 70% 단위, 20% 통합, 10% e2e
- TDD 철칙: 실패하는 테스트 없이 프로덕션 코드 금지
- RED → GREEN → REFACTOR 사이클

**designer** (claude-sonnet-4-6)
- 안티 패턴: 제네릭 폰트 (Arial/Inter/Roboto), 보라색 그래디언트 (AI 슬롭), 쿠키커터 레이아웃

**git-master** (claude-sonnet-4-6)
- 커밋 분할: 3+ 파일 → 2+ 커밋, 5+ → 3+, 10+ → 5+
- 스타일 감지: 최근 30개 커밋에서 패턴 추출
- --force-with-lease만 (절대 --force 아님)

**document-specialist** (claude-sonnet-4-6, READ-ONLY)
- 소스 우선순위: 로컬 문서 > Context Hub > 큐레이션 백엔드 > WebSearch/WebFetch

**scientist** (claude-sonnet-4-6, READ-ONLY)
- 모든 Python은 python_repl로 (절대 Bash heredoc 아님)
- 출력 마커: [OBJECTIVE], [DATA], [FINDING], [STAT:*], [LIMITATION]

**code-simplifier** (claude-opus-4-6)
- 원칙: 코드가 하는 일은 절대 변경하지 않음 — 하는 방식만 변경
- 스타일: ES modules, function 키워드, 명시적 반환 타입, camelCase

#### Tier 3 — Opus (심층 분석)

**analyst** (claude-opus-4-6, READ-ONLY)
- 출력: 누락 질문, 미정의 가드레일, 범위 위험, 미검증 가정, 누락 기준, 엣지 케이스
- 핸드오프: Analyst → Planner | Architect | Critic

**architect** (claude-opus-4-6, READ-ONLY)
- 모든 주장에 file:line 참조 필수
- 서킷 브레이커: 3회 실패 가설 후 에스컬레이션
- 합의 리뷰: steelman antithesis + 실제 트레이드오프 텐션 + 합성 시도

**planner** (claude-opus-4-6)
- 절대 코드 작성 금지, 계획만 `.omc/plans/*.md`에 저장
- 인터뷰: 한 번에 한 질문만, 코드베이스 사실은 explore에게
- 3-6 실행 가능 단계 (세분화도 모호함도 아닌)
- 합의 모드: RALPLAN-DR (원칙 3-5, 동인 top 3, 옵션 ≥2)

**critic** (claude-opus-4-6, READ-ONLY)
- 5단계: 사전 예측 → 검증 → 멀티 관점 → 갭 분석 → 자기 감사
- 에스컬레이션: CRITICAL 1+ 또는 MAJOR 3+ → ADVERSARIAL 모드
- 현실 점검 필수: 심각도를 실제 최악 사례 + 완화 요소와 대조
- 판정: REJECT | REVISE | ACCEPT-WITH-RESERVATIONS | ACCEPT

**code-reviewer** (claude-opus-4-6, READ-ONLY)
- 2단계: 스펙 준수 MUST PASS → 코드 품질 (lsp_diagnostics 포함)
- 심각도: CRITICAL, HIGH, MEDIUM, LOW (CRITICAL/HIGH → 절대 승인 불가)
- 판정: APPROVE | REQUEST CHANGES | COMMENT

**security-reviewer** (claude-opus-4-6, READ-ONLY)
- OWASP Top 10 전체 평가
- 우선순위: Severity × Exploitability × Blast Radius

---

## 7. 스킬 시스템

### 핵심 스킬 정밀 명세

#### autopilot — 5단계 자율 파이프라인

```
Phase 0: 확장 — analyst + architect (ralplan 계획 있으면 건너뜀)
Phase 1: 계획 — omc-plan --direct (deep-interview 스펙 있으면 건너뜀)
Phase 2: 실행 — Ralph + Ultrawork 병렬
Phase 3: QA — UltraQA 사이클링 (최대 5회)
Phase 4: 검증 — architect + security-reviewer + code-reviewer 병렬
Phase 5: 정리 — 상태 파일 삭제, /oh-my-claudecode:cancel
```

**건너뛰기 감지:**
- `.omc/plans/ralplan-*.md` 또는 `.omc/plans/consensus-*.md` 존재 → Phase 0+1 스킵
- `.omc/specs/deep-interview-*.md` 존재 → Phase 0 스킵

#### ralph — 지속적 실행 루프

```
1. PRD 설정: prd.json 읽기/생성, 수용 기준 구체화
2. 스토리 선택: passes: false인 다음 스토리
3. 구현: 에이전트 티어별 위임 (haiku/sonnet/opus)
4. 검증: 각 스토리 수용 기준 신선한 증거로 확인
5. 완료 표시: passes: true, 진행 기록
6. PRD 완료 확인: 모든 스토리 true → Step 7
7. 리뷰어 검증 (티어링):
   - <5 파일: sonnet 최소
   - 표준: sonnet
   - >20 파일: opus
7.5. **필수** deslop 패스: Skill("ai-slop-cleaner") ← Task가 아님!
7.6. 회귀 재검증
8. /oh-my-claudecode:cancel
```

**핵심**: 7→7.5→7.6→8은 **한 턴에** 실행 (중간 보고 일시정지 없음)

#### deep-interview — 소크라테스식 모호성 게이팅

```
모호성 스코어링:
- 그린필드: 목표×0.4 + 제약×0.3 + 기준×0.3
- 브라운필드: 목표×0.35 + 제약×0.25 + 기준×0.25 + 컨텍스트×0.15

임계값: 20% 이하 → 실행 가능

도전 에이전트:
- 라운드 4: Contrarian (반론자)
- 라운드 6: Simplifier (단순화자)
- 라운드 8+: Ontologist (모호성 > 0.3일 때)

온톨로지 추적: 엔티티 수, 안정성 비율, 라운드별 신규/변경/안정

출력: .omc/specs/deep-interview-{slug}.md
```

#### ralplan — 합의 기획

```
Planner → Architect (steelman + 트레이드오프) → Critic (원칙/옵션 일관성)
→ 루프 (최대 5회)

RALPLAN-DR 구조:
- 원칙 3-5개
- 결정 동인 top 3
- 실행 가능 옵션 ≥2 (또는 명시적 무효화)

--deliberate: 사전 사후 분석(3 시나리오) + 확장 테스트 계획
--architect codex: Codex를 architect로 사용
--interactive: 초안과 최종 승인에서 사용자 프롬프트

최종 ADR: 결정, 동인, 대안, 선택 이유, 결과, 후속 조치
```

#### cancel — 지능적 취소

```
감지 순서: Autopilot → Ralph → Ultrawork → UltraQA → Swarm → Pipeline → Team
의존성 순서로 정리 (상위 모드 먼저)

세션 인식: .omc/state/sessions/{sessionId}/
레거시 폴백: .omc/state/

--force: 모든 세션 + 레거시 아티팩트 전체 삭제
--all: 동일

팀 처리: 2패스 (graceful shutdown_request → reconciliation → TeamDelete)
최종: 항상 skill-active 상태 클리어 (stop hook 재발 방지)
```

---

## 8. MCP 도구 서버

### 도구 비활성화 매핑 (정확)

```typescript
// OMC_DISABLE_TOOLS 환경변수의 그룹명 → 카테고리 매핑
'lsp' → LSP 도구 12개
'ast' → AST 도구 2개
'python' | 'python-repl' → Python REPL 1개
'trace' → 추적 도구
'state' → 상태 관리 도구
'notepad' → 노트패드 도구
'memory' | 'project-memory' → 프로젝트 메모리 도구
'skills' → 스킬 관리 도구
'interop' → 상호운용 도구
'shared-memory' → 공유 메모리 도구
'deepinit' | 'deepinit-manifest' → DeepInit 도구
'wiki' → Wiki 도구
```

### LSP 도구 구현 상세 (src/tools/lsp-tools.ts, 506줄)

```typescript
async function withLspClient<T>(
  filePath: string,
  operation: string,
  fn: (client) => Promise<T>
) → { content: [{ type: 'text'; text: string }] }
```
- 싱글톤 LSP 클라이언트 per 언어
- `lspClientManager.runWithClientLease()` — idle 퇴거 방지
- 언어 서버 자동 발견 + DevContainer 지원

### AST 도구 (src/tools/ast-tools.ts, 650줄)

```typescript
// @ast-grep/napi 모듈 로딩 (CJS createRequire 사용)
let sgModule: typeof import("@ast-grep/napi") | null = null;
let sgLoadFailed = false;
async function getSgModule() → sgModule | null
```
- 25+ 언어 지원
- `OMC_RESTRICT_TOOL_PATHS` → 프로젝트 루트 내로 경로 제한

### Python REPL (src/tools/python-repl/, 5파일)

```typescript
interface PythonReplInput {
  action: 'execute' | 'interrupt' | 'reset' | 'get_state';
  researchSessionID: string;
  code?: string;
  executionTimeout?: number;    // 기본 300000ms (5분)
  queueTimeout?: number;        // 기본 30000ms (30초)
}
```
- `bridge/gyoshu_bridge.py`가 소켓 서버
- 변수 영속 (세션 간)
- 메모리 추적 (RSS/VMS)

---

## 9. 상태 관리

### 정확한 구현 (src/features/state-manager/, 819줄)

```typescript
// 캐시 설정
STATE_CACHE_TTL_MS = 5_000    // 5초
MAX_CACHE_SIZE = 200           // 최대 항목

// 파일 락
LOCK_STALE_MS = 30_000        // 30초 스테일 락 해제
LOCK_TIMEOUT_MS = 5_000       // 5초 획득 데드라인
LOCK_POLL_MS = 10             // 10ms busy-wait

// 스테일 감지
STATE_MAX_AGE_MS = 4 * 60 * 60 * 1000  // 4시간
// updatedAt AND heartbeatAt 모두 오래돼야 스테일
// 하나라도 최근이면 살아있음 (장기 워크플로우 지원)
```

**읽기 흐름:**
```
readState(name) {
  1. 캐시 확인 (5초 TTL + mtime TOCTOU 체크)
  2. 표준 위치: .omc/state/{name}.json
  3. 레거시 위치 폴백 (checkLegacy: true)
  4. 메타데이터와 함께 반환
}
```

**쓰기 흐름:**
```
writeState(name, data) {
  1. 캐시 무효화
  2. 파일 락 획득 (O_EXCL, 30초 스테일 자동 해제)
  3. 임시 파일 + fsync + atomic rename
  4. 디렉토리 fsync (best-effort)
  5. 락 해제
}
```

### persistent-mode.cjs 정확한 차단 로직 (1321줄)

| 모드 | 차단 조건 | 재차단 제한 | TTL |
|------|----------|-----------|-----|
| ralph | active=true, iteration < max, !awaiting_confirmation | 무제한 | 없음 |
| autopilot | active=true, !awaiting_confirmation | 무제한 | 없음 |
| ultrawork | active=true, !awaiting_confirmation | 무제한 | 없음 |
| ultraqa | active=true, !awaiting_confirmation | 무제한 | 없음 |
| team/pipeline | active=true, 비-터미널 phase | 20회 | 5분 |
| ralplan | active=true, 비-터미널 phase | 30회 | 45분 |

**터미널 phase:**
```
"completed", "complete", "failed", "cancelled", "canceled",
"aborted", "terminated", "done"
```

**절대 차단하지 않는 경우:**
- 컨텍스트 리밋 중단
- 사용자 abort
- 인증 에러
- 스테일 상태 (>2시간)
- 취소 신호 진행 중
- 세션 ID 불일치
- 프로젝트 경로 불일치

**awaiting_confirmation TTL:** 2분 (120000ms) — 키워드 감지 시 설정, 사용자 계속 시 해제

---

## 10. 팀 오케스트레이션

### 파일 규모: 56 소스 파일, ~16K LOC

### 핵심 통신 프로토콜

**경로 구조:**
```
~/.claude/teams/{teamName}/
  inbox/{workerName}.jsonl        # 리더 → 워커
  inbox/{workerName}.offset       # 바이트 커서 (증분 읽기)
  outbox/{workerName}.jsonl       # 워커 → 리더
  signals/{workerName}.shutdown   # 종료 요청
  signals/{workerName}.drain      # 드레인 요청
```

**메시지 형식:**
```typescript
// Inbox (리더 → 워커)
{ type: 'message' | 'context', content: string, timestamp: string }

// Outbox (워커 → 리더)
{ type: 'ready' | 'task_complete' | 'task_failed' | 'idle' |
        'shutdown_ack' | 'drain_ack' | 'heartbeat' | 'error' |
        'all_tasks_complete',
  taskId?, summary?, message?, error?, requestId?, timestamp }
```

**커서 모델:** 바이트 오프셋 기반 (줄 기반 아님) — CRLF/LF 처리 + 파일 truncation 시 리셋

### 작업 라우팅 (task-router.ts)

**적합도 스코어링:**
```
정확 매치: 1.0 / 요구 능력
제네릭 와일드카드: 0.5 / 요구 (worker가 'general' 보유 시)
부하 패널티: -0.2 × 할당된 작업 수
유휴 보너스: +0.1
의도 보너스: +0.3 (worker 역할이 레인 의도와 일치)
최종: 정규화 [0, 1]
```

### 워커 능력 기본값

| 백엔드 | 기본 능력 |
|--------|----------|
| claude-native | code-edit, testing, general |
| mcp-codex / tmux-codex | code-review, security-review, architecture, refactoring |
| mcp-gemini / tmux-gemini | ui-design, documentation, research, code-edit |

### 런타임 V2 (runtime-v2.ts, 1389줄)

- **피처 플래그:** `OMC_RUNTIME_V2` (기본: 활성화, '0'/'false'/'no'/'off'로 비활성화)
- V1 대비 차이: done.json 폴링 워치독 없음, 이벤트 기반 (CLI API 전이), 모니터 스냅샷 + 델타

---

## 11. 매직 키워드 감지 알고리즘

### keyword-detector.mjs (891줄) 정밀 분석

**입력 정제 (오탐 방지):**
```
1. XML/HTML 주석 제거: <!--...-->
2. XML 태그 제거: <name ...>...</name>, <name />
3. URL 제거: http://, https://
4. 블록 인용 제거: > ...
5. 마크다운 테이블 제거
6. 파일 경로 제거: /foo/bar
7. 코드 블록 제거: ```...```
8. 인라인 코드 제거: `...`
```

**정보 의도 감지 (트리거 억제):**
- 인용 안의 키워드 + 바깥의 질문 패턴 → 억제
- 블록 인용/테이블 안의 키워드 → 억제
- 참조 메타 패턴 (vs., article, docs, blog) + 설명 형태 → 억제
- 다중 모드 언급 + 질문 → 억제

**안티 슬롭 트리거:**
```
EXPLICIT: \b(ai[\s-]?slop|anti[\s-]?slop|deslop)\b
ACTION: \b(clean|cleanup|refactor|simplify|dedupe)\b
SMELL: \b(slop|duplicate|dead\s+code|unused\s+code|wrapper\s+layers?|ai[\s-]?generated)\b

트리거: EXPLICIT OR (ACTION AND SMELL)
```

**상태 파일 생성 (세션 스코프):**
```
세션 ID 유효 시 (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/):
  .omc/state/sessions/{sessionId}/{mode}-state.json
레거시 폴백:
  .omc/state/{mode}-state.json
```

### magic-keywords.ts (489줄) 4개 매직 키워드

| 키워드 | 트리거 | 효과 |
|--------|--------|------|
| ultrawork | `ultrawork`, `ulw`, `uw` | Planner → 도구 제한 (.omc/ 외 Write/Edit 차단), 연구-우선; Non-planner → 에이전트 활용 + TDD + 검증 |
| search | `search`, `find`, `locate` + 14개 더 | 병렬 에이전트 + 도구로 탐색 모드 |
| analyze | `analyze`, `investigate` + 17개 더 | 컨텍스트 수집 + 복잡성 시 architect 에스컬레이션 |
| ultrathink | `ultrathink`, `think`, `reason`, `ponder` | [ULTRATHINK MODE] 심층 추론 지시 |

**컨텍스트 감지 (45-61줄):**
```javascript
function hasActionableTrigger(text, trigger) {
  // ±80자 컨텍스트에서 정보 의도 패턴 확인
  // 정보 의도(what is, explain 등) 내에 있으면 → 트리거 안 함
}
```

---

## 12. 설정 시스템

### 전체 환경변수 맵

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `OMC_MODEL_HIGH` | claude-opus-4-6 | Opus 티어 |
| `OMC_MODEL_MEDIUM` | claude-sonnet-4-6 | Sonnet 티어 |
| `OMC_MODEL_LOW` | claude-haiku-4-5 | Haiku 티어 |
| `OMC_MODEL_ALIAS_HAIKU` | — | Haiku 앨리어스 |
| `OMC_MODEL_ALIAS_SONNET` | — | Sonnet 앨리어스 |
| `OMC_MODEL_ALIAS_OPUS` | — | Opus 앨리어스 |
| `OMC_ROUTING_ENABLED` | true | 스마트 라우팅 |
| `OMC_ROUTING_FORCE_INHERIT` | false | 모델 파라미터 제거 |
| `OMC_ROUTING_DEFAULT_TIER` | MEDIUM | 기본 티어 |
| `OMC_ESCALATION_ENABLED` | true | 에스컬레이션 |
| `OMC_PARALLEL_EXECUTION` | true | 병렬 실행 |
| `OMC_LSP_TOOLS` | true | LSP 도구 활성화 |
| `OMC_MAX_BACKGROUND_TASKS` | 5 | 최대 백그라운드 작업 |
| `OMC_DISABLE_TOOLS` | — | 도구 카테고리 비활성화 |
| `OMC_DEBUG` | — | 상세 로깅 |
| `OMC_QUIET` | 0 | 출력 억제 수준 |
| `DISABLE_OMC` | — | 전체 비활성화 |
| `OMC_SKIP_HOOKS` | — | 특정 훅 비활성화 |
| `OMC_SECURITY` | — | strict → 200회 반복 하드 맥스 |
| `OMC_TEAM_WORKER` | — | 팀 워커 표시 |
| `OMC_RUNTIME_V2` | 활성화 | V2 런타임 (off/false/no/0으로 비활성화) |
| `OMC_CONTEXT_GUARD_THRESHOLD` | 75 | 컨텍스트 경고 % |
| `OMC_PREEMPTIVE_COMPACTION_WARNING_PERCENT` | 70 | 선제 경고 % |
| `OMC_PREEMPTIVE_COMPACTION_CRITICAL_PERCENT` | 90 | 선제 임계 % |
| `OMC_PREEMPTIVE_COMPACTION_COOLDOWN_MS` | 60000 | 알림 쿨다운 |
| `OMC_AGENT_OUTPUT_ANALYSIS_LIMIT` | 12000 | 에이전트 출력 분석 크기 |
| `OMC_AGENT_OUTPUT_SUMMARY_LIMIT` | 360 | 에이전트 출력 요약 크기 |
| `OMC_RESTRICT_TOOL_PATHS` | — | AST 도구 경로 제한 |
| `OMC_INTEROP_TOOLS_ENABLED` | — | 상호운용 도구 활성화 |
| `EXA_API_KEY` | — | Exa 검색 API 키 |
| `OMC_OPENCLAW` | — | OpenClaw 활성화 |
| `OMC_OPENCLAW_DEBUG` | — | OpenClaw 디버그 |

---

## 13. 핵심 워크플로우 상세

### 3단계 추천 파이프라인

```
deep-interview (모호성 ≤ 20%)
    ↓ .omc/specs/deep-interview-{slug}.md
ralplan --consensus (Planner → Architect → Critic, 최대 5회)
    ↓ .omc/plans/ralplan-*.md 또는 .omc/plans/consensus-*.md
autopilot Phase 2+ (Phase 0+1 건너뜀)
    ↓ 실행 → QA → 검증
```

### 커밋 프로토콜

```
fix(auth): prevent silent session drops during long-running ops

Auth service returns inconsistent status codes on token expiry.

Constraint: Auth service does not support token introspection
Rejected: Extend token TTL to 24h | security policy violation
Confidence: high
Scope-risk: narrow
Directive: Error handling is intentionally broad — do not narrow
Not-tested: Auth service cold-start latency >500ms
```

---

## 14. 빌드 시스템

```bash
npm run build
# 순서:
# 1. tsc → dist/
# 2. scripts/build-skill-bridge.mjs → 스킬 브릿지 번들
# 3. scripts/build-mcp-server.mjs → bridge/mcp-server.cjs (957KB)
# 4. scripts/build-bridge-entry.mjs → 브릿지 엔트리
# 5. scripts/compose-docs.mjs → 문서 조합
# 6. scripts/build-runtime-cli.mjs → bridge/runtime-cli.cjs (240KB)
# 7. scripts/build-team-server.mjs → bridge/team-mcp.cjs (657KB)
# 8. scripts/build-cli.mjs → bridge/cli.cjs (3.1MB)
```

모든 빌드는 **esbuild**로 TypeScript → 단일 CommonJS 파일. `better-sqlite3` 등 네이티브 모듈은 external.

---

## 15. 하드코딩된 상수 & 임계값 전체 목록

| 상수 | 값 | 위치 |
|------|------|------|
| permissionMode | 'acceptEdits' | src/index.ts:363 |
| 기본 allowedTools | Read,Glob,Grep,WebSearch,WebFetch,Task,TodoWrite | src/index.ts:312 |
| STATE_CACHE_TTL_MS | 5,000 (5초) | state-manager |
| MAX_CACHE_SIZE | 200 | state-manager |
| LOCK_STALE_MS | 30,000 (30초) | state-manager |
| LOCK_TIMEOUT_MS | 5,000 (5초) | state-manager |
| LOCK_POLL_MS | 10 (10ms) | state-manager |
| STATE_MAX_AGE_MS | 14,400,000 (4시간) | state-manager |
| STALE_STATE_THRESHOLD_MS | 7,200,000 (2시간) | persistent-mode |
| AWAITING_CONFIRMATION_TTL_MS | 120,000 (2분) | persistent-mode |
| TEAM_STOP_BLOCKER_MAX | 20회 | persistent-mode |
| RALPLAN_STOP_BLOCKER_MAX | 30회 | persistent-mode |
| TEAM_PIPELINE_TTL | 300초 (5분) | persistent-mode |
| RALPLAN_TTL | 2700초 (45분) | persistent-mode |
| DEFAULT_MAX_BACKGROUND_TASKS | 5 | background-tasks |
| maxEscalations | 2 | config/loader |
| MAX_INBOX_READ_SIZE | 10MB | team/inbox-outbox |
| OUTBOX_MAX_LINES | 500 | team/types |
| POLL_INTERVAL_MS | 3,000 (3초) | team/types |
| TASK_TIMEOUT_MS | 600,000 (10분) | team/types |
| HEARTBEAT_MAX_AGE_MS | 30,000 (30초) | team/worker-health |
| FITNESS_LOAD_PENALTY | 0.2 | team/task-router |
| FITNESS_IDLE_BONUS | 0.1 | team/task-router |
| FITNESS_INTENT_BONUS | 0.3 | team/task-router |
| MAX_SKILLS_PER_SESSION | 5 | skill-injector |
| FALLBACK_SESSION_TTL_MS | 3,600,000 (1시간) | skill-injector |
| DEFAULT_TIMEOUT_MS (OpenClaw) | 10,000 (10초) | openclaw |
| INTEROP_ARTIFACT_THRESHOLD_BYTES | 2,048 (2KB) | interop |
| CONTEXT_GUARD_THRESHOLD | 75% | context-guard-stop |
| CRITICAL_THRESHOLD | 95% | context-guard-stop |
| PREEMPTIVE_WARNING | 70% | post-tool-verifier |
| PREEMPTIVE_CRITICAL | 90% | post-tool-verifier |
| PREEMPTIVE_COOLDOWN | 60초 | post-tool-verifier |
| explore 컨텍스트 보호 | 200줄 symbols, 500줄 필수 | explore agent |
| git-master 커밋 분할 | 3+→2+, 5+→3+, 10+→5+ | git-master agent |
| test-engineer 피라미드 | 70%단위/20%통합/10%e2e | test-engineer agent |
| deep-interview 모호성 임계 | 20% | deep-interview skill |
| deep-interview 소프트 경고 | 10라운드 | deep-interview skill |
| deep-interview 하드 캡 | 20라운드 | deep-interview skill |
| ralplan 최대 반복 | 5회 | ralplan skill |
| ultraqa 최대 사이클 | 5회 | ultraqa skill |

---

## 16. 의존성 분석

| 패키지 | 용도 | 핵심 여부 |
|--------|------|----------|
| `@anthropic-ai/claude-agent-sdk` | Agent SDK 통합 | 핵심 |
| `@modelcontextprotocol/sdk` | MCP 프로토콜 | 핵심 |
| `@ast-grep/napi` | AST 분석 (25+ 언어) | 선택 |
| `better-sqlite3` | 영속성 (swarm) | 선택 |
| `zod` | 런타임 타입 검증 | 핵심 |
| `ajv` | JSON 스키마 검증 | 보조 |
| `chalk` | CLI 색상 | 보조 |
| `commander` | CLI 파싱 | 보조 |
| `jsonc-parser` | JSONC 설정 | 핵심 |
| `vscode-languageserver-protocol` | LSP | 선택 |
| `safe-regex` | 정규식 안전성 | 보조 |

---

## 17. 핵심 인사이트 — 설계 판단과 교훈

### 인사이트 1: Hook은 "조언"이지 "명령"이 아님

OMC의 모든 Hook은 `<system-reminder>` 태그를 통해 Claude의 **컨텍스트에 정보를 주입**할 뿐, 직접 코드를 실행하거나 Claude의 동작을 강제하지 않음. 유일한 예외는 persistent-mode의 Stop 차단 (`continue: false`).

**교훈**: Claude Code 플러그인의 영향력은 "프롬프트 엔지니어링의 자동화"에 있다. Hook이 주입하는 system-reminder가 얼마나 잘 설계되었느냐가 전체 시스템의 품질을 결정.

### 인사이트 2: 에이전트 프롬프트의 "실패 모드" 섹션이 핵심

모든 에이전트 마크다운에 `Failure_Modes_To_Avoid` 섹션이 있음. 이것은 실제 운영에서 발생한 문제를 문서화한 것:
- architect: "armchair analysis" (코드 안 읽고 분석)
- debugger: "symptom fixing" (근본 원인 대신 증상 수정)
- critic: "rubber-stamping" (형식적 승인)
- executor: "scope creep" (범위 확장)

**교훈**: 에이전트 프롬프트를 처음부터 완벽하게 쓸 수 없다. 운영하면서 실패 모드를 발견하고 명시적으로 금지하는 반복 과정이 필수.

### 인사이트 3: "The Boulder Never Stops"는 핵심 가치

Sisyphus 테마가 프로젝트 전체에 스며들어 있음:
- `continuationSystemPromptAddition`: "THE BOULDER NEVER STOPS"
- persistent-mode: 미완료 시 물리적으로 중단 차단
- ralph: PRD 기반 스토리별 추적으로 "부분 완료" 방지
- omcSystemPrompt: "You are BOUND to your task list. You do not stop."

**교훈**: AI 에이전트의 가장 큰 문제는 "중간에 포기하는 것". 지속성을 시스템 수준에서 강제하는 것이 OMC의 핵심 차별화.

### 인사이트 4: 3-티어 모델 라우팅이 비용 최적화의 핵심

```
Haiku (저가): 탐색, 문서 → 빠르고 싸게
Sonnet (중간): 구현, 디버깅, 테스트 → 대부분의 작업
Opus (고가): 분석, 설계, 리뷰, 합의 → 중요한 판단만
```

에스컬레이션/단순화 키워드로 동적 조정:
- "critical", "production" → Opus로 에스컬레이션
- "find", "list", "search" → Haiku로 단순화

**교훈**: 모든 작업에 최강 모델을 쓰는 것은 낭비. 작업 성격에 맞는 모델 라우팅이 30-50% 비용 절약.

### 인사이트 5: 상태 관리의 "원자적 쓰기 + 파일 락"

```
임시 파일 (.{name}.tmp.{uuid}) → fsync → atomic rename
O_EXCL 파일 락 → 30초 스테일 자동 해제 → 10ms busy-wait
mtime TOCTOU 체크 → 캐시 무효화
```

**교훈**: 다중 프로세스 환경 (팀 모드)에서 JSON 상태 파일의 무결성은 원자적 쓰기 + 파일 락으로만 보장 가능. SQLite를 쓸 수도 있지만, 단순 JSON + 락이 이식성과 디버깅에 유리.

### 인사이트 6: 스킬은 "마크다운 프롬프트"이지 "코드"가 아님

skills/*/SKILL.md는 순수 마크다운. 코드가 아님. Claude가 이 마크다운을 읽고 지시를 따르는 것이 전부. 이것이 의미하는 것:
- 스킬 추가/수정에 코드 변경 불필요
- 프롬프트 엔지니어링만으로 새로운 워크플로우 생성 가능
- 사용자도 `.omc/skills/`에 자신만의 스킬 추가 가능

**교훈**: 복잡한 오케스트레이션도 결국 "잘 설계된 프롬프트"로 귀결. 코드보다 프롬프트가 핵심 자산.

### 인사이트 7: 비-Claude 프로바이더 자동 감지

Bedrock, Vertex AI, LiteLLM, 커스텀 BASE_URL 등을 자동 감지해서 `forceInherit`를 활성화. 모델 파라미터를 제거해서 400 에러 방지.

**교훈**: 다양한 배포 환경을 지원하려면 "감지 → 적응" 로직이 필수. 사용자에게 수동 설정을 강요하면 안 됨.

### 인사이트 8: 팀 모드의 JSONL inbox/outbox가 IPC보다 나은 이유

프로세스 간 통신에 소켓이나 gRPC 대신 **파일 기반 JSONL**을 선택:
- 디버깅 용이 (cat으로 바로 확인)
- 프로세스 크래시 시 메시지 보존
- 바이트 오프셋 커서로 증분 읽기 (CRLF/LF 무관)
- 팀 상태 전체를 디렉토리 구조로 표현 (검사 가능)

**교훈**: 복잡한 IPC 프로토콜보다 파일 기반 통신이 운영 안정성과 디버깅에 유리할 수 있음.

---

## 18. 리빌드 가이드

### 최소 MVP (3개 파일로 시작)

```
my-plugin/
├── .claude-plugin/plugin.json     ← 매니페스트
├── .mcp.json                      ← MCP 서버 등록
├── hooks/hooks.json               ← Hook 정의
├── scripts/
│   ├── run.cjs                    ← Hook 실행기
│   └── keyword-detector.mjs       ← 키워드 감지
└── skills/
    └── my-skill/SKILL.md          ← 스킬 프롬프트
```

이것만으로 작동하는 플러그인. MCP 서버 없이도 Hook + 스킬만으로 상당한 기능 구현 가능.

### 구현 우선순위

| 순서 | 컴포넌트 | 난이도 | 임팩트 | 핵심 파일 |
|------|---------|--------|--------|----------|
| 1 | 플러그인 매니페스트 | ⭐ | 필수 | plugin.json, .mcp.json |
| 2 | Hook 시스템 (keyword-detector) | ⭐⭐ | 매우 높음 | hooks.json, run.cjs, keyword-detector.mjs |
| 3 | 스킬 마크다운 | ⭐ | 높음 | skills/*/SKILL.md |
| 4 | 에이전트 프롬프트 | ⭐ | 높음 | agents/*.md |
| 5 | persistent-mode (Stop 차단) | ⭐⭐ | 높음 | persistent-mode.cjs |
| 6 | 상태 관리 | ⭐⭐⭐ | 높음 | state-manager/ |
| 7 | MCP 도구 서버 | ⭐⭐⭐ | 중간 | mcp-server.cjs |
| 8 | 설정 시스템 | ⭐⭐ | 중간 | config/loader.ts |
| 9 | 팀 오케스트레이션 | ⭐⭐⭐⭐ | 중간 | team/ (56파일) |
| 10 | LSP/AST 도구 | ⭐⭐⭐⭐ | 낮음 | lsp-tools.ts, ast-tools.ts |

---

## 19. JuneClaw 응용 전략

### 즉시 적용 가능한 패턴

**1. Hook 기반 생명주기 인터셉트**
```json
// JuneClaw hooks.json
{
  "hooks": {
    "UserPromptSubmit": [
      { "command": "node scripts/trading-keyword-detector.mjs", "timeout": 5000 }
    ],
    "Stop": [
      { "command": "node scripts/trade-verification.mjs", "timeout": 10000 }
    ]
  }
}
```
- "리밸런싱" → 자동 리밸런싱 파이프라인 트리거
- "분석" → 시장 분석 에이전트 체인

**2. 전문 에이전트 프롬프트**
```markdown
# agents/trade-analyst.md (Opus)
주식 시장 분석 전문 에이전트. 기술적 지표 + 펀더멘탈 분석.
성공 기준: 모든 분석에 데이터 출처, 신뢰도, 위험 요소 명시.

# agents/trade-executor.md (Sonnet)
매매 실행 전문 에이전트. Alpaca API 통해 주문 실행.
서킷 브레이커: 3회 연속 실패 → analyst에게 에스컬레이션.
```

**3. 영속 상태로 거래 추적**
```
.omc/state/trading-session.json
.omc/state/portfolio-state.json
```
원자적 쓰기 + 파일 락으로 다중 세션 안전

**4. persistent-mode로 거래 완료 보장**
매매 시작 → 검증 전까지 중단 차단

### 중기 전략: OMC 스킬 직접 활용

JuneClaw 프로젝트에서 OMC를 플러그인으로 설치하고:
- `/autopilot "gwangsu-algo에 새 전략 추가"` → 5단계 자율 구현
- `/ralph "portfolio_manager.py 리팩토링"` → 검증까지 지속
- `/deep-interview "AgiTQ 전략 개선"` → 요구사항 정제

---

> **문서 끝**. 이 문서는 oh-my-claudecode v4.11.6의 소스 코드 전 라인을 정밀 분석한 결과이며, 모든 함수 시그니처, 프로토콜 명세, 하드코딩된 상수, 설계 판단의 근거를 포함합니다.
