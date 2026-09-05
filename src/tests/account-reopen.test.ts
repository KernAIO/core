import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pkceChallenge } from '../mcp/oauth.js'
import { user } from '../modules/core/schema/index.js'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * The 30-day undo the terms and the privacy policy both promise, actually reached.
 *
 * Closing an account suspends the user row and deletes every session, and `principal.ts` answers
 * ANONYMOUS for any non-active user on every credential path there is — so `DELETE
 * /api/core/account/deletion`, which went through `authed()`, answered 401 to the only person
 * entitled to call it, for the whole of the window. The promise was unreachable by construction,
 * and on a self-hosted instance whose only administrator closed their own account nobody could
 * reach it at all.
 *
 * Everything here goes through the HTTP route with a real Better Auth session, because that is the
 * only way to see the 401: the service functions underneath were always callable and always worked.
 */

let core: TestCore

const PASSWORD = 'correct-horse-battery-staple'

/** A request carrying exactly the headers named and nothing else — one credential at a time. */
async function callWith(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: object,
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON body from a raw route
): Promise<{ status: number; body: any }> {
  const res = await core.service.app!.inject({
    method,
    url,
    headers: { ...headers, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | null,
  payload?: object,
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON body from a raw route
): Promise<{ status: number; body: any }> =>
  callWith(method, url, token ? { authorization: `Bearer ${token}` } : {}, payload)

/** Sign in again, the way somebody who changed their mind would. */
async function signInAgain(email: string): Promise<string | null> {
  const res = await core.service.deps.auth.api
    .signInEmail({ body: { email, password: PASSWORD } })
    .catch(() => null)
  return res?.token ?? null
}

/** Sign in again and keep the cookie, which is what the browser the shell runs in actually sends. */
async function signInForCookie(email: string): Promise<string> {
  const { headers } = await core.service.deps.auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  })
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ')
  if (!cookie) throw new Error('signing in set no cookie')
  return cookie
}

/** Close an account through the real route, from a session that is about to be revoked. */
async function close(leaver: TestUser): Promise<void> {
  const res = await call('POST', '/api/core/account/deletion', leaver.token, {})
  expect(res.status, JSON.stringify(res.body)).toBe(202)
}

async function statusOf(userId: string): Promise<string | undefined> {
  const [row] = await core.kernel.database.db
    .select({ status: user.status })
    .from(user)
    .where(eq(user.id, userId))
  return row?.status
}

/** A workspace of the leaver's own, with one of core's level-2 capabilities switched on. */
async function workspaceWith(leaver: TestUser, capability: 'api_keys' | 'mcp'): Promise<string> {
  const workspace = await leaver.api.workspaces.create({
    name: 'Leaving',
    slug: `reopen-${capability.replace(/_/g, '-')}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`,
  })
  const api = await core.apiOf(leaver.id)
  await api.workspaces.modules.updateSettings({
    workspaceId: workspace.id,
    moduleId: 'core',
    settings: { $capabilities: { [capability]: true } },
  })
  return workspace.id
}

beforeAll(async () => {
  core = await startCore()
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('changing your mind about closing your account', () => {
  it('lets the closed account read and cancel its own closure', async () => {
    const leaver = await core.signUp({ name: 'Second Thoughts' })

    const closed = await call('POST', '/api/core/account/deletion', leaver.token, {})
    expect(closed.status).toBe(202)

    // the session it was closed from is gone, which is what "closed on every device" means
    const withOldSession = await call('DELETE', '/api/core/account/deletion', leaver.token)
    expect(withOldSession.status).toBe(401)

    // so they sign in again — Better Auth knows nothing of `users.status`, so this still works
    const token = await signInAgain(leaver.email)
    expect(token, 'a closed account can still sign in; it just cannot do anything').toBeTruthy()

    // and every ordinary API call is still anonymous, because the account is suspended
    const ordinary = await call(
      'GET',
      '/api/core/exports?workspaceId=00000000-0000-4000-8000-000000000000',
      token,
    )
    expect(ordinary.status, 'a closed account stays unusable everywhere else').toBe(401)

    const pending = await call('GET', '/api/core/account/deletion', token)
    expect(pending.status).toBe(200)
    expect(pending.body.subjectKind).toBe('account')

    const undone = await call('DELETE', '/api/core/account/deletion', token)
    expect(undone.status, JSON.stringify(undone.body)).toBe(200)
    expect(undone.body.status).toBe('cancelled')

    const [row] = await core.kernel.database.db
      .select({ status: user.status })
      .from(user)
      .where(eq(user.id, leaver.id))
    expect(row?.status).toBe('active')

    // and the account works again
    const back = await signInAgain(leaver.email)
    const me = await call('GET', '/api/core/account/deletion', back)
    expect(me.status, 'nothing is scheduled any more').toBe(404)
  })

  it('does not let a closed account act for anybody else', async () => {
    const a = await core.signUp({ name: 'Closed A' })
    const b = await core.signUp({ name: 'Untouched B' })
    await call('POST', '/api/core/account/deletion', a.token, {})
    const token = await signInAgain(a.email)
    const meddling = await call('DELETE', '/api/core/account/deletion', token, { userId: b.id })
    expect(meddling.status).toBe(403)
  })

  it('refuses a credential that is not a session', async () => {
    const leaver = await core.signUp({ name: 'Api Key Holder' })
    await call('POST', '/api/core/account/deletion', leaver.token, {})
    // a made-up bearer, and a JWT-shaped one: neither is a session, so neither reopens anything
    for (const bogus of ['kmt_not-a-real-token', 'a.b.c', 'sk_live_whatever'])
      expect((await call('DELETE', '/api/core/account/deletion', bogus)).status).toBe(401)
  })
})

/**
 * Which credential reopens a closed account, measured one credential at a time.
 *
 * `authedOrClosed` is the one door a suspended account may walk through, and the first version of
 * it asked `auth.api.getSession` whether there was a session — which is not the same question as
 * whether the *caller* holds one. Better Auth's api-key plugin runs with
 * `enableSessionForAPIKeys`, so it manufactures a session out of an `x-api-key` header before
 * `/get-session` ever looks anything up, and it never reads `users.status`. So a key the leaver
 * already held reopened their own closed account — a **read**-scoped key too — while
 * `principals.resolve` was correctly answering ANONYMOUS for the very same request.
 *
 * Every case below sends one header on a fresh closed account, because that is the only shape in
 * which the difference is visible: the route is the same, the service function underneath is the
 * same, and only the credential changes.
 */
describe('the credentials a closed account may still be holding', () => {
  it('reopens from the session cookie a browser sends', async () => {
    const leaver = await core.signUp({ name: 'Cookie Holder' })
    await close(leaver)
    expect(await statusOf(leaver.id)).toBe('suspended')

    const cookie = await signInForCookie(leaver.email)
    const undone = await callWith('DELETE', '/api/core/account/deletion', { cookie })
    expect(undone.status, JSON.stringify(undone.body)).toBe(200)
    expect(undone.body.status).toBe('cancelled')
    expect(await statusOf(leaver.id)).toBe('active')
  })

  it('refuses an API key, at either scope', async () => {
    const leaver = await core.signUp({ name: 'Key Holder' })
    const workspaceId = await workspaceWith(leaver, 'api_keys')
    const api = await core.apiOf(leaver.id)
    const readWrite = await api.apiKeys.create({
      workspaceId,
      name: 'Full access',
      scope: 'read_write',
      expiresInDays: null,
    })
    const readOnly = await api.apiKeys.create({
      workspaceId,
      name: 'Read only',
      scope: 'read',
      expiresInDays: null,
    })

    await close(leaver)

    for (const [scope, key] of [
      ['read', readOnly.key],
      ['read_write', readWrite.key],
    ] as const) {
      const res = await callWith('DELETE', '/api/core/account/deletion', { 'x-api-key': key })
      expect(res.status, `a ${scope} API key reopened a closed account: ${JSON.stringify(res.body)}`).toBe(
        401,
      )
      expect(await statusOf(leaver.id), `a ${scope} API key un-suspended the row`).toBe('suspended')
      // and it cannot read the closure either
      const read = await callWith('GET', '/api/core/account/deletion', { 'x-api-key': key })
      expect(read.status).toBe(401)
    }
  })

  it('refuses a JWT', async () => {
    const leaver = await core.signUp({ name: 'Jwt Holder' })
    const issued = await core.service.deps.auth.api.getToken({
      headers: new Headers({ authorization: `Bearer ${leaver.token}` }),
    })
    expect(issued.token).toBeTruthy()

    await close(leaver)

    const res = await call('DELETE', '/api/core/account/deletion', issued.token)
    expect(res.status, JSON.stringify(res.body)).toBe(401)
    expect(await statusOf(leaver.id)).toBe('suspended')
  })

  it('refuses an MCP token', async () => {
    const leaver = await core.signUp({ name: 'Mcp Holder' })
    const workspaceId = await workspaceWith(leaver, 'mcp')
    const api = await core.apiOf(leaver.id)

    const registered = await core.service.app!.inject({
      method: 'POST',
      url: '/api/mcp/oauth/register',
      payload: { client_name: 'Reopen Test Client', redirect_uris: ['http://localhost:8765/callback'] },
    })
    const clientId = registered.json().client_id as string
    const requestId = await core.service.deps.mcp!.oauth.createAuthRequest({
      userId: leaver.id,
      clientId,
      redirectUri: 'http://localhost:8765/callback',
      scope: ['core:read', 'core:write'],
      state: 'st-reopen',
      codeChallenge: pkceChallenge('unused-verifier'),
    })
    const { redirectUrl } = await api.mcp.authorize.approve({ id: requestId, workspaceId })
    const exchanged = await core.service.app!.inject({
      method: 'POST',
      url: '/api/mcp/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        code: new URL(redirectUrl).searchParams.get('code')!,
        client_id: clientId,
        redirect_uri: 'http://localhost:8765/callback',
        code_verifier: 'unused-verifier',
      },
    })
    const mcpToken = exchanged.json().access_token as string
    expect(mcpToken?.startsWith('kmt_')).toBe(true)

    await close(leaver)

    const res = await call('DELETE', '/api/core/account/deletion', mcpToken)
    expect(res.status, JSON.stringify(res.body)).toBe(401)
    expect(await statusOf(leaver.id)).toBe('suspended')
  })
})

describe('the last administrator of an instance', () => {
  it('cannot close the account that is the only way back in', async () => {
    const admin = await core.signUp({ name: 'Only Admin' })
    await core.promoteToInstanceAdmin(admin.id)

    const refused = await call('POST', '/api/core/account/deletion', admin.token, {})
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.reason).toBe('core.account.last_instance_admin')

    // with a second administrator there is a way back in, so the first may leave
    const other = await core.signUp({ name: 'Second Admin' })
    await core.promoteToInstanceAdmin(other.id)
    const allowed = await call('POST', '/api/core/account/deletion', admin.token, {})
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(202)
  })

  it('counts only administrators who could actually sign in', async () => {
    const admin = await core.signUp({ name: 'Sole Working Admin' })
    const gone = await core.signUp({ name: 'Departed Admin' })
    // instance admin is instance-wide state and the test above left two behind
    await core.kernel.database.db.update(user).set({ instanceAdmin: false })
    await core.promoteToInstanceAdmin(admin.id)
    await core.promoteToInstanceAdmin(gone.id)
    // the colleague has already left: suspended, so they cannot administer anything
    await core.kernel.database.db
      .update(user)
      .set({ status: 'suspended', permissionVersion: sql`${user.permissionVersion} + 1` as never })
      .where(eq(user.id, gone.id))

    const refused = await call('POST', '/api/core/account/deletion', admin.token, {})
    expect(refused.status).toBe(409)
    expect(refused.body.reason).toBe('core.account.last_instance_admin')
  })
})
