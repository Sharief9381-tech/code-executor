#!/bin/bash
# Fix Docker permission denied in WSL2
# Run in Ubuntu terminal

echo "Fixing Docker permissions..."

# Add current user to docker group
sudo usermod -aG docker $USER

# Start Docker service
sudo service docker start

# Apply group change without logout
newgrp docker << 'INNERSCRIPT'
echo "Testing Docker..."
docker run --rm hello-world
if [ $? -eq 0 ]; then
  echo ""
  echo "✓ Docker is working!"
  echo ""
  echo "Now pulling language images..."
  docker pull python:3.11-slim
  docker pull node:20-slim
  docker pull openjdk:17-slim
  docker pull gcc:13
  docker pull golang:1.21-alpine

  echo ""
  echo "All images pulled. Starting executor..."
  cd ~/code-executor
  export EXECUTOR_SECRET="codehiring-executor-secret"
  export PORT=4000
  nohup node server.mjs > executor.log 2>&1 &
  sleep 2
  curl -s http://localhost:4000/health && echo "" && echo "✓ Executor is RUNNING on port 4000"
else
  echo "✗ Docker still not working"
fi
INNERSCRIPT
