#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLOUDFLARED_CONFIG="$MCP_DIR/config/cloudflared.yml"
TUNNEL_NAME="remoat-mcp"
PORT="7680"

kill_pattern() {
  local pattern="$1" label="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[$label] kill PID: $pids"
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
  else
    echo "[$label] chưa chạy"
  fi
}

kill_pattern "bun run src/http.ts" "server"
kill_pattern "cloudflared.*$CLOUDFLARED_CONFIG.*tunnel run $TUNNEL_NAME" "tunnel"

port_pids=$(lsof -t -i :"$PORT" 2>/dev/null || true)
if [ -n "$port_pids" ]; then
  echo "[port $PORT] kill PID: $port_pids"
  echo "$port_pids" | xargs kill -TERM 2>/dev/null || true
fi

echo "Remoat MCP đã dừng."
