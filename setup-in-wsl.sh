#!/bin/bash
# ============================================================
# Run this INSIDE WSL2 Ubuntu after install-wsl.ps1 completes
# Open Ubuntu terminal → paste this whole file or run it
# ============================================================

set -e

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  CodeHiring Executor — WSL2 Setup      ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ── 1. Install Docker inside WSL2 ────────────────────────────────────────────
echo "[1/5] Installing Docker..."
sudo apt-get update -qq
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io

# Add current user to docker group (no sudo needed)
sudo usermod -aG docker "$USER"
sudo service docker start

echo "✓ Docker installed"

# ── 2. Install Node.js 20 ─────────────────────────────────────────────────────
echo ""
echo "[2/5] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
echo "✓ Node.js $(node --version)"

# ── 3. Copy executor files from Windows into WSL ──────────────────────────────
echo ""
echo "[3/5] Copying executor files..."

# Windows drive is mounted at /mnt/c in WSL2
WINDOWS_PATH="/mnt/c/Users/shari/Music/Hiring/code-executor"
WSL_PATH="$HOME/code-executor"

if [ -d "$WINDOWS_PATH" ]; then
  cp -r "$WINDOWS_PATH" "$WSL_PATH" 2>/dev/null || true
  echo "✓ Copied from $WINDOWS_PATH"
else
  mkdir -p "$WSL_PATH"
  echo "⚠ Could not find Windows path. Manually copy code-executor/ files to $WSL_PATH"
fi

cd "$WSL_PATH"

# ── 4. Pull Docker language images ────────────────────────────────────────────
echo ""
echo "[4/5] Pulling Docker images (this takes a few minutes)..."

IMAGES=(
  "python:3.11-slim"
  "node:20-slim"
  "openjdk:17-slim"
  "gcc:13"
  "golang:1.21-alpine"
)

for img in "${IMAGES[@]}"; do
  echo "  Pulling $img..."
  docker pull "$img" -q
  echo "  ✓ $img"
done

# ── 5. Start the executor ─────────────────────────────────────────────────────
echo ""
echo "[5/5] Starting execution engine..."

export EXECUTOR_SECRET="codehiring-executor-secret"
export PORT=4000

# Run in background, log to file
nohup node "$WSL_PATH/server.mjs" > "$WSL_PATH/executor.log" 2>&1 &
EXECUTOR_PID=$!

sleep 2

# Health check
if curl -s http://localhost:4000/health | grep -q "ok"; then
  echo ""
  echo "╔════════════════════════════════════════════════════════╗"
  echo "║  ✓ Execution Engine is RUNNING on http://localhost:4000 ║"
  echo "╚════════════════════════════════════════════════════════╝"
  echo ""
  echo "PID: $EXECUTOR_PID"
  echo "Log: $WSL_PATH/executor.log"
  echo ""
  echo "Now set in codehiring/.env:"
  echo "  EXECUTOR_URL=http://localhost:4000"
  echo "  EXECUTOR_SECRET=codehiring-executor-secret"
  echo ""
  echo "Run tests: node $WSL_PATH/test.mjs"
else
  echo "✗ Server failed to start. Check: cat $WSL_PATH/executor.log"
fi
