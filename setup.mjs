/**
 * Setup script — pulls all Docker images needed for execution.
 * Run once after cloning: node setup.mjs
 */
import { execSync } from 'node:child_process'

const IMAGES = [
  'python:3.11-slim',
  'node:20-slim',
  'openjdk:17-slim',
  'gcc:13',
  'mcr.microsoft.com/dotnet/sdk:8.0',
  'golang:1.21-alpine',
  'swift:5.9-slim',
]

console.log('🐳 Pulling Docker images...\n')

for (const img of IMAGES) {
  console.log(`Pulling ${img}...`)
  try {
    execSync(`docker pull ${img}`, { stdio: 'inherit' })
    console.log(`✓ ${img}\n`)
  } catch {
    console.error(`✗ Failed to pull ${img}\n`)
  }
}

console.log('Done! Start the server with: node server.mjs')
