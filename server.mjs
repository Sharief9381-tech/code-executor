/**
 * CodeHiring Execution Engine v2.0
 * =================================
 * Uses `isolate` (the same sandbox used by Codeforces/IOI/ICPC)
 * with Docker as fallback.
 *
 * isolate: https://github.com/ioi/isolate
 *   - Linux namespace isolation
 *   - cgroups for CPU/memory limits
 *   - Seccomp syscall filtering
 *   - Used by Codeforces, IOI, ICPC
 *
 * Architecture:
 *   Vercel (Next.js) → Executor API → isolate sandbox → result
 *
 * Setup on Ubuntu:
 *   apt install isolate    # or build from source
 *   OR
 *   docker (fallback)
 */
import { createServer }  from 'node:http'
import { exec, execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { randomUUID }    from 'node:crypto'
import path              from 'node:path'
import os                from 'node:os'

const PORT        = process.env.PORT        ?? 4000
const AUTH_TOKEN  = process.env.EXECUTOR_SECRET ?? "codehiring-executor-secret"

// ── Detect available sandbox ──────────────────────────────────────────────────
function detectSandbox() {
  try { execSync('isolate --version', { stdio: 'pipe' }); return 'isolate' } catch {}
  try { execSync('docker --version',  { stdio: 'pipe' }); return 'docker'  } catch {}
  return 'none'
}
const SANDBOX = detectSandbox()

// ── Language configs ──────────────────────────────────────────────────────────
const LANGUAGES = {
  python:     { filename: 'main.py',   compile: null,                           run: 'python3 main.py',              docker: 'python:3.11-slim'           },
  javascript: { filename: 'main.js',   compile: null,                           run: 'node main.js',                 docker: 'node:20-slim'               },
  typescript: { filename: 'main.ts',   compile: null,                           run: 'npx --yes ts-node --skip-project main.ts', docker: 'node:20-slim'  },
  java:       { filename: 'Main.java', compile: 'javac Main.java',              run: 'java -cp . Main',              docker: 'eclipse-temurin:17-jdk-jammy'},
  'c++':      { filename: 'main.cpp',  compile: 'g++ -O2 -o main main.cpp',    run: './main',                       docker: 'gcc:13'                     },
  c:          { filename: 'main.c',    compile: 'gcc -O2 -o main main.c',      run: './main',                       docker: 'gcc:13'                     },
  go:         { filename: 'main.go',   compile: null,                           run: 'go run main.go',               docker: 'golang:1.21-alpine'         },
  'c#':       { filename: 'main.cs',   compile: null,                           run: 'dotnet script main.cs',        docker: 'mcr.microsoft.com/dotnet/sdk:8.0' },
  kotlin:     { filename: 'main.kt',   compile: 'kotlinc main.kt -include-runtime -d main.jar 2>/dev/null', run: 'java -jar main.jar', docker: 'eclipse-temurin:17-jdk-jammy' },
  swift:      { filename: 'main.swift',compile: null,                           run: 'swift main.swift',             docker: 'swift:5.9-slim'             },
}

function normalizeLang(lang) {
  const map = { python:'python', javascript:'javascript', js:'javascript', typescript:'typescript', ts:'typescript', java:'java', 'c++':'c++', cpp:'c++', c:'c', 'c#':'c#', csharp:'c#', go:'go', golang:'go', kotlin:'kotlin', swift:'swift' }
  return map[lang?.toLowerCase()] ?? lang?.toLowerCase()
}

// ── isolate execution ─────────────────────────────────────────────────────────
async function runWithIsolate({ code, language, stdin, timeoutMs }) {
  const cfg     = LANGUAGES[language]
  const boxId   = Math.floor(Math.random() * 900) + 100  // box 100-999
  const timeout = Math.ceil(timeoutMs / 1000)

  try {
    // Init box
    execSync(`isolate --box-id=${boxId} --init`, { stdio: 'pipe' })
    const boxDir = execSync(`isolate --box-id=${boxId} --init`, { stdio: 'pipe' }).toString().trim() + '/box'

    // Write files
    writeFileSync(`${boxDir}/${cfg.filename}`, code)
    writeFileSync(`${boxDir}/stdin.txt`, stdin)

    // Compile if needed
    if (cfg.compile) {
      const compileResult = execSync(
        `isolate --box-id=${boxId} --time=30 --mem=262144 --run -- /bin/sh -c "cd /box && ${cfg.compile} 2>compile_err.txt"`,
        { stdio: 'pipe', timeout: 35000 }
      ).toString()
      const compileErr = existsSync(`${boxDir}/compile_err.txt`)
        ? require('fs').readFileSync(`${boxDir}/compile_err.txt`, 'utf8') : ''
      if (compileErr) throw new Error(`Compilation Error:\n${compileErr}`)
    }

    // Run
    const start = Date.now()
    const runResult = execSync(
      `isolate --box-id=${boxId}` +
      ` --time=${timeout}` +
      ` --wall-time=${timeout + 2}` +
      ` --mem=262144` +           // 256MB
      ` --processes=64` +
      ` --stdin=${boxDir}/stdin.txt` +
      ` --stdout=stdout.txt` +
      ` --stderr=stderr.txt` +
      ` --run -- /bin/sh -c "${cfg.run}"`,
      { stdio: 'pipe', timeout: (timeout + 5) * 1000 }
    ).toString()
    const runtimeMs = Date.now() - start

    const output = existsSync(`${boxDir}/stdout.txt`) ? require('fs').readFileSync(`${boxDir}/stdout.txt`, 'utf8').trim() : ''
    const stderr = existsSync(`${boxDir}/stderr.txt`) ? require('fs').readFileSync(`${boxDir}/stderr.txt`, 'utf8').trim() : ''

    return { output, error: stderr, runtimeMs, tle: false }

  } catch (e) {
    const msg = e.message ?? ''
    const tle = msg.includes('Time Limit') || msg.includes('TO')
    return { output: '', error: tle ? 'Time Limit Exceeded' : msg.slice(0, 500), runtimeMs: tle ? timeoutMs : 0, tle }
  } finally {
    try { execSync(`isolate --box-id=${boxId} --cleanup`, { stdio: 'pipe' }) } catch {}
  }
}

// ── Docker execution ──────────────────────────────────────────────────────────
async function runWithDocker({ code, language, stdin, timeoutMs }) {
  const cfg    = LANGUAGES[language]
  const id     = randomUUID()
  const tmpDir = path.join(os.tmpdir(), `cj_${id}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    writeFileSync(path.join(tmpDir, cfg.filename), code, 'utf8')
    writeFileSync(path.join(tmpDir, 'stdin.txt'),  stdin,  'utf8')

    let innerCmd
    if (cfg.compile) {
      innerCmd = `${cfg.compile} 2>compile_err.txt\nif [ $? -ne 0 ]; then echo "COMPILE_ERROR" >&2; cat compile_err.txt >&2; exit 1; fi\n${cfg.run} <stdin.txt`
    } else {
      innerCmd = `${cfg.run} <stdin.txt`
    }

    const cpuTimeout = Math.ceil(timeoutMs / 1000)
    const dockerArgs = [
      'docker run --rm',
      '--network none',
      '--memory 256m',
      '--memory-swap 256m',
      '--cpus 0.5',
      '--pids-limit 64',
      `--ulimit cpu=${cpuTimeout}:${cpuTimeout}`,
      '--ulimit nofile=64:64',
      `--volume ${tmpDir}:/code`,
      '--workdir /code',
      cfg.docker,
      `sh -c "${innerCmd.replace(/\n/g, '; ')}"`,
    ].join(' ')

    const start = Date.now()
    const result = await new Promise(resolve => {
      const proc = exec(dockerArgs, { timeout: timeoutMs + 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const runtimeMs    = Date.now() - start
        const isKilled     = err?.killed || err?.signal === 'SIGTERM'
        const isCompileErr = stderr?.includes('COMPILE_ERROR')
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', runtimeMs: Math.max(0, runtimeMs - 800), isKilled, isCompileErr, exitCode: err?.code ?? 0 })
      })
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs + 4000)
    })

    const output = result.stdout.trim()
    let error = ''
    let tle   = false

    if (result.isKilled) {
      tle = true; error = 'Time Limit Exceeded'
    } else if (result.isCompileErr) {
      error = `Compilation Error:\n${result.stderr.replace('COMPILE_ERROR\n','').trim()}`
    } else if (result.stderr.trim()) {
      error = result.stderr.trim()
    } else if (result.exitCode !== 0) {
      error = `Runtime Error (exit ${result.exitCode})`
    }

    return { output, error, runtimeMs: result.runtimeMs, tle }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────
async function executeCode({ code, language, stdin = '', timeoutMs = 5000 }) {
  const langKey = normalizeLang(language)
  const cfg     = LANGUAGES[langKey]
  if (!cfg) throw new Error(`Unsupported language: "${language}"`)

  if (SANDBOX === 'isolate') return runWithIsolate({ code, language: langKey, stdin, timeoutMs })
  if (SANDBOX === 'docker')  return runWithDocker({ code, language: langKey, stdin, timeoutMs })
  throw new Error('No sandbox available. Install isolate or Docker.')
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { status: 'ok', sandbox: SANDBOX, version: '2.0.0', uptime: process.uptime() })
    return
  }

  if (req.method === 'GET' && req.url === '/languages') {
    sendJSON(res, 200, { languages: Object.keys(LANGUAGES) })
    return
  }

  if (req.method === 'POST' && req.url === '/execute') {
    const auth = req.headers['authorization'] ?? ''
    if (auth !== `Bearer ${AUTH_TOKEN}`) { sendJSON(res, 401, { error: 'Unauthorized' }); return }

    let body
    try { body = JSON.parse(await readBody(req)) }
    catch { sendJSON(res, 400, { error: 'Invalid JSON' }); return }

    const { code, language, stdin = '', timeoutMs = 5000 } = body
    if (!code?.trim()) { sendJSON(res, 400, { error: 'code required' });     return }
    if (!language)      { sendJSON(res, 400, { error: 'language required' }); return }

    console.log(`[${new Date().toISOString()}] [${SANDBOX}] ${language} | ${code.length} chars`)

    try {
      const result = await executeCode({ code, language, stdin, timeoutMs })
      console.log(`[${new Date().toISOString()}] Done: ${result.runtimeMs}ms | tle=${result.tle}`)
      sendJSON(res, 200, result)
    } catch (err) {
      console.error('Execute error:', err.message)
      sendJSON(res, 500, { error: err.message })
    }
    return
  }

  sendJSON(res, 404, { error: 'Not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔════════════════════════════════════════╗`)
  console.log(`║   CodeHiring Execution Engine v2.0.0  ║`)
  console.log(`╚════════════════════════════════════════╝`)
  console.log(`  Listening:  http://0.0.0.0:${PORT}`)
  console.log(`  Sandbox:    ${SANDBOX === 'isolate' ? '🔒 isolate (Codeforces-grade)' : SANDBOX === 'docker' ? '🐳 Docker' : '❌ none'}`)
  console.log(`  Auth token: ${AUTH_TOKEN.slice(0, 8)}...`)
  console.log(`  Languages:  ${Object.keys(LANGUAGES).join(', ')}`)
  console.log('')
})
