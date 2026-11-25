#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RESTART=""
BUILD=""
CHECK_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --build) BUILD=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) echo '用法：./start.sh [--restart] [--build] [--check]'; exit 0 ;;
    *) echo "未知参数：$arg（试试 --help）" >&2; exit 2 ;;
  esac
done

if [ -n "$CHECK_ONLY" ]; then
  exec node --import tsx src/bootstrap/main.ts --check
fi

PORT="$(node --import tsx src/bootstrap/main.ts --port)"
listener() {
  [ -n "$PORT" ] || return 0
  command -v lsof >/dev/null || return 0
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

if [ -n "$BUILD" ] || [ ! -f dist/bootstrap/main.js ] || [ ! -f web/dist/index.html ] \
   || [ -n "$(find src web/src package.json web/package.json -newer dist/bootstrap/main.js -type f -print -quit 2>/dev/null)" ]; then
  echo "构建中（npm run build）…"
  npm run build
fi

PID="$(listener)"
if [ -n "$PID" ]; then
  if [ -z "$RESTART" ]; then
    echo "端口 $PORT 已被进程 $PID 占用。加 --restart 停止旧服务后再启动。" >&2
    exit 1
  fi
  echo "停止旧进程 $PID …"
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if [ -z "$(listener)" ]; then break; fi
    sleep 0.1
  done
  if [ -n "$(listener)" ]; then
    echo "进程 $PID 没能在 5 秒内退出。" >&2
    exit 1
  fi
fi

exec npm start
