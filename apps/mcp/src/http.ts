// Hosted transport: serve the StableSettle MCP server over Streamable HTTP so users connect with a
// URL and run nothing locally. The stdio path (index.ts) stays the default for local/.mcp.json use.
//
// SECURITY: this process holds the deployer + Circle keys, so a hosted instance MUST be protected —
// set MCP_AUTH_TOKEN and clients send `Authorization: Bearer <token>`. Without it the server refuses
// to require auth but logs a loud warning; never expose an unprotected instance to the internet.

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { hasUsers, userForToken, type ServerContext } from './users.ts'

function rpcError(message: string, status: number, code = -32000): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}

/** Start the Streamable-HTTP server. `buildServer` mints a fresh MCP server per session, bound to the
 *  authenticated caller's context (so per-user sessions own their own vaults). */
export function startHttpServer(buildServer: (ctx?: ServerContext) => McpServer): void {
  const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 8080)
  const authToken = process.env.MCP_AUTH_TOKEN || undefined

  // Resolve a request's bearer token to: rejected, admin (no ctx → config owner), or a per-user ctx
  // (the user's own owner address). Admin token = the shared MCP_AUTH_TOKEN; per-user tokens are in the
  // user registry. With neither configured, the server is open (local dev) — the loud warning still fires.
  function resolveContext(req: Request): { ok: boolean; ctx?: ServerContext } {
    const header = req.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (authToken && token === authToken) return { ok: true } // operator/admin → owner from config
    const user = token ? userForToken(token) : undefined
    if (user) return { ok: true, ctx: { ownerAddress: user.ownerAddress, userId: user.userId } }
    // A token was required (admin token set or users registered) but didn't match → reject.
    if (authToken || hasUsers()) return { ok: false }
    return { ok: true } // fully open (no auth configured)
  }

  // One transport per MCP session, keyed by the session id the SDK assigns on initialize.
  const sessions: Record<string, WebStandardStreamableHTTPServerTransport> = {}

  async function handleMcp(req: Request): Promise<Response> {
    const auth = resolveContext(req)
    if (!auth.ok) return rpcError('Unauthorized', 401, -32001)

    // Existing session: hand the request straight to its transport (POST/GET/DELETE).
    const sid = req.headers.get('mcp-session-id') ?? undefined
    if (sid && sessions[sid]) return sessions[sid].handleRequest(req)
    if (sid) return rpcError('Unknown or expired session id', 404, -32001)

    // No session yet — only an `initialize` POST may open one.
    if (req.method !== 'POST') return rpcError('No session; send an initialize request first', 400)
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return rpcError('Invalid JSON body', 400, -32700)
    }
    if (!isInitializeRequest(body)) return rpcError('No valid session id; expected an initialize request', 400)

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // plain request/response — simpler behind proxies, no long-lived SSE
      onsessioninitialized: (id) => {
        sessions[id] = transport
      },
      onsessionclosed: (id) => {
        delete sessions[id]
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) delete sessions[transport.sessionId]
    }
    // Bind this session's server to the authenticated caller — a per-user ctx makes their vaults
    // owned by their own address; admin (no ctx) falls back to the configured owner.
    await buildServer(auth.ctx).connect(transport)
    // Body already consumed above — pass it back so the transport doesn't try to re-read the stream.
    return transport.handleRequest(req, { parsedBody: body })
  }

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return new Response('ok\n')
      if (url.pathname === '/mcp') {
        try {
          return await handleMcp(req)
        } catch (e) {
          return rpcError(e instanceof Error ? e.message : 'Internal error', 500, -32603)
        }
      }
      return new Response('Not found\n', { status: 404 })
    },
  })

  const guard = authToken ? 'bearer-token protected' : '⚠ UNPROTECTED — set MCP_AUTH_TOKEN before exposing!'
  console.error(`StableSettle MCP server ready (HTTP) on :${port}/mcp — ${guard}`)
}
