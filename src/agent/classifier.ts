import { config } from "../config.js";

export type TaskType = "coding" | "general";

const CODING_COMMAND_PATTERN = /^\/(code|fix|implement|refactor|debug|build|deploy|pr|commit|merge|review)\b/i;

const CODING_KEYWORD_PATTERNS = [
  // English coding keywords
  /\b(PR|pull request|commit|merge|branch|deploy|build|refactor|debug|implement|codebase|function|class|module|endpoint|API|schema|migration|test suite|lint|compile|transpile|CI\/CD)\b/i,
  // Korean coding keywords
  /(코딩|코드|구현|수정해|버그|디버그|리팩터|빌드|배포|커밋|머지|브랜치|풀리퀘|PR 만들|PR 생성|코드리뷰|테스트 작성|에러 수정|타입 에러|빌드 에러)/,
  // File path patterns
  /\b[\w-]+\.(ts|tsx|js|jsx|py|go|rs|java|css|html|json|yaml|yml|toml|sql)\b/,
  // Code-like patterns
  /```[\s\S]*```/,
  // Action + code context
  /(만들어|추가해|변경해|삭제해|고쳐).*(파일|함수|컴포넌트|모듈|클래스|API|엔드포인트|스키마)/,
  /(파일|함수|컴포넌트|모듈|클래스|API|엔드포인트|스키마).*(만들어|추가해|변경해|삭제해|고쳐)/,
];

export function classifyTask(text: string): TaskType {
  if (CODING_COMMAND_PATTERN.test(text.trim())) return "coding";
  for (const pattern of CODING_KEYWORD_PATTERNS) {
    if (pattern.test(text)) return "coding";
  }
  return "general";
}

export function getModelForTask(taskType: TaskType): string {
  const { modelRouting } = config.claude;
  return taskType === "coding" ? modelRouting.codingModel : modelRouting.defaultModel;
}
