#!/bin/bash
set -e

echo "╔══════════════════════════════════════════╗"
echo "║  JuneClaw — 광수 시스템 설치             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOME_DIR="$HOME"

# ── 1. 의존성 체크 ──
echo "[1/8] 의존성 체크..."
missing=()
command -v node >/dev/null || missing+=("node")
command -v npm >/dev/null || missing+=("npm")
command -v tmux >/dev/null || missing+=("tmux")
command -v claude >/dev/null || missing+=("claude (Claude CLI)")

if [ ${#missing[@]} -gt 0 ]; then
    echo "  ❌ 설치 필요: ${missing[*]}"
    echo "  brew install node tmux"
    echo "  Claude CLI: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
fi
echo "  ✅ node $(node -v), npm $(npm -v), tmux, claude"

# ── 2. npm install + build ──
echo ""
echo "[2/8] npm install + build..."
cd "$PROJECT_DIR"
npm install --silent 2>/dev/null
npm run build 2>/dev/null
echo "  ✅ 빌드 완료"

# ── 3. .env 설정 ──
echo ""
echo "[3/8] 환경 변수 설정..."
ALGO_DIR="$HOME_DIR/gwangsu-algo"

if [ ! -f "$ALGO_DIR/.env" ]; then
    if [ -f "$SCRIPT_DIR/env.example" ]; then
        cp "$SCRIPT_DIR/env.example" "$ALGO_DIR/.env"
        echo "  ⚠️ $ALGO_DIR/.env 생성됨 — API 키를 입력하세요:"
        echo "     nano $ALGO_DIR/.env"
    else
        echo "  ⚠️ $ALGO_DIR/.env 없음 — 수동 생성 필요"
    fi
else
    echo "  ✅ .env 존재"
fi

# ── 4. LaunchAgent 설치 ──
echo ""
echo "[4/8] LaunchAgent 설치..."
PLIST_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/ai.juneclaw.daemon.plist"
mkdir -p "$PLIST_DIR"

if [ -f "$PLIST_FILE" ]; then
    echo "  ✅ LaunchAgent 이미 존재"
else
    TEMPLATE="$SCRIPT_DIR/juneclaw.plist.template"
    if [ -f "$TEMPLATE" ]; then
        sed "s|{{PROJECT_DIR}}|$PROJECT_DIR|g; s|{{HOME}}|$HOME_DIR|g; s|{{USER}}|$(whoami)|g" \
            "$TEMPLATE" > "$PLIST_FILE"
        launchctl load "$PLIST_FILE" 2>/dev/null || true
        echo "  ✅ LaunchAgent 설치 + 로드"
    else
        echo "  ⚠️ 템플릿 없음 — 수동 설치 필요"
    fi
fi

# ── 5. 메모리 부트스트랩 ──
echo ""
echo "[5/8] 메모리 부트스트랩..."
BOOTSTRAP_DIR="$PROJECT_DIR/memory/bootstrap"

# JuneClaw 메모리
JMEM="$HOME_DIR/.claude/projects/-Users-$(whoami)-JuneClaw/memory"
mkdir -p "$JMEM"
if [ ! -f "$JMEM/MEMORY.md" ]; then
    for f in "$BOOTSTRAP_DIR"/juneclaw_*.md; do
        [ -f "$f" ] && cp "$f" "$JMEM/$(basename "$f" | sed 's/^juneclaw_//')"
    done
    [ -f "$BOOTSTRAP_DIR/juneclaw_MEMORY.md" ] && cp "$BOOTSTRAP_DIR/juneclaw_MEMORY.md" "$JMEM/MEMORY.md"
    echo "  ✅ JuneClaw 메모리 초기화"
else
    echo "  ✅ JuneClaw 메모리 이미 존재"
fi

# gwangsu-algo 메모리
AMEM="$HOME_DIR/.claude/projects/-Users-$(whoami)-gwangsu-algo/memory"
mkdir -p "$AMEM"
if [ ! -f "$AMEM/MEMORY.md" ]; then
    for f in "$BOOTSTRAP_DIR"/algo_*.md; do
        [ -f "$f" ] && cp "$f" "$AMEM/$(basename "$f" | sed 's/^algo_//')"
    done
    [ -f "$BOOTSTRAP_DIR/algo_MEMORY.md" ] && cp "$BOOTSTRAP_DIR/algo_MEMORY.md" "$AMEM/MEMORY.md"
    echo "  ✅ gwangsu-algo 메모리 초기화"
else
    echo "  ✅ gwangsu-algo 메모리 이미 존재"
fi

# ── 6. ~/CLAUDE.md ──
echo ""
echo "[6/8] ~/CLAUDE.md 설치..."
if [ ! -f "$HOME_DIR/CLAUDE.md" ]; then
    [ -f "$BOOTSTRAP_DIR/home_CLAUDE.md" ] && cp "$BOOTSTRAP_DIR/home_CLAUDE.md" "$HOME_DIR/CLAUDE.md"
    echo "  ✅ ~/CLAUDE.md 생성"
else
    echo "  ✅ ~/CLAUDE.md 이미 존재"
fi

# ── 7. 크론탭 ──
echo ""
echo "[7/8] 크론탭 설치..."
if [ -f "$ALGO_DIR/crontab.txt" ]; then
    echo "  현재 크론탭을 gwangsu-algo/crontab.txt로 교체할까요? (y/N)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        crontab "$ALGO_DIR/crontab.txt"
        echo "  ✅ 크론탭 설치 완료"
    else
        echo "  ⏭️ 스킵"
    fi
else
    echo "  ⚠️ gwangsu-algo/crontab.txt 없음"
fi

# ── 8. 데몬 시작 ──
echo ""
echo "[8/8] 데몬 시작..."
if launchctl list 2>/dev/null | grep -q "ai.juneclaw.daemon"; then
    launchctl kickstart -k "gui/$(id -u)/ai.juneclaw.daemon" 2>/dev/null || true
    echo "  ✅ 데몬 재시작"
else
    echo "  ⚠️ LaunchAgent 로드 후 수동 시작 필요"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ 설치 완료!                           ║"
echo "╠══════════════════════════════════════════╣"
echo "║  리모트 컨트롤: jc rc                      ║"
echo "║  로그: ~/.juneclaw/logs/daemon.log       ║"
echo "║  문서: docs/SETUP.md                     ║"
echo "╚══════════════════════════════════════════╝"
