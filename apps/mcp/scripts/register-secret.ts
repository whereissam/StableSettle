#!/usr/bin/env bun
// One-shot Circle entity-secret setup for developer-controlled wallets.
//
// Generates a 32-byte entity secret (or reuses ENTITY_SECRET if you already set one),
// registers its ciphertext with Circle, writes the recovery file to ~/.circle, and prints
// the value to paste into apps/mcp/.env. Run once per Circle API key:
//
//   bun --cwd apps/mcp run register-secret
//
// Security: the recovery file + the secret are sensitive — never commit them.

import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const apiKey = process.env.CIRCLE_API_KEY
if (!apiKey || apiKey.includes('...') || apiKey.trim() === '') {
  console.error('✗ CIRCLE_API_KEY is not set. Put your TEST_API_KEY:... into apps/mcp/.env first.')
  process.exit(1)
}

// Reuse an already-chosen ENTITY_SECRET (64 hex chars) if present, else generate a fresh one.
const existing = process.env.ENTITY_SECRET?.trim()
const isHex64 = !!existing && /^[0-9a-fA-F]{64}$/.test(existing)
const entitySecret = isHex64 ? (existing as string) : crypto.randomBytes(32).toString('hex')

// The SDK writes the recovery file into this DIRECTORY (it picks the filename).
const recoveryDir = path.join(os.homedir(), '.circle')
fs.mkdirSync(recoveryDir, { recursive: true })

try {
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: recoveryDir })
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  if (/already.*registered|entity secret/i.test(msg)) {
    console.error(
      '\n✗ This API key already has a registered entity secret.\n' +
        '  • If you still have that secret, just paste it into apps/mcp/.env as ENTITY_SECRET.\n' +
        '  • To rotate it, do so in the Circle console (Configurator → reset entity secret), then re-run.\n',
    )
  } else {
    console.error('\n✗ Registration failed:', msg)
  }
  process.exit(1)
}

// Write ENTITY_SECRET straight into apps/mcp/.env — never echo the secret to stdout.
const envPath = path.join(import.meta.dir, '..', '.env')
let wrote = false
try {
  let env = fs.readFileSync(envPath, 'utf8')
  env = /^ENTITY_SECRET=.*$/m.test(env)
    ? env.replace(/^ENTITY_SECRET=.*$/m, `ENTITY_SECRET=${entitySecret}`)
    : env + `\nENTITY_SECRET=${entitySecret}\n`
  fs.writeFileSync(envPath, env)
  wrote = true
} catch {
  wrote = false
}

console.log('\n✅ Entity secret registered with Circle.')
console.log('   Recovery file written into:', recoveryDir)
console.log('   ⚠️  Keep that file safe and NEVER commit it — it recovers your wallets.')
console.log(
  wrote
    ? '   ✅ ENTITY_SECRET written into apps/mcp/.env (value not printed, for safety).'
    : '   ⚠️  Could not auto-write .env — set ENTITY_SECRET there manually.',
)
console.log('')
