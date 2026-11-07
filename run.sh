#!/usr/bin/env bash
# ============================================================
# IceBreaker 一键构建 + 启动 (Docker)
#
# 用法 A · 本地已有代码:
#   git clone <仓库地址> icebreaker && cd icebreaker && ./run.sh
#
# 用法 B · 免 clone 管道模式 (脚本自行 clone):
#   curl -fsSL <仓库raw地址>/run.sh | bash -s -- <仓库地址>
#
# 可选环境变量:
#   ICE_PORT   宿主机端口 (默认 8765)
#   ICE_REPO   管道模式使用的仓库地址
# ============================================================
set -euo pipefail

ICE_PORT="${ICE_PORT:-8765}"
ICE_REPO="${ICE_REPO:-}"

# ---- 管道模式: 仓库不存在则先 clone ----
if [ ! -f "docker-compose.yml" ]; then
  if [ -z "$ICE_REPO" ] && [ $# -ge 1 ]; then ICE_REPO="$1"; fi
  if [ -z "$ICE_REPO" ]; then
    echo "[x] 当前目录没有 docker-compose.yml, 且未提供仓库地址"
    echo "    用法: ./run.sh  (仓库目录内)  或  bash run.sh <git仓库地址>"
    exit 1
  fi
  echo "[*] 克隆仓库: $ICE_REPO"
  git clone "$ICE_REPO" icebreaker
  cd icebreaker
fi

echo "=================================================="
echo "  IceBreaker · LLM API 与 GPU 压测平台"
echo "  端口: ${ICE_PORT}  |  构建 + 启动 + 健康检查"
echo "=================================================="

# ---- 前置检查 ----
if ! command -v docker >/dev/null 2>&1; then
  echo "[x] 未安装 Docker, 请先安装 (https://docs.docker.com/get-docker/)"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "[x] Docker 守护进程未运行, 请先启动 Docker"
  exit 1
fi

# ---- 构建镜像 (利用缓存, 代码未变时秒级跳过) ----
echo "[1/3] 构建镜像 llm-benchmark:latest ..."
docker compose build --pull

# ---- 启动容器 ----
echo "[2/3] 启动容器 ..."
ICE_PORT="$ICE_PORT" docker compose up -d

# ---- 健康检查 (最多等 60s) ----
echo "[3/3] 健康检查 ..."
ok=0
for i in $(seq 1 30); do
  if curl -sf --max-time 2 "http://127.0.0.1:${ICE_PORT}/health" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done

echo ""
if [ "$ok" = "1" ]; then
  echo "=================================================="
  echo "  [√] IceBreaker 已就绪"
  echo ""
  echo "  访问地址 : http://<本机IP>:${ICE_PORT}"
  echo "  初始账号 : admin / admin123  (登录后请立即改密)"
  echo ""
  echo "  常用命令:"
  echo "    查看日志  docker compose logs -f"
  echo "    停止服务  docker compose down"
  echo "    升级重启  git pull && ./run.sh"
  echo "=================================================="
else
  echo "[!] 容器已启动但健康检查超时, 最近日志:"
  docker compose logs --tail 20 || true
  exit 1
fi
