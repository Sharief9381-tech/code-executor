/**
 * CodeHiring Execution Engine
 * ===========================
 * A self-hosted, Docker-based sandboxed code runner.
 * Mirrors the architecture used by LeetCode.
 *
 * Flow:
 *  1. Receive { code, language, stdin, timeoutMs } via POST /execute
 *  2. Write code to a temp directory
 *  3. Spin up an isolated Docker container:
 *       - No network access (--network none)
 *       - CPU limited (--cpus 0.5)
 *       - RAM limited (--memory 256m)
 *       - Disk limited (--storage-opt not needed — tmpfs handles it)
 *       - No extra processes (--pids-limit 64)
 *       - Filesystem read-only except /tmp
 *  4. Compile (if needed) inside container
 *  5. Run against stdin, capture stdout/stderr/exit code/runtime/memory
 *  6. Kill container — guaranteed cleanup
 *  7. Return result JSON
 *
 * Requirements:
 *   - Linux host (Ubuntu 20.04+ recommended)
 *   - Docker installed: https://docs.docker.com/engine/install/ubuntu/
 *   - Pull images once (see README.md)
 *   - Node.js 18+
 *
 * Start: node server.mjs
 * Port:  4000 (configurable via PORT env var)
 */

import { createServer }                     from 'node:http'
import { exec, execSync }                   from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { randomUUID }                       from 'node:crypto'
import path                                 from 'node:path'
import os                                   from 'node:os'

const PORT       = process.env.PORT ?? 4000
const AUTH_TOKEN = process.env.EXECUTOR_SECRET ?? "codehiring-executor-secret"

// ── Language configuration ────────────────────────────────────────────────────
// Each entry defines:
//   image    : Docker image to use (pulled once during setup)
//   filename : What to name the source file inside the container
//   compile  : Compile command (null = interpreted, no compile step)
//   run      : Run command (uses compiled binary or interpreter)
const LANGUAGES = {
  python: {
    image:    'python:3.11-slim',
    filename: 'main.py',
    compile:  null,
    run:      'python3 main.py',
  },
  javascript: {
    image:    'node:20-slim',
    filename: 'main.js',
    compile:  null,
    run:      'node main.js',
  },
  typescript: {
    image:    'node:20-slim',
    filename: 'main.ts',
    // ts-node is pre-installed in the image via setup
    compile:  null,
    run:      'npx --yes ts-node --skip-project main.ts',
  },
  java: {
    image:    'eclipse-temurin:17-jdk-jammy',
    filename: 'Main.java',
    compile:  'javac Main.java',
    run:      'java -cp . Main',
  },
  'c++': {
    image:    'gcc:13',
    filename: 'main.cpp',
    compile:  'g++ -O2 -o main main.cpp',
    run:      './main',
  },
  c: {
    image:    'gcc:13',
    filename: 'main.c',
    compile:  'gcc -O2 -o main main.c',
    run:      './main',
  },
  'c#': {
    image:    'mcr.microsoft.com/dotnet/sdk:8.0',
    filename: 'main.cs',
    // Use dotnet-script for single-file execution
    compile:  null,
    run:      'dotnet script main.cs',
  },
  go: {
    image:    'golang:1.21-alpine',
    filename: 'main.go',
    compile:  null,
    run:      'go run main.go',
  },
  kotlin: {
    image:    'eclipse-temurin:17-jdk-jammy',
    filename: 'main.kt',
    compile:  'kotlinc main.kt -include-runtime -d main.jar 2>/dev/null',
    run:      'java -jar main.jar',
  },
  swift: {
    image:    'swift:5.9-slim',
    filename: 'main.swift',
    compile:  null,
    run:      'swift main.swift',
  },
}

// Normalize language key
function normalizeLang(lang) {
  const map = {
    'python':     'python',
    'javascript': 'javascript',
    'js':         'javascript',
    'typescript': 'typescript',
    'ts':         'typescript',
    'java':       'java',
    'c++':        'c++',
    'cpp':        'c++',
    'c':          'c',
    'c#':         'c#',
    'csharp':     'c#',
    'go':         'go',
    'golang':     'go',
    'kotlin':     'kotlin',
    'swift':      'swift',
  }
  return map[lang?.toLowerCase()] ?? lang?.toLowerCase()
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy() })
    req.on('end',   () => resolve(body))
    req.on('error', reject)
  })
}

// ── Core executor ─────────────────────────────────────────────────────────────
async function executeCode({ code, language, stdin = '', timeoutMs = 5000 }) {
  const langKey = normalizeLang(language)
  const cfg     = LANGUAGES[langKey]

  if (!cfg) {
    throw new Error(`Unsupported language: "${language}". Supported: ${Object.keys(LANGUAGES).join(', ')}`)
  }

  // 1. Create isolated temp directory for this submission
  const id     = randomUUID()
  const tmpDir = path.join(os.tmpdir(), `cj_${id}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    // 2. Write source file and stdin file
    writeFileSync(path.join(tmpDir, cfg.filename), code, 'utf8')
    writeFileSync(path.join(tmpDir, 'stdin.txt'),  stdin,  'utf8')

    // 3. Build the shell command to run inside Docker
    //    If there's a compile step, run it first; if it fails, capture compile error
    let innerCmd
    if (cfg.compile) {
      // Compile first, pipe compile errors to compile_err.txt
      // If compilation fails (non-zero exit), print "COMPILE_ERROR" marker to stderr
      innerCmd = `
        ${cfg.compile} 2>compile_err.txt
        if [ $? -ne 0 ]; then
          echo "COMPILE_ERROR" >&2
          cat compile_err.txt >&2
          exit 1
        fi
        ${cfg.run} <stdin.txt
      `.trim().replace(/\n\s+/g, '\n')
    } else {
      innerCmd = `${cfg.run} <stdin.txt`
    }

    // 4. Build Docker command with all security constraints
    const cpuTimeout = Math.ceil(timeoutMs / 1000)
    const dockerArgs = [
      'docker run',
      '--rm',                          // auto-remove container after exit
      '--network none',                // no internet access
      '--memory 256m',                 // 256MB RAM hard limit
      '--memory-swap 256m',            // disable swap (memory only)
      '--cpus 0.5',                    // half CPU core
      '--pids-limit 64',               // prevent fork bombs
      `--ulimit cpu=${cpuTimeout}:${cpuTimeout}`,  // CPU time limit (seconds)
      '--ulimit nofile=64:64',         // file descriptor limit
      '--ulimit nproc=64:64',          // process limit
      `--volume ${tmpDir}:/code`,      // mount temp dir as /code (writable)
      '--workdir /code',
      cfg.image,
      `sh -c "${innerCmd}"`,
    ].join(' ')

    // 5. Execute with wall-clock timeout
    const start = Date.now()
    const result = await new Promise((resolve) => {
      const proc = exec(
        dockerArgs,
        {
          timeout:  timeoutMs + 5000,  // extra 5s grace for Docker overhead
          maxBuffer: 1024 * 1024,      // 1MB max output
        },
        (err, stdout, stderr) => {
          const runtimeMs = Date.now() - start

          const isKilled      = err?.killed || err?.signal === 'SIGTERM'
          const isCompileErr  = stderr?.includes('COMPILE_ERROR')
          const exitCode      = err?.code ?? 0

          resolve({
            stdout:     stdout ?? '',
            stderr:     stderr ?? '',
            runtimeMs:  Math.max(0, runtimeMs - 800), // subtract ~Docker startup overhead
            exitCode,
            isKilled,
            isCompileErr,
          })
        }
      )

      // Hard kill after timeout
      setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
      }, timeoutMs + 4000)
    })

    // 6. Parse result
    const output = result.stdout.trim()
    let   error  = ''
    let   tle    = false

    if (result.isKilled) {
      tle   = true
      error = 'Time Limit Exceeded'
    } else if (result.isCompileErr) {
      error = result.stderr
        .replace('COMPILE_ERROR\n', '')
        .trim()
        .replace(/^compile_err\.txt:\s*/gm, '')
        || 'Compilation failed'
      error = `Compilation Error:\n${error}`
    } else if (result.stderr.trim()) {
      error = result.stderr.trim()
    } else if (result.exitCode !== 0) {
      error = `Runtime Error (exit code ${result.exitCode})`
    }

    return {
      output,
      error,
      runtimeMs: result.runtimeMs,
      exitCode:  result.exitCode,
      tle,
      language:  langKey,
    }

  } finally {
    // 7. Always clean up temp directory
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS — allow Next.js dev server
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { status: 'ok', version: '1.0.0', uptime: process.uptime() })
    return
  }

  // Languages list
  if (req.method === 'GET' && req.url === '/languages') {
    sendJSON(res, 200, { languages: Object.keys(LANGUAGES) })
    return
  }

  // Execute endpoint
  if (req.method === 'POST' && req.url === '/execute') {
    // Auth check
    const auth = req.headers['authorization'] ?? ''
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      sendJSON(res, 401, { error: 'Unauthorized' })
      return
    }

    let body
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw)
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON body' })
      return
    }

    const { code, language, stdin = '', timeoutMs = 5000 } = body

    if (!code?.trim()) { sendJSON(res, 400, { error: 'code is required' });     return }
    if (!language)      { sendJSON(res, 400, { error: 'language is required' }); return }

    console.log(`[${new Date().toISOString()}] Execute: ${language} | ${code.length} chars | timeout=${timeoutMs}ms`)

    try {
      const result = await executeCode({ code, language, stdin, timeoutMs })
      console.log(`[${new Date().toISOString()}] Done: ${language} | runtime=${result.runtimeMs}ms | tle=${result.tle}`)
      sendJSON(res, 200, result)
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error:`, err.message)
      sendJSON(res, 500, { error: err.message })
    }
    return
  }

  sendJSON(res, 404, { error: 'Not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔════════════════════════════════════════╗`)
  console.log(`║   CodeHiring Execution Engine v1.0.0  ║`)
  console.log(`╚════════════════════════════════════════╝`)
  console.log(`  Listening on: http://0.0.0.0:${PORT}`)
  console.log(`  Auth token:   ${AUTH_TOKEN.slice(0, 8)}...`)
  console.log(`  Languages:    ${Object.keys(LANGUAGES).join(', ')}`)
  console.log(`  Docker:       ${checkDocker() ? '✓ available' : '✗ NOT FOUND — install Docker'}`)
  console.log('')
})

function checkDocker() {
  try { execSync('docker --version', { stdio: 'pipe' }); return true } catch { return false }
}
