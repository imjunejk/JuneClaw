# JuneClaw 설치 가이드

## 요구사항
- macOS (LaunchAgent 사용)
- Node.js 18+
- tmux
- Claude CLI (`claude` command)
- Alpaca 계좌 (주식 거래용)

## 빠른 설치

```bash
git clone https://github.com/imjunejk/gwangsu.git JuneClaw
cd JuneClaw
./setup/install.sh
```

## 수동 설치

### 1. 빌드
```bash
npm install
npm run build
```

### 2. 환경 변수
```bash
cp setup/env.example ../gwangsu/algo/.env
nano ../gwangsu/algo/.env  # API 키 입력
```

### 3. LaunchAgent (자동 시작)
```bash
cp setup/juneclaw.plist.template ~/Library/LaunchAgents/ai.juneclaw.daemon.plist
# {{PROJECT_DIR}}, {{HOME}}, {{USER}} 교체
launchctl load ~/Library/LaunchAgents/ai.juneclaw.daemon.plist
```

### 4. 크론탭
```bash
crontab ../gwangsu/algo/crontab.txt
```

### 5. 메모리 초기화
```bash
# install.sh가 자동으로 하지만, 수동으로 하려면:
mkdir -p ~/.claude/projects/-Users-$(whoami)-JuneClaw/memory
cp memory/bootstrap/juneclaw_*.md ~/.claude/projects/-Users-$(whoami)-JuneClaw/memory/
```

## 확인

```bash
# 데몬 상태
launchctl list | grep juneclaw

# 리모트 컨트롤 (필요시 수동 오픈)
jc rc

# 로그
tail -f ~/.juneclaw/logs/daemon.log
```

## 구조

```
JuneClaw/
├── src/               # TypeScript 소스
├── dist/              # 빌드 결과
├── setup/             # 설치 스크립트
├── memory/bootstrap/  # 초기 메모리 템플릿
├── docs/              # 문서
└── CLAUDE.md          # Claude Code 행동 규칙
```
