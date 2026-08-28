/**
 * Who may become an account, and what an account may do before its address is proven.
 *
 * Both halves were open. `allowSignup` was declared in `@kernhq/contracts`, described in the
 * administration docs as "open sign-up vs invite-only", and read by nothing — an administrator could
 * switch it off and every path still worked. And `workspaces.create` asked nothing about the email
 * address, so on an instance with open sign-up any string with an `@` in it got a tenant instantly.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mayCreateAccount } from '../auth/signup.js'
import { invitations, user } from '../modules/core/schema/index.js'
import { expectRejection, startCore, type TestCore } from '../testing/harness.js'

const slug = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const address = () => `${slug('who')}@example.test`
const PASSWORD = 'correct-horse-battery-staple'

describe('when sign-up is open', () => {
  let core: TestCore
  beforeAll(async () => {
    core = await startCore({ env: { KERN_SIGNUP: 'open' } })
  }, 180_000)
  afterAll(async () => core?.stop())

  it('seeds allowSignup from KERN_SIGNUP on the first boot', async () => {
    const admin = await core.signUp({ name: 'Admin' })
    await core.promoteToInstanceAdmin(admin.id)
    const api = await core.apiOf(admin.id)
    expect((await api.admin.settings()).allowSignup).toBe(true)
  })

  it('lets a stranger sign up', async () => {
    const stranger = await core.signUp({ name: 'Stranger' })
    expect(stranger.id).toBeTruthy()
  })

  /**
   * The gate the whole feature exists for. Kern Cloud keeps sign-up open on purpose, so the thing
   * standing between an unverified address and a tenant has to be verification, not registration.
   */
  it('refuses a workspace to an address nobody has confirmed', async () => {
    const unverified = await core.signUp({ name: 'Unconfirmed', verified: false })
    await expectRejection(
      () => unverified.api.workspaces.create({ name: 'Ghost', slug: slug('ghost') }),
      'FORBIDDEN',
    )
  })

  it('allows the workspace once the address is confirmed', async () => {
    const person = await core.signUp({ name: 'Confirmed', verified: false })
    await core.kernel.database.db.update(user).set({ emailVerified: true }).where(eq(user.id, person.id))
    const api = await core.apiOf(person.id)
    expect((await api.workspaces.create({ name: 'Real', slug: slug('real') })).id).toBeTruthy()
  })

  /**
   * An invitation redeemed from the address it was mailed to *is* proof of that address — the token
   * only ever existed in that mailbox. Without this, an invited person would have to verify twice,
   * and the verification gate above would stand in front of the invited-user flow.
   */
  it('treats redeeming an emailed invitation as proof of the address', async () => {
    const owner = await core.signUp({ name: 'Owner' })
    const ws = await owner.api.workspaces.create({ name: 'Team', slug: slug('team') })
    // The client was bound to a principal that had no memberships yet; re-read it.
    const ownerApi = await core.apiOf(owner.id)
    const email = address()
    const [invite] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email, role: 'member' }],
    })
    const token = await core.inviteToken(invite!.id)

    const joiner = await core.signUp({ email, name: 'Joiner', verified: false })
    const before = await core.kernel.database.db
      .select({ verified: user.emailVerified })
      .from(user)
      .where(eq(user.id, joiner.id))
    expect(before[0]?.verified, 'the joiner should start unverified').toBe(false)

    await joiner.api.workspaces.invitations.accept({ token })
    const after = await core.kernel.database.db
      .select({ verified: user.emailVerified })
      .from(user)
      .where(eq(user.id, joiner.id))
    expect(after[0]?.verified, 'accepting the emailed invitation proves the address').toBe(true)

    // …and the whole point: they can now create a workspace of their own.
    const api = await core.apiOf(joiner.id)
    expect((await api.workspaces.create({ name: 'Mine', slug: slug('mine') })).id).toBeTruthy()
  })
})

describe('when sign-up is invite-only', () => {
  let core: TestCore
  const adminEmail = 'closed-admin@example.test'
  let adminId: string

  beforeAll(async () => {
    /*
     * Booted the way a self-hosted instance is: closed, with an administrator to bootstrap. That
     * bootstrap goes through `auth.api.signUpEmail` like any other sign-up, so this suite starting
     * at all is the proof that a closed instance can still create its own first account.
     */
    core = await startCore({
      env: { KERN_SIGNUP: 'invite', KERN_ADMIN_EMAIL: adminEmail, KERN_ADMIN_PASSWORD: PASSWORD },
    })
    const [admin] = await core.kernel.database.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, adminEmail))
      .limit(1)
    adminId = admin!.id
  }, 180_000)
  afterAll(async () => core?.stop())

  it('seeds allowSignup closed and still bootstraps its administrator', async () => {
    const api = await core.apiOf(adminId)
    expect((await api.admin.settings()).allowSignup).toBe(false)
    expect(adminId, 'the bootstrap admin must exist on a closed instance').toBeTruthy()
  })

  it('refuses a stranger signing up with email and password', async () => {
    const err = await core.service.deps.auth.api
      .signUpEmail({ body: { email: address(), password: PASSWORD, name: 'No' } })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err, 'sign-up should have been refused').toBeTruthy()
    expect(String((err as Error).message)).toMatch(/invite-only/i)
  })

  it('leaves no user row behind for a refused sign-up', async () => {
    const rows = await core.kernel.database.db.select({ id: user.id }).from(user)
    expect(rows.length, 'only the bootstrap administrator should exist').toBe(1)
  })

  /**
   * Every sign-up path, decided in one place.
   *
   * The seam is Better Auth's `user.validateUserInfo`, which runs immediately before `create-user`
   * for every authentication method — email+password, social OAuth, magic link, SSO (OIDC and SAML),
   * email OTP, SIWE and phone all provision through the same `internalAdapter.createUser`. Passkeys
   * cannot create an account at all: the plugin registers a credential against a session that
   * already exists. The integration cases above prove the seam is wired; this proves the decision
   * behind it does not depend on which method asked.
   */
  it('answers the same for every provisioning method', async () => {
    const { kernel, env } = { kernel: core.kernel, env: core.service.env }
    for (const method of ['email-password', 'oauth', 'magic-link', 'sso-oidc', 'sso-saml', 'email-otp']) {
      const verdict = await mayCreateAccount(kernel, env, address(), method)
      expect(verdict.ok, `${method} should be refused while sign-up is closed`).toBe(false)
      expect(verdict.code).toBe('signup_closed')
    }
    /*
     * `admin` is the deliberate exception: an instance administrator creating an account by hand is
     * the invite-only escape hatch, and that endpoint has its own admin check. This gate is about
     * strangers, not operators.
     */
    expect((await mayCreateAccount(kernel, env, address(), 'admin')).ok).toBe(true)
  })

  /**
   * The escape hatch that keeps invite-only from meaning "nobody, ever". A pending invitation is a
   * member of the instance asking for this person by name, and the invitee has no account yet — so
   * refusing them would break the flow the whole product is built around.
   */
  it('lets an invited address sign up, and only that address', async () => {
    const api = await core.apiOf(adminId)
    const ws = await api.workspaces.create({ name: 'Closed', slug: slug('closed') })
    const invited = address()
    await api.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email: invited, role: 'member' }],
    })
    const pending = await core.kernel.database.db
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.email, invited), eq(invitations.status, 'pending')))
    expect(pending.length, 'the invitation should be pending').toBe(1)

    const joiner = await core.signUp({ email: invited, name: 'Invited' })
    expect(joiner.id, 'an invited address may create its account').toBeTruthy()

    const stranger = await core.service.deps.auth.api
      .signUpEmail({ body: { email: address(), password: PASSWORD, name: 'No' } })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(stranger, 'an uninvited address is still refused').toBeTruthy()
  })
})

describe('impersonation', () => {
  let core: TestCore
  beforeAll(async () => {
    core = await startCore()
  }, 180_000)
  afterAll(async () => core?.stop())

  /**
   * Better Auth's admin plugin ships `/admin/impersonate-user`, the session table carries
   * `impersonated_by`, and the docs promised "impersonate for support (audited)" — while nothing
   * started, ended, displayed or recorded an impersonation anywhere in the product. An unaudited way
   * for any instance admin to become any customer is not a support tool.
   */
  it('is refused, with a reason rather than a 404', async () => {
    const admin = await core.signUp({ name: 'Operator' })
    await core.promoteToInstanceAdmin(admin.id)
    const victim = await core.signUp({ name: 'Customer' })
    const res = await core.service.app!.inject({
      method: 'POST',
      url: '/api/auth/admin/impersonate-user',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      payload: { userId: victim.id },
    })
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('IMPERSONATION_DISABLED')
  })
})
