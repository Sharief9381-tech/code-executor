/**
 * Test script — sends sample submissions to the executor.
 * Run: node test.mjs
 * Make sure the server is running first: node server.mjs
 */

const BASE     = 'http://localhost:4000'
const TOKEN    = process.env.EXECUTOR_SECRET ?? 'codehiring-executor-secret'
const HEADERS  = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }

const TESTS = [
  {
    name:     'Python — Factorial',
    language: 'python',
    stdin:    '5',
    expected: '120',
    code: `
n = int(input())
result = 1
for i in range(1, n+1):
    result *= i
print(result)
`.trim(),
  },
  {
    name:     'JavaScript — Sum',
    language: 'javascript',
    stdin:    '3\n4',
    expected: '7',
    code: `
const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\\n')
console.log(Number(lines[0]) + Number(lines[1]))
`.trim(),
  },
  {
    name:     'Java — Hello',
    language: 'java',
    stdin:    '',
    expected: 'Hello World',
    code: `
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello World");
    }
}
`.trim(),
  },
  {
    name:     'C++ — Square',
    language: 'c++',
    stdin:    '7',
    expected: '49',
    code: `
#include <iostream>
using namespace std;
int main() {
    int n; cin >> n;
    cout << n * n << endl;
    return 0;
}
`.trim(),
  },
  {
    name:     'Python — TLE test',
    language: 'python',
    stdin:    '',
    expected: 'TLE',
    timeoutMs: 2000,
    code: `while True: pass`,
  },
  {
    name:     'Python — Compile/Runtime Error',
    language: 'python',
    stdin:    '',
    expected: 'error',
    code: `print(undefined_variable)`,
  },
]

async function runTest(t) {
  const res  = await fetch(`${BASE}/execute`, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify({
      code:      t.code,
      language:  t.language,
      stdin:     t.stdin ?? '',
      timeoutMs: t.timeoutMs ?? 5000,
    }),
  })
  const data = await res.json()

  const got    = (data.output ?? '').trim()
  const isTLE  = data.tle
  const isErr  = !!data.error

  let pass = false
  if (t.expected === 'TLE')   pass = isTLE
  else if (t.expected === 'error') pass = isErr && !isTLE
  else pass = got === t.expected

  const icon = pass ? '✓' : '✗'
  console.log(`${icon} ${t.name}`)
  if (!pass) {
    console.log(`  Expected: ${t.expected}`)
    console.log(`  Got:      ${got || data.error || '(empty)'}`)
  } else {
    console.log(`  Runtime: ${data.runtimeMs}ms`)
  }
  console.log()
}

// Check health first
try {
  const h = await fetch(`${BASE}/health`)
  const d = await h.json()
  console.log(`Executor status: ${d.status} (uptime ${d.uptime?.toFixed(1)}s)\n`)
} catch {
  console.error('Cannot reach executor. Start it first: node server.mjs\n')
  process.exit(1)
}

console.log('Running tests...\n')
for (const t of TESTS) {
  await runTest(t)
}
