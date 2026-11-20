#!/usr/bin/env bash
# 用本机 CloudBOM 配置启动 agent-platform。
# 平台实例配置来自 git 忽略的 .runtime/，不会污染 config/platform.json。
#
# 用法：
#   bash scripts/start-cloudbom.sh            # 端口被占用时报错退出
#   bash scripts/start-cloudbom.sh --restart  # 先杀掉占用端口的旧进程再启动
#   bash scripts/start-cloudbom.sh --build    # 强制先 npm run build
#   bash scripts/start-cloudbom.sh --check    # 只打印解析后的启动参数
#   bash scripts/start-cloudbom.sh --stage5   # 打开 Stage5 外部写（提交 PR/MR）
#
# 想换文件就提前导出变量：
#   AGENT_PLATFORM_CONFIG=... AGENT_PLATFORM_SCHEDULES=... bash scripts/start-cloudbom.sh
#
# 调度默认读 .runtime/cloudbom-schedules.json（两个任务默认 enabled=false，
# 在配置页「轮询任务」里打开即可，保存会写回这个文件）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="${AGENT_PLATFORM_CONFIG:-$ROOT/.runtime/cloudbom-platform.json}"
SCHEDULES="${AGENT_PLATFORM_SCHEDULES:-$ROOT/.runtime/cloudbom-schedules.json}"
DATABASE="${AGENT_PLATFORM_DATABASE:-$ROOT/.runtime/state/agent-platform.sqlite3}"
AUTH_PROVIDER="${AGENT_PLATFORM_AUTH_PROVIDER:-$ROOT/.runtime/preview/auth-provider.mjs}"
MAVEN_SETTINGS="${AGENT_PLATFORM_CLOUDBOM_MAVEN_SETTINGS:-/opt/homebrew/Cellar/maven/3.9.16/libexec/conf/gts-aliyun-global-settings.xml}"
JAVA_HOME_CLOUDBOM="${AGENT_PLATFORM_CLOUDBOM_JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home}"
if [ ! -f "$MAVEN_SETTINGS" ]; then
  echo "启动中止：CloudBOM Maven settings 文件不存在。" >&2
  exit 1
fi
if [ ! -x "$JAVA_HOME_CLOUDBOM/bin/java" ]; then
  echo "启动中止：CloudBOM JDK 不存在。" >&2
  exit 1
fi

# 默认打开 Worker 和 Qoder 写（develop 可用），但关闭 Stage5 外部写（提交 PR）：
# 外部写仍需对应仓库的代码托管凭据；requiredChecks 未配置时跳过 CI Job 名称检查。
# develop 需要在「Agent 与预算」配置 QoderCN 专用 PAT，也兼容启动环境变量。
WORKER="${AGENT_PLATFORM_STAGE5_WORKER_ENABLED:-1}"
QODER_WRITE="${AGENT_PLATFORM_QODER_WRITE_ENABLED:-1}"
WRITES="${AGENT_PLATFORM_STAGE5_WRITES_ENABLED:-1}"

RESTART=""
BUILD=""
CHECK_ONLY=""
STAGE5=""
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --build) BUILD=1 ;;
    --check) CHECK_ONLY=1 ;;
    --stage5) STAGE5=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（试试 --help）" >&2; exit 2 ;;
  esac
done
if [ -n "$STAGE5" ]; then
  WORKER=1
  QODER_WRITE=1
  WRITES=1
fi

for file in "$CONFIG" "$SCHEDULES"; do
  [ -f "$file" ] || { echo "缺少配置文件：$file" >&2; exit 1; }
done
command -v npm >/dev/null || { echo "PATH 里没有 npm" >&2; exit 1; }

PORT="$(node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(c.interaction?.port ?? 8765)' "$CONFIG")" \
  || { echo "解析 $CONFIG 的 interaction.port 失败" >&2; exit 1; }

listener() {
  command -v lsof >/dev/null || return 0
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

echo "配置  : $CONFIG"
echo "调度  : $SCHEDULES"
echo "数据库: $DATABASE"
echo "端口  : $PORT"
echo "JDK   : $JAVA_HOME_CLOUDBOM"
echo "Maven : $MAVEN_SETTINGS"
echo "Stage5: worker=$WORKER qoderWrite=$QODER_WRITE writes=$WRITES"

if [ -n "$CHECK_ONLY" ]; then
  PID="$(listener)"
  echo "占用  : ${PID:-无}"
  exit 0
fi

PID="$(listener)"
if [ -n "$PID" ]; then
  if [ -z "$RESTART" ]; then
    echo "端口 $PORT 已被进程 $PID 占用。加 --restart 让脚本杀掉它再启动。" >&2
    exit 1
  fi
  echo "停止旧进程 $PID …"
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 50); do
    if [ -z "$(listener)" ]; then break; fi
    sleep 0.1
  done
  if [ -n "$(listener)" ]; then
    echo "进程 $PID 没能在 5 秒内退出，请手动处理。" >&2
    exit 1
  fi
fi

if [ -n "$BUILD" ] || [ ! -f dist/bootstrap/main.js ] \
   || [ -n "$(find src web/src package.json web/package.json -newer dist/bootstrap/main.js -type f -print -quit 2>/dev/null)" ]; then
  echo "构建中（npm run build）…"
  npm run build
fi

echo "启动：http://127.0.0.1:$PORT"
exec env \
  AGENT_PLATFORM_AUTH_PROVIDER="$AUTH_PROVIDER" \
  AGENT_PLATFORM_CONFIG="$CONFIG" \
  AGENT_PLATFORM_SCHEDULES="$SCHEDULES" \
  AGENT_PLATFORM_DATABASE="$DATABASE" \
  AGENT_PLATFORM_CLOUDBOM_MAVEN_SETTINGS="$MAVEN_SETTINGS" \
  AGENT_PLATFORM_CLOUDBOM_JAVA_HOME="$JAVA_HOME_CLOUDBOM" \
  AGENT_PLATFORM_STAGE5_WORKER_ENABLED="$WORKER" \
  AGENT_PLATFORM_QODER_WRITE_ENABLED="$QODER_WRITE" \
  AGENT_PLATFORM_STAGE5_WRITES_ENABLED="$WRITES" \
  npm start
