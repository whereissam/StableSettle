#!/usr/bin/env bun
// Provision a hosted user: map their bearer token → their OWN owner address. After this, when that
// user connects (Authorization: Bearer <token>) and spawns an agent, the vault is owned by THEIR
// address — the operator is never the owner. Run by the operator/admin.
//
//   bun run register-user <token> <userId> <ownerAddress>
//   bun run register-user $(openssl rand -hex 24) alice 0xUserOwnerAddress…
//
// Give the printed token to that user; they connect with:
//   claude mcp add --transport http stablesettle <url>/mcp --header "Authorization: Bearer <token>"

import { registerUser } from '../src/users.ts'

const [token, userId, ownerAddress] = process.argv.slice(2)
if (!token || !userId || !ownerAddress) {
  console.error('Usage: bun run register-user <token> <userId> <ownerAddress>')
  process.exit(1)
}

const rec = registerUser(token, userId, ownerAddress)
console.log(`✓ Registered user "${rec.userId}" → owner ${rec.ownerAddress}`)
console.log('  This user\'s agents will be owned by THAT address (operator is never the owner).')
console.log('  They connect with:  Authorization: Bearer <the token you passed>')
