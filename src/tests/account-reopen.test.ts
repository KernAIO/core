import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '../modules/core/schema/index.js'
import { startCore, type TestCore } from '../testing/harness.js'

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

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | null,
  payload?: object,
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON body from a raw route
): Promise<{ status: number; body: any }> {
  const res = await core.service.app!.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
  })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

/** Sign in again, the way somebody who changed their mind would. */
async function signInAgain(email: string): Promise<string | null> {
  const res = await core.service.deps.auth.api
    .signInEmail({ body: { email, password: PASSWORD } })
    .catch(() => null)
  return res?.token ?? null
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
