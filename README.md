# CodeHiring Execution Engine

A self-hosted, Docker-based sandboxed code runner — the same architecture used by LeetCode.

## How it works

```
POST /execute  { code, language, stdin, timeoutMs }
       ↓
Writes code to isolated temp dir
       ↓
docker run --rm --network none --memory 256m --cpus 0.5 ...
       ↓
Compile (if needed) → Run with stdin
       ↓
Capture stdout, stderr, exitCode, runtimeMs
       ↓
Container auto-destroyed
       ↓
Return { output, error, runtimeMs, tle }
```

## Requirements

- **Linux** host (Ubuntu 20.04+ recommended) — Docker sandboxing requires Linux
- **Docker** installed: https://docs.docker.com/engine/install/ubuntu/
- **Node.js 18+**

> ⚠️ This service must run on a Linux VPS, NOT on Windows locally.
> For local dev on Windows, use Judge0 via RapidAPI (see codehiring .env).

## Setup (run once on your Linux VPS)

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# 2. Clone / copy the code-executor folder to your VPS
# 3. Pull Docker images (takes a few minutes)
node setup.mjs

# 4. Set your secret token
export EXECUTOR_SECRET="your-strong-secret-here"

# 5. Start the server
node server.mjs
```

## Environment variables

| Variable          | Default                         | Description                        |
|-------------------|---------------------------------|------------------------------------|
| `PORT`            | `4000`                          | Port to listen on                  |
| `EXECUTOR_SECRET` | `codehiring-executor-secret`    | Bearer token for auth              |

## API

### POST /execute

```json
{
  "code":      "n = int(input())\nprint(n * n)",
  "language":  "python",
  "stdin":     "7",
  "timeoutMs": 5000
}
```

**Response:**
```json
{
  "output":    "49",
  "error":     "",
  "runtimeMs": 120,
  "exitCode":  0,
  "tle":       false,
  "language":  "python"
}
```

### GET /health

Returns `{ status: "ok", uptime: 123.4 }`

### GET /languages

Returns list of supported languages.

## Supported languages

| Language   | Image                          | Compile step |
|------------|--------------------------------|--------------|
| Python     | python:3.11-slim               | No           |
| JavaScript | node:20-slim                   | No           |
| TypeScript | node:20-slim                   | No (ts-node) |
| Java       | openjdk:17-slim                | javac        |
| C++        | gcc:13                         | g++          |
| C          | gcc:13                         | gcc          |
| C#         | mcr.microsoft.com/dotnet/sdk:8 | No           |
| Go         | golang:1.21-alpine             | No           |
| Kotlin     | openjdk:17-slim                | kotlinc      |
| Swift      | swift:5.9-slim                 | No           |

## Security constraints per container

| Constraint          | Value          | Why                              |
|---------------------|----------------|----------------------------------|
| `--network none`    | No internet    | Prevent data exfiltration        |
| `--memory 256m`     | 256MB RAM      | Prevent memory bombs             |
| `--memory-swap 256m`| No swap        | Strict memory enforcement        |
| `--cpus 0.5`        | 0.5 CPU cores  | Fair resource allocation         |
| `--pids-limit 64`   | 64 processes   | Prevent fork bombs               |
| `--ulimit cpu=N`    | N seconds      | CPU time limit                   |
| `--ulimit nofile=64`| 64 file descs  | Limit file access                |
| `--read-only`       | Read-only FS   | Prevent FS tampering             |
| `--tmpfs /tmp`      | 32MB, noexec   | Writable scratch only            |
| `--user nobody`     | Non-root       | Prevent privilege escalation     |
| `--rm`              | Auto-delete    | No container lingering           |

## Wiring to Next.js (codehiring)

Set in `codehiring/.env`:
```
EXECUTOR_URL=http://your-vps-ip:4000
EXECUTOR_SECRET=your-strong-secret-here
```

The `run-code` API route will automatically use your executor when `EXECUTOR_URL` is set.

## Run on a Linux VPS (production)

```bash
# As a systemd service (auto-restart on crash/reboot)
sudo nano /etc/systemd/system/code-executor.service
```

```ini
[Unit]
Description=CodeHiring Execution Engine
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/code-executor
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PORT=4000
Environment=EXECUTOR_SECRET=your-strong-secret-here

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable code-executor
sudo systemctl start code-executor
sudo systemctl status code-executor
```

## Testing

```bash
# Start server first
node server.mjs

# In another terminal
node test.mjs
```
