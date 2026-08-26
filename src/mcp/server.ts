/**
 * The MCP surface of core: an OAuth 2.1 authorization server and one streamable-HTTP MCP endpoint.
 *
 * Everything a person decides happens here or on the consent screen in shell; everything a module
 * does happens through its ordinary REST routes, called with the caller's own access token. That is
 * the whole security model in one sentence: an AI client holds a token the way a browser holds a
 * session, and every permission, workspace boundary and capability switch that applies to any other
 * client applies to it identically.
 */

import { createHash } from 'node:crypto'
import type { Kernel } from '@kernhq/kernel'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CoreDeps } from '../modules/core/deps.js'
import { MODULE_ID } from '../modules/core/schema/base.js'
import { audienceAllows, CAPABILITY_AUDIENCE_KEY } from '../modules/core/services/capability-audience.js'
import { getModuleSettings } from '../modules/core/services/modules.js'
import { bearerOf, type McpToolDef, ToolCatalog } from './catalog.js'
import { createMcpOauth, parseScope, redirectUriAllowed } from './oauth.js'

export interface McpRuntime {
  oauth: ReturnType<typeof createMcpOauth>
  catalog: ToolCatalog
}

/** The scopes this instance can grant, derived from the tool catalog: `<module>:read|write`. */
async function supportedScopes(rt: McpRuntime): Promise<string[]> {
  const tools = await rt.catalog.tools()
  const modules = [...new Set(tools.map((t) => t.module))].sort()
  return modules.flatMap((m) => [`${m}:read`, `${m}:write`])
}

function publicBaseUrl(kernel: Kernel): string {
  // the origin browsers and MCP clients reach, not the container-internal one
  return kernel.env.KERN_BASE_URL.replace(/\/$/, '')
}

function issuer(kernel: Kernel): string {
  return publicBaseUrl(kernel)
}

export function createMcpRuntime(kernel: Kernel): McpRuntime {
  const oauth = createMcpOauth(kernel)
  const catalog = new ToolCatalog(kernel)
  return { oauth, catalog }
}

/**
 * Mounts discovery, OAuth endpoints and `/mcp` on the core service's Fastify instance.
 * Registered from `extendHttp`, beside Better Auth and the API docs.
 */
export async function mountMcp(app: FastifyInstance, kernel: Kernel, deps: CoreDeps): Promise<void> {
  // one runtime per process: created by the service host so the principal resolver can verify
  // tokens too, reused here if this is the API role that serves /mcp
  const rt = deps.mcp ?? createMcpRuntime(kernel)
  deps.mcp = rt

  await app.register(async (scope) => {
    // OAuth clients speak form-encoded; the JSON parser beside it covers MCP's own bodies.
    // Scoped to this plugin so the API's parsers stay untouched everywhere else.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const obj: Record<string, string> = {}
        for (const [k, v] of new URLSearchParams(String(body))) obj[k] = v
        done(null, obj)
      },
    )

    const issuerUrl = issuer(kernel)
    const protectedResource = {
      resource: issuerUrl,
      authorization_servers: [issuerUrl],
      bearer_methods_supported: ['header'],
    }

    // ---- discovery -------------------------------------------------------------

    scope.get('/.well-known/oauth-protected-resource', async () => ({
      ...protectedResource,
      scopes_supported: await supportedScopes(rt),
    }))
    scope.get('/.well-known/oauth-protected-resource/mcp', async () => ({
      ...protectedResource,
      scopes_supported: await supportedScopes(rt),
    }))

    scope.get('/.well-known/oauth-authorization-server', async () => ({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/api/mcp/oauth/authorize`,
      token_endpoint: `${issuerUrl}/api/mcp/oauth/token`,
      registration_endpoint: `${issuerUrl}/api/mcp/oauth/register`,
      revocation_endpoint: `${issuerUrl}/api/mcp/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: await supportedScopes(rt),
    }))

    // ---- dynamic client registration (RFC 7591) --------------------------------

    scope.post('/api/mcp/oauth/register', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const name = typeof body.client_name === 'string' ? body.client_name : null
      let uris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
        : []
      uris = [...new Set(uris)].filter(redirectUriAllowed)
      if (!name || uris.length === 0)
        return reply.status(400).send({
          error: 'invalid_client_metadata',
          error_description: 'client_name and at least one https (or loopback) redirect_uri are required',
        })
      const created = await rt.oauth.registerClient({
        name,
        clientUri: typeof body.client_uri === 'string' ? body.client_uri : null,
        logoUri: typeof body.logo_uri === 'string' ? body.logo_uri : null,
        redirectUris: uris,
        firstParty: false,
        confidential: body.token_endpoint_auth_method === 'client_secret_post',
      })
      return reply.status(201).send({
        client_id: created.clientId,
        ...(created.clientSecret
          ? { client_secret: created.clientSecret, token_endpoint_auth_method: 'client_secret_post' }
          : { token_endpoint_auth_method: 'none' }),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        code_challenge_method: 'S256',
      })
    })

    // ---- authorization endpoint --------------------------------------------------

    scope.get('/api/mcp/oauth/authorize', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>
      const fail = (error: string, description: string) =>
        reply.status(400).type('application/json').send({ error, error_description: description })
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be "code"')
      if (!q.client_id || !q.redirect_uri)
        return fail('invalid_request', 'client_id and redirect_uri are required')
      if (!q.code_challenge) return fail('invalid_request', 'PKCE is required (code_challenge, method S256)')
      if ((q.code_challenge_method ?? 'S256') !== 'S256')
        return fail('invalid_request', 'only S256 code_challenge_method is supported')
      const client = await rt.oauth.getClient(q.client_id)
      if (!client) return fail('invalid_client', 'unknown client_id')
      if (!client.redirectUris.includes(q.redirect_uri))
        return fail('invalid_request', 'redirect_uri is not registered for this client')
      const supported = await supportedScopes(rt)
      const requested = parseScope(q.scope)
      const scope = requested.length === 0 ? supported : requested
      if (scope.some((s) => !supported.includes(s)))
        return fail('invalid_scope', 'requested a scope this instance does not offer')

      // a person consents, so this endpoint answers a browser session — never a token
      const principal = await deps.principals.resolve(req).catch(() => null)
      if (principal?.kind !== 'user') {
        // the sign-in page lands on `next` after a successful login
        const next = encodeURIComponent(req.url)
        return reply.redirect(`${publicBaseUrl(kernel)}/sign-in?next=${next}`)
      }
      const id = await rt.oauth.createAuthRequest({
        userId: principal.userId as string,
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        scope,
        state: q.state ?? '',
        codeChallenge: q.code_challenge,
      })
      return reply.redirect(`${publicBaseUrl(kernel)}/authorize?id=${id}`)
    })

    // ---- token + revocation -------------------------------------------------------

    scope.post('/api/mcp/oauth/token', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
      const clientId = str(b.client_id)
      const grantType = str(b.grant_type)
      if (!clientId) return reply.status(401).send({ error: 'invalid_client' })
      const client = await rt.oauth.getClient(clientId)
      if (!client) return reply.status(401).send({ error: 'invalid_client' })
      if (client.secretHash) {
        const secret = str(b.client_secret)
        if (!secret || sha256Hex(secret) !== client.secretHash)
          return reply.status(401).send({ error: 'invalid_client' })
      }
      if (grantType === 'authorization_code') {
        const code = str(b.code)
        const verifier = str(b.code_verifier)
        const redirectUri = str(b.redirect_uri)
        if (!code || !redirectUri)
          return reply
            .status(400)
            .send({ error: 'invalid_request', error_description: 'code and redirect_uri are required' })
        try {
          const out = await rt.oauth.exchangeCode({
            code,
            clientId,
            redirectUri,
            codeVerifier: verifier,
          })
          return sendToken(reply, out)
        } catch (err) {
          return reply.status(400).send({ error: 'invalid_grant', error_description: messageOf(err) })
        }
      }
      if (grantType === 'refresh_token') {
        const refreshToken = str(b.refresh_token)
        if (!refreshToken) return reply.status(400).send({ error: 'invalid_request' })
        const out = await rt.oauth.rotateRefresh(refreshToken, clientId)
        if (!out) return reply.status(400).send({ error: 'invalid_grant' })
        return sendToken(reply, out)
      }
      return reply.status(400).send({ error: 'unsupported_grant_type' })
    })

    scope.post('/api/mcp/oauth/revoke', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      if (typeof b.token === 'string') await rt.oauth.revoke(b.token)
      // RFC 7009: always 200, even for a token that was never ours
      return reply.status(200).send({})
    })

    // ---- the MCP endpoint ---------------------------------------------------------

    scope.post('/mcp', async (req, reply) => {
      const tokenValue = bearerOf(req)
      if (!tokenValue) return unauthorized(reply)
      const token = await rt.oauth.verifyAccessToken(tokenValue)
      if (!token) return unauthorized(reply)

      // a disabled capability means this surface is simply not part of the workspace's API: 404,
      // like every other switched-off feature
      const caps = await kernel.capabilities(token.workspaceId, MODULE_ID)
      if (!caps.has('mcp')) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' })

      // principal of the user who consented, restricted to that workspace's membership
      // the consent named one workspace; the caller must still be an active member of it
      const full = await deps.principals.fromUserId(token.userId)
      const membership = full.memberships.find(
        (m) => m.workspaceId === token.workspaceId && m.status === 'active',
      )
      if (full.kind === 'anonymous' || !membership)
        return reply
          .status(403)
          .send({ code: 'FORBIDDEN', message: 'No active membership in the granted workspace' })

      // An audience restriction is not a second on/off switch — it is the same 404 the capability
      // switch itself gives everyone, just aimed at one person instead of the whole workspace.
      const settings = await getModuleSettings(kernel, token.workspaceId, MODULE_ID)
      if (!audienceAllows(settings[CAPABILITY_AUDIENCE_KEY], 'mcp', membership.groupIds))
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' })

      const tools = await filterTools(await rt.catalog.tools(), token.scopes, (moduleId) =>
        kernel.isModuleEnabled(token.workspaceId, moduleId),
      )

      const server = new Server({ name: 'Kern', version: kernel.version }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.write },
        })),
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = tools.find((t) => t.name === request.params.name)
        if (!tool)
          return toolError(
            `Unknown tool "${request.params.name}". It may belong to a module or scope you do not have.`,
          )
        if (!scopeAllows(token.scopes, tool))
          return toolError(
            `You do not have ${tool.module}:${tool.write ? 'write' : 'read'} access. Reconnect and grant it.`,
          )
        return executeTool(tool, request.params.arguments ?? {}, {
          accessToken: tokenValue,
          workspaceId: token.workspaceId,
          // locally hosted modules are dispatched in-process; remote ones over HTTP
          send: async (target: ApiRequest): Promise<ApiResponse> => {
            if (target.url === null) {
              const res = await app.inject({
                method: target.method as 'GET',
                url: target.path,
                headers: target.headers,
                payload: target.body ?? undefined,
              })
              return { status: res.statusCode, text: res.body }
            }
            const res = await fetch(target.url, {
              method: target.method,
              headers: target.headers,
              body: target.body,
              signal: AbortSignal.timeout(30_000),
            })
            return { status: res.status, text: await res.text() }
          },
        })
      })

      // stateless: one server and transport per request, nothing survives the response
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      reply.raw.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req.raw, reply.raw, req.body)
      return reply
    })

    // streamable HTTP is POST-only here: no session to resume, no SSE channel to hold open
    scope.get('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send())
    scope.delete('/mcp', async (_req, reply) => reply.status(405).header('allow', 'POST').send())

    // expired requests/codes/tokens are worthless rows; sweep them hourly rather than never
    const pruneTimer = setInterval(() => void rt.oauth.prune().catch(() => {}), 60 * 60_000)
    pruneTimer.unref?.()
  })
}

// ---- helpers -------------------------------------------------------------------

function unauthorized(reply: FastifyReply) {
  return reply.status(401).header('www-authenticate', 'Bearer').send({
    error: 'unauthorized',
    error_description: 'A Kern MCP access token is required',
  })
}

function sendToken(
  reply: FastifyReply,
  out: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    scopes: string[]
  },
) {
  return reply.send({
    access_token: out.accessToken,
    token_type: 'Bearer',
    expires_in: out.expiresIn,
    refresh_token: out.refreshToken,
    scope: out.scopes.join(' '),
  })
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** sha256 hex — the same digest form the oauth module stores */
const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex')

function scopeAllows(scopes: string[], tool: { module: string; write: boolean }): boolean {
  return scopes.includes(`${tool.module}:${tool.write ? 'write' : 'read'}`)
}

async function filterTools(
  tools: Awaited<ReturnType<ToolCatalog['tools']>>,
  scopes: string[],
  moduleEnabled: (moduleId: string) => Promise<boolean>,
) {
  const cache = new Map<string, boolean>()
  const out = []
  for (const t of tools) {
    if (!scopeAllows(scopes, t)) continue
    let on = cache.get(t.module)
    if (on === undefined) {
      on = await moduleEnabled(t.module)
      cache.set(t.module, on)
    }
    if (on) out.push(t)
  }
  return out
}

export interface ApiRequest {
  url: string | null
  path: string
  method: string
  headers: Record<string, string>
  body?: string
}
export interface ApiResponse {
  status: number
  text: string
}

interface ToolCallContext {
  accessToken: string
  workspaceId: string
  /** performs the request: in-process for locally hosted modules, HTTP for remote services */
  send(target: ApiRequest): Promise<ApiResponse>
}

const toolError = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true as const,
})

/**
 * Runs a tool through the module's ordinary REST route with the caller's own token — the exact
 * request any other API client would make, so every middleware answers it too: membership,
 * permission keys and capability gating all apply unchanged.
 */
async function executeTool(
  tool: McpToolDef,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const query = new URLSearchParams()
    const path = tool.template.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (name === 'workspaceId') return encodeURIComponent(ctx.workspaceId)
      const v = args[name]
      if (v === undefined) return ''
      delete args[name]
      return encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))
    })
    for (const [k, v] of Object.entries(args)) {
      if (k === 'data' || k === 'workspaceId' || v === undefined || v === null) continue
      query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const qs = query.toString()
    const fullPath = `${path}${qs ? `?${qs}` : ''}`
    const body = args.data !== undefined ? JSON.stringify(args.data) : undefined
    if (body) {
      // one connection, one workspace: a body naming another one is refused rather than rewritten
      const wsId = (args.data as Record<string, unknown>).workspaceId
      if (typeof wsId === 'string' && wsId !== ctx.workspaceId)
        return toolError('This connection is authorized for one workspace only.')
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${ctx.accessToken}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    }

    const res = await ctx.send({
      url: tool.baseUrl || null,
      path: fullPath,
      method: tool.method,
      headers,
      body: body !== undefined && tool.method !== 'GET' && tool.method !== 'HEAD' ? body : undefined,
    })
    let payload: unknown = res.text
    try {
      payload = JSON.parse(res.text)
    } catch {
      // leave as text
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: res.status, body: payload }) }],
      isError: res.status >= 400,
    }
  } catch (err) {
    return toolError(`Tool call failed: ${messageOf(err)}`)
  }
}
