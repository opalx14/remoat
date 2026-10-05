#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$MCP_DIR/.env.local"
CLOUDFLARED_CONFIG="$MCP_DIR/config/cloudflared.yml"
TUNNEL_NAME="remoat-mcp"
SERVER_LOG="/tmp/remoat-mcp.log"
TUNNEL_LOG="/tmp/remoat-mcp-cloudflared.log"
PUBLIC_URL="https://remoat.promptmarketcap.net"
PORT="7680"
NO_WAIT="${1:-}"

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

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    return
  fi

  umask 077
  local password
  password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-' | head -c 48)
  cat >"$ENV_FILE" <<EOF
REMOAT_MCP_HOST=127.0.0.1
REMOAT_MCP_PORT=$PORT
REMOAT_MCP_PUBLIC_URL=$PUBLIC_URL
REMOAT_MCP_TRUST_PROXY=1
REMOAT_MCP_OWNER_PASSWORD=$password
REMOAT_MCP_ALLOWED_REDIRECT_HOSTS=chatgpt.com,chat.openai.com
EOF
  chmod 600 "$ENV_FILE"
  echo "[config] Đã tạo $ENV_FILE với owner password mới."
}

ensure_env
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export REMOAT_MCP_TRUST_PROXY=1

echo "==> Dừng Remoat MCP cũ (nếu có)..."
kill_pattern "bun run src/http.ts" "server"
kill_pattern "cloudflared.*$CLOUDFLARED_CONFIG.*tunnel run $TUNNEL_NAME" "tunnel"

local_port_pids=$(lsof -t -i :"$PORT" 2>/dev/null || true)
if [ -n "$local_port_pids" ]; then
  echo "[port $PORT] kill PID: $local_port_pids"
  echo "$local_port_pids" | xargs kill -TERM 2>/dev/null || true
  sleep 1
fi

local_port_pids=$(lsof -t -i :"$PORT" 2>/dev/null || true)
if [ -n "$local_port_pids" ]; then
  echo "[port $PORT] force kill PID: $local_port_pids"
  echo "$local_port_pids" | xargs kill -9 2>/dev/null || true
fi

cd "$MCP_DIR" || { echo "Không vào được $MCP_DIR"; exit 1; }

echo ""
echo "==> Khởi động Remoat MCP HTTP (Antisleep)..."
nohup caffeinate -i bun run start:http >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "    server PID = $SERVER_PID"

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "!! server chết rồi — xem $SERVER_LOG"
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "!! local health check thất bại — xem $SERVER_LOG"
  exit 1
fi

echo "==> Khởi động Cloudflare tunnel (Antisleep)..."
nohup caffeinate -i cloudflared --no-autoupdate --config "$CLOUDFLARED_CONFIG" tunnel run "$TUNNEL_NAME" >>"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
disown "$TUNNEL_PID" 2>/dev/null || true
echo "    tunnel PID = $TUNNEL_PID"

sleep 3

if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  echo "!! tunnel chết rồi — xem $TUNNEL_LOG"
  exit 1
fi

PUBLIC_HEALTH="unknown"
if curl -fsS "$PUBLIC_URL/healthz" >/dev/null 2>&1; then
  PUBLIC_HEALTH="ok"
fi

echo ""
echo "================== Remoat MCP =================="
echo "Local     : http://127.0.0.1:$PORT/mcp"
echo "Public    : $PUBLIC_URL/mcp"
echo "Authorize : $PUBLIC_URL/authorize"
echo "Health    : $PUBLIC_URL/healthz ($PUBLIC_HEALTH)"
echo ""
echo "Owner password: lưu trong $ENV_FILE (không in ra Terminal)."
echo ""
echo "Logs:"
echo "  server  -> tail -f $SERVER_LOG"
echo "  tunnel  -> tail -f $TUNNEL_LOG"
echo "================================================"

if [ "$NO_WAIT" != "--no-wait" ]; then
  echo ""
  read -n 1 -s -r -p "Bấm phím bất kỳ để đóng..."
  echo ""
fi
