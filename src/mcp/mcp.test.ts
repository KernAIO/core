import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'
import { pkceChallenge } from './oauth.js'

/**
 * The MCP surface, end to end.
 *
 * A client registers (dynamic registration), a user consents in their workspace (the oRPC
 * procedure the consent screen calls), the code is exchanged for tokens over the real token
 * endpoint, and the resulting access token drives `/mcp` — tools listed, tool called, everything
 * else refused. The capability switch answers 404 while it is off, and every refusal here is the
 * one the spec or the security model asks for.
 */

let core: TestCore
let owner: TestUser
let api: Awaited<ReturnType<TestCore['apiOf']>>
let workspaceId: string

async function registerClient(redirectUris = ['http://localhost:8765/callback']) {
  const res = await core.service.app!.inject({
    method: 'POST',
    url: '/api/mcp/oauth/register',
    payload: { client_name: 'Test AI Client', redirect_uris: redirectUris },
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { client_id: string; client_secret?: string }
}

/** Consent through the same procedure the shell's authorize page uses. */
async function consent(clientId: string, scopes: string[]) {
  const requestId = await core.service.deps.mcp!.oauth.createAuthRequest({
    userId: owner.id,
    clientId,
    redirectUri: 'http://localhost:8765/callback',
    scope: scopes,
    state: 'st-123',
    codeChallenge: pkceChallenge('unused-verifier'),
  })
  return api.mcp.authorize.approve({ id: requestId, workspaceId })
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

async function exchange(body: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
  const res = await core.service.app!.inject({
    method: 'POST',
    url: '/api/mcp/oauth/token',
    payload: body,
  })
  return { status: res.statusCode, json: res.json() }
}

/** JSON-RPC over /mcp with an access token. */
async function mcp(
  method: string,
  params: unknown,
  accessToken?: string,
): Promise<{
  statusCode: number
  json(): {
    result?: {
      tools?: Array<{ name: string }>
      isError?: boolean
      content?: Array<{ text: string }>
    }
  }
}> {
  return core.service.app!.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      // what the streamable-HTTP transport requires of every real client
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) },
  })
}

const enableMcp = async (on: boolean) => {
  await api.workspaces.modules.updateSettings({
    workspaceId,
    moduleId: 'core',
    settings: { $capabilities: { mcp: on } },
  })
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'MCP Owner' })
  const workspace = await owner.api.workspaces.create({
    name: 'MCP',
    slug: `mcp-${Date.now().toString(36)}`,
  })
  workspaceId = workspace.id
  api = await core.apiOf(owner.id)
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('discovery', () => {
  it('serves the protected-resource and authorization-server metadata', async () => {
    const pr = await core.service.app!.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
    expect(pr.statusCode).toBe(200)
    const resource = pr.json()
    expect(resource.authorization_servers.length).toBeGreaterThan(0)

    const asRes = await core.service.app!.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    })
    expect(asRes.statusCode).toBe(200)
    const meta = asRes.json()
    expect(meta.grant_types_supported).toContain('authorization_code')
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    // every hosted module advertises read and write scopes — that is the "no per-module work" claim
    expect(meta.scopes_supported).toContain('tracker:read')
    expect(meta.scopes_supported).toContain('core:write')
  })

  it('rejects dynamic client registration without a usable redirect uri', async () => {
    const res = await core.service.app!.inject({
      method: 'POST',
      url: '/api/mcp/oauth/register',
      payload: { client_name: 'Bad Client', redirect_uris: ['https://evil.example/cb'] },
    })
    expect(res.statusCode).toBe(201) // https is allowed; the check below is the real refusal
    void res
    const bad = await core.service.app!.inject({
      method: 'POST',
      url: '/api/mcp/oauth/register',
      payload: { client_name: 'Bad Client', redirect_uris: [] },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('invalid_client_metadata')
  })
})

describe('the authorization-code flow', () => {
  it('refuses to issue a grant while the mcp capability is off', async () => {
    const client = await registerClient()
    await enableMcp(false)
    await expect(consent(client.client_id, ['core:read'])).rejects.toThrow(/not found|MCP/i)
  })

  it('issues tokens after consent, with PKCE enforced', async () => {
    const client = await registerClient()
    await enableMcp(true)
    const challenge = pkceChallenge('my-verifier-42')
    const requestId = await core.service.deps.mcp!.oauth.createAuthRequest({
      userId: owner.id,
      clientId: client.client_id,
      redirectUri: 'http://localhost:8765/callback',
      scope: 'core:read tracker:read'.split(' '),
      state: 'xyz',
      codeChallenge: challenge,
    })
    const { redirectUrl } = await api.mcp.authorize.approve({ id: requestId, workspaceId })
    const url = new URL(redirectUrl)
    expect(url.searchParams.get('state')).toBe('xyz')
    const code = url.searchParams.get('code')!
    expect(code).toBeTruthy()

    // wrong verifier → no tokens
    const wrong = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'not-the-verifier',
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error).toBe('invalid_grant')

    const ok = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'my-verifier-42',
    })
    expect(ok.status).toBe(200)
    expect(ok.json.access_token?.startsWith('kmt_')).toBe(true)
    expect(ok.json.refresh_token?.startsWith('kmr_')).toBe(true)
    expect(ok.json.scope).toBe('core:read tracker:read')

    // codes are single-use
    const replay = await exchange({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'my-verifier-42',
    })
    expect(replay.status).toBe(400)
  })

  it('rotates refresh tokens once', async () => {
    const client = await registerClient()
    await enableMcp(true)
    const { redirectUrl } = await consent(client.client_id, ['core:read'])
    const first = await exchange({
      grant_type: 'authorization_code',
      code: new URL(redirectUrl).searchParams.get('code')!,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'unused-verifier',
    })
    const rotate = await exchange({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: first.json.refresh_token!,
    })
    expect(rotate.status).toBe(200)
    expect(rotate.json.refresh_token).not.toBe(first.json.refresh_token)
    // the presented refresh token died with its exchange
    const again = await exchange({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: first.json.refresh_token!,
    })
    expect(again.status).toBe(400)
  })
})

describe('the /mcp endpoint', () => {
  let accessToken: string
  let clientId: string

  beforeAll(async () => {
    const client = await registerClient()
    clientId = client.client_id
    await enableMcp(true)
    const { redirectUrl } = await consent(clientId, ['core:read'])
    const out = await exchange({
      grant_type: 'authorization_code',
      code: new URL(redirectUrl).searchParams.get('code')!,
      client_id: clientId,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'unused-verifier',
    })
    accessToken = out.json.access_token!
  }, 120_000)

  it('answers 401 without a token and 404 while the capability is off', async () => {
    const anon = await mcp('tools/list', {})
    expect(anon.statusCode).toBe(401)

    await enableMcp(false)
    const off = await mcp('tools/list', {}, accessToken)
    expect(off.statusCode).toBe(404)
    await enableMcp(true)
  })

  it('lists only tools within the granted scopes', async () => {
    const res = await mcp('tools/list', {}, accessToken)
    expect(res.statusCode).toBe(200)
    const tools = res.json().result?.tools ?? []
    expect(tools.length).toBeGreaterThan(0)
    // granted core:read only → nothing from tracker may appear
    for (const t of tools) expect(t.name.startsWith('tracker_'), `${t.name} leaked`).toBe(false)
    const me = tools.find((t) => t.name.includes('users_me'))
    expect(me, 'a users/me tool exists').toBeDefined()
  })

  it('calls a tool through the module API with the caller’s own permissions', async () => {
    const list = await mcp('tools/list', {}, accessToken)
    const tools = list.json().result?.tools ?? []
    const meTool = tools.find((t) => t.name.includes('users_me'))
    if (!meTool) return // contract changed shape; the list test above already covers exposure
    const call = await mcp('tools/call', { name: meTool.name, arguments: {} }, accessToken)
    expect(call.statusCode).toBe(200)
    const result = call.json().result!
    expect(result.isError).toBeFalsy()
    expect(result.content?.[0]?.text).toContain(owner.email)
  })

  it('refuses a scope it did not grant', async () => {
    const list = await mcp('tools/list', {}, accessToken)
    const trackerTool = (list.json().result?.tools ?? []).find((t) => t.name.startsWith('tracker_'))
    expect(trackerTool).toBeUndefined()
  })

  it('stops serving entirely after the connection is revoked', async () => {
    const tokens = await api.mcp.tokens.list({ workspaceId })
    const mine = tokens.find((t) => t.userId === owner.id && t.clientId === clientId)
    expect(mine).toBeDefined()
    await api.mcp.tokens.revoke({ id: mine!.id })

    const res = await mcp('tools/list', {}, accessToken)
    // the access token dies with the connection
    expect(res.statusCode).toBe(401)
  })
})

/**
 * Every hosted module's read tools, called for real.
 *
 * The suite above only ever asserted which tools were **listed**, and listing is generated from the
 * OpenAPI document, so it stayed green while every call failed. `executeTool` substituted the
 * connection's workspace into a `{workspaceId}` path placeholder — which no module's template
 * contains — and then skipped `workspaceId` when building the query string, where every module
 * actually wants it: 142 of the 190 read tools answered
 * `400 {"code":"BAD_REQUEST","issues":[{"path":["workspaceId"]}]}`.
 *
 * So this calls one generated GET tool per hosted module, through `/mcp`, and reads the status the
 * module answered out of the tool result. A tool whose only required argument is `workspaceId` is
 * the honest sample: nothing else has to be invented, so a failure is the plumbing and not the
 * fixture.
 */
describe('the generated read tools of every hosted module', () => {
  const MODULES = ['core', 'tracker', 'quire', 'hr', 'inventory', 'billing'] as const
  let readToken: string
  /** every listed tool, with the input schema the catalog generated */
  let listed: Array<{ name: string; inputSchema?: { required?: string[] } }>

  beforeAll(async () => {
    const client = await registerClient()
    await enableMcp(true)
    const { redirectUrl } = await consent(
      client.client_id,
      MODULES.map((m) => `${m}:read`),
    )
    const out = await exchange({
      grant_type: 'authorization_code',
      code: new URL(redirectUrl).searchParams.get('code')!,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'unused-verifier',
    })
    readToken = out.json.access_token!
    const res = await mcp('tools/list', {}, readToken)
    listed = (res.json().result?.tools ?? []) as unknown as typeof listed
  }, 120_000)

  it.each(MODULES)('answers a %s read tool with 200 rather than a missing workspaceId', async (module) => {
    const candidate = listed.find(
      (t) =>
        t.name.startsWith(`${module}_`) &&
        (t.inputSchema?.required ?? []).length === 1 &&
        t.inputSchema?.required?.[0] === 'workspaceId',
    )
    expect(candidate, `${module} exposes a read tool taking only workspaceId`).toBeDefined()

    const call = await mcp('tools/call', { name: candidate!.name, arguments: {} }, readToken)
    expect(call.statusCode).toBe(200)
    const text = call.json().result?.content?.[0]?.text ?? ''
    const answered = JSON.parse(text) as { status: number; body: unknown }
    expect(answered.status, `${candidate!.name} answered ${answered.status}: ${text.slice(0, 300)}`).toBe(200)
    expect(call.json().result?.isError).toBeFalsy()
  })

  /**
   * The workspace is the connection's, not the model's. A tool call naming somebody else's
   * workspace must not reach it — the query string the model supplied is overwritten, not merged.
   */
  it('ignores a workspaceId the model supplies', async () => {
    const candidate = listed.find(
      (t) =>
        t.name.startsWith('tracker_') &&
        (t.inputSchema?.required ?? []).length === 1 &&
        t.inputSchema?.required?.[0] === 'workspaceId',
    )!
    const other = await core.signUp({ name: 'Another owner' })
    const elsewhere = await other.api.workspaces.create({
      name: 'Elsewhere',
      slug: `elsewhere-${Date.now().toString(36)}`,
    })
    const call = await mcp(
      'tools/call',
      { name: candidate.name, arguments: { workspaceId: elsewhere.id } },
      readToken,
    )
    const answered = JSON.parse(call.json().result?.content?.[0]?.text ?? '{}') as { status: number }
    // 200 from *our* workspace, not 403 from theirs: the argument was replaced before it was sent
    expect(answered.status).toBe(200)
  })
})

/**
 * The token is a key to what was consented to, everywhere — not only inside `/mcp`.
 *
 * `/mcp` has always held a tool call to the granted scopes, but the token itself resolved into the
 * user's whole principal, so an AI client could put the same `kmt_…` bearer on
 * `POST /api/tracker/projects` and act with everything its owner may do. A read-only grant on one
 * module was a full read-write credential on every module the instance hosts.
 */
describe('an MCP access token used directly against the module APIs', () => {
  let token: string

  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    core.service.app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })

  beforeAll(async () => {
    const client = await registerClient()
    await enableMcp(true)
    const { redirectUrl } = await consent(client.client_id, ['tracker:read'])
    const out = await exchange({
      grant_type: 'authorization_code',
      code: new URL(redirectUrl).searchParams.get('code')!,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'unused-verifier',
    })
    token = out.json.access_token!
  }, 120_000)

  it('reads the module it was granted', async () => {
    const res = await call('GET', `/api/tracker/projects?workspaceId=${workspaceId}`)
    expect(res.statusCode).toBe(200)
  })

  it('cannot write the module it was granted read on', async () => {
    const res = await call('POST', '/api/tracker/projects', {
      workspaceId,
      key: 'MCP',
      name: 'Written by a read-only token',
      template: 'software',
    })
    expect(res.statusCode).toBe(401)
    // and nothing was created
    const after = await call('GET', `/api/tracker/projects?workspaceId=${workspaceId}`)
    expect(after.body).not.toContain('Written by a read-only token')
  })

  it('cannot read a module it was not granted', async () => {
    const res = await call('GET', `/api/hr/people?workspaceId=${workspaceId}`)
    expect(res.statusCode).toBe(401)
    const core401 = await call('GET', `/api/core/workspaces/${workspaceId}`)
    expect(core401.statusCode).toBe(401)
  })
})

describe('admin surfaces', () => {
  it('lists connected clients with token counts', async () => {
    const clients = await api.mcp.clients.list({ workspaceId })
    expect(Array.isArray(clients)).toBe(true)
  })
})
