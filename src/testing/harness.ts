/**
 * Integration harness for the core service.
 *
 * Every suite gets its own scratch database (created on the dev Postgres, migrated by the kernel and
 * dropped afterwards) so suites can run concurrently and repeatedly. The service is booted exactly the
 * way `main.ts` boots it — Better Auth, the core module, jobs and authz all real — but with NATS and
 * Valkey switched off so the process stays self-contained and no cached permission bleeds between runs.
 *
 * Procedures are exercised through an oRPC server-side client built from the module's own router, so
 * every test goes through the same middleware chain (`authed`, `workspaceScoped`, `requires`) the HTTP
 * server uses.
 */
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreContract, Principal } from '@kernhq/contracts'
import { ANONYMOUS } from '@kernhq/contracts'
import type { Kernel, RequestContext } from '@kernhq/kernel'
import { createScratchDatabase } from '@kernhq/testing'
import type { ContractRouterClient } from '@orpc/contract'
import { createRouterClient } from '@orpc/server'
import { config as loadDotenv } from 'dotenv'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import type { MailMessage } from '../auth/mail.js'
import { invitations, user } from '../modules/core/schema/index.js'
import { type CoreService, createCoreService } from '../service.js'

const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../../.env'), quiet: true })
loadDotenv({ path: resolve(here, '../../../../.env'), quiet: true })

/** Postgres instance the scratch databases are created on. */
export const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const TEST_SECRET = process.env.KERN_SECRET ?? 'kern-test-secret-value-at-least-32-chars'

export type CoreApi = ContractRouterClient<CoreContract>

export interface TestUser {
  id: string
  email: string
  name: string
  /** Better Auth session token; resolves to a principal through the real resolver */
  token: string
  api: CoreApi
  principal(): Promise<Principal>
}

export interface TestCore {
  service: CoreService
  kernel: Kernel
  databaseUrl: string
  /** client bound to a fixed principal (re-read `user.api` after permission changes) */
  api(principal: Principal): CoreApi
  /** client for an unauthenticated caller */
  anonymous: CoreApi
  /** client for a trusted service principal (`kernel.system`) */
  system: CoreApi
  /**
   * A client for another module this service hosts. Typed as `unknown` on purpose: core must not
   * depend on a feature module's contract types to be able to check that it is reachable.
   */
  moduleApi(moduleId: string, principal: Principal): unknown
  signUp(input?: {
    email?: string
    password?: string
    name?: string
    /** leave the address unconfirmed (default: verified, see the implementation) */
    verified?: boolean
  }): Promise<TestUser>
  /**
   * An account provisioned **out of band**, straight into the table, without going through Better
   * Auth's sign-up at all.
   *
   * This is the only way to have a first account on an instance whose sign-up is closed, which is
   * exactly what `bootstrap()` does with `KERN_ADMIN_EMAIL` on a real invite-only install. It
   * deliberately bypasses the sign-up gate, so it must never be used to assert that the gate lets
   * somebody *through* — that has to go through `signUp`, or the assertion proves nothing.
   *
   * There is no session behind it, so the returned user has no `token`; reach its API with `apiOf`.
   */
  signUpDirect(input?: { email?: string; name?: string }): Promise<{ id: string; email: string }>
  /** current principal of a signed-up user, re-read from the database */
  principalOf(userId: string): Promise<Principal>
  /** a fresh client for the user's *current* principal (after a role change) */
  apiOf(userId: string): Promise<CoreApi>
  promoteToInstanceAdmin(userId: string): Promise<void>
  /** every message the core mailer was asked to send since boot (Better Auth mail excluded) */
  mailbox: MailMessage[]
  /**
   * The secret token of an invitation. It is deliberately absent from the API response — only the
   * invitation email carries it — so tests read it the way the recipient's link would.
   */
  inviteToken(invitationId: string): Promise<string>
  /** open a pool on the scratch database as a role that cannot bypass row-level security */
  restrictedPool(): Promise<pg.Pool>
  stop(): Promise<void>
}

const unique = () => `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

export interface StartCoreOptions {
  /** extra environment overrides merged over the test defaults */
  env?: Record<string, string | undefined>
}

export async function startCore(opts: StartCoreOptions = {}): Promise<TestCore> {
  const scratch = await createScratchDatabase(BASE_DATABASE_URL, `kern_test_core_${unique()}`)
  const service = await createCoreService({
    role: 'api',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: scratch.url,
      DATABASE_POOL_MAX: '4',
      KERN_SECRET: TEST_SECRET,
      BETTER_AUTH_SECRET: TEST_SECRET,
      // self-contained: in-memory event bus, no shared permission cache, no outbound mail
      NATS_URL: undefined,
      VALKEY_URL: undefined,
      SMTP_URL: undefined,
      // Signing an upload or download URL is local arithmetic — it needs credentials but reaches no
      // server — so the file procedures are covered without object storage running. Nothing here
      // transfers bytes; a test that does will need a real MinIO.
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      S3_REGION: process.env.S3_REGION ?? 'us-east-1',
      S3_BUCKET: process.env.S3_BUCKET ?? 'kern-test',
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'kern-test-access-key',
      S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'kern-test-secret-key',
      KERN_ADMIN_EMAIL: undefined,
      KERN_ADMIN_PASSWORD: undefined,
      ...opts.env,
    },
  })

  const kernel = service.kernel
  const mod = kernel.registry.get('core')
  if (!mod?.router) throw new Error('core module did not expose a router')
  const router = mod.router(kernel)

  /** A client for any module this service hosts, so a suite can check one is really reachable. */
  const moduleClientFor = (moduleId: string, principal: Principal): unknown => {
    const hosted = kernel.registry.get(moduleId)
    if (!hosted?.router) throw new Error(`${moduleId} is not hosted by this service`)
    return createRouterClient(hosted.router(kernel), {
      context: (): RequestContext => ({
        kernel,
        principal,
        requestId: `test-${randomBytes(4).toString('hex')}`,
        ip: '127.0.0.1',
        headers: {},
      }),
    })
  }

  const clientFor = (principal: Principal): CoreApi =>
    createRouterClient(router, {
      context: (): RequestContext => ({
        kernel,
        principal,
        requestId: `test-${randomBytes(4).toString('hex')}`,
        ip: '127.0.0.1',
        headers: {},
      }),
    }) as unknown as CoreApi

  const principalOf = (userId: string) => service.deps.principals.fromUserId(userId)
  const restricted: pg.Pool[] = []
  let restrictedRole: string | null = null

  // Capture outbound mail instead of dropping it on the floor, so suites can assert that an
  // invitation/digest actually left the building. Better Auth captured the original mailer at
  // construction time, so its account mail is unaffected.
  const mailbox: MailMessage[] = []
  const realMailer = service.deps.mailer
  service.deps.mailer = {
    async send(msg) {
      mailbox.push(msg)
      await realMailer.send(msg)
    },
  }

  return {
    mailbox,
    async inviteToken(invitationId) {
      const [row] = await kernel.database.db
        .select({ token: invitations.token })
        .from(invitations)
        .where(eq(invitations.id, invitationId))
        .limit(1)
      if (!row) throw new Error(`invitation ${invitationId} not found`)
      return row.token
    },
    service,
    kernel,
    databaseUrl: scratch.url,
    api: clientFor,
    moduleApi: moduleClientFor,
    anonymous: clientFor(ANONYMOUS),
    system: clientFor(kernel.system),
    principalOf,
    async apiOf(userId) {
      return clientFor(await principalOf(userId))
    },
    async signUp(input = {}) {
      const email = (input.email ?? `user_${unique()}@example.test`).toLowerCase()
      const name = input.name ?? email.split('@')[0]!
      const password = input.password ?? 'correct-horse-battery-staple'
      const res = await service.deps.auth.api.signUpEmail({ body: { email, password, name } })
      const id = res.user.id
      const token = res.token ?? ''
      if (!token) throw new Error(`sign-up for ${email} returned no session token`)
      // Verified by default, because that is the state a real person is in by the time they do
      // anything: `emailVerification.sendOnSignUp` mails the link and `workspaces.create` requires
      // it. A suite that is *about* the unverified state passes `verified: false` and asserts on it.
      if (input.verified !== false)
        await kernel.database.db
          .update(user)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(eq(user.id, id))
      return {
        id,
        email,
        name,
        token,
        api: clientFor(await principalOf(id)),
        principal: () => principalOf(id),
      }
    },
    async signUpDirect(input = {}) {
      const email = (input.email ?? `direct_${unique()}@example.test`).toLowerCase()
      const [row] = await kernel.database.db
        .insert(user)
        .values({
          email,
          name: input.name ?? email.split('@')[0]!,
          // Provisioned by the operator, so the address is as proven as the operator's own list.
          emailVerified: true,
        })
        .returning({ id: user.id })
      if (!row) throw new Error(`could not provision ${email}`)
      return { id: row.id, email }
    },
    async promoteToInstanceAdmin(userId) {
      await kernel.database.db
        .update(user)
        .set({ instanceAdmin: true, role: 'admin', updatedAt: new Date() })
        .where(eq(user.id, userId))
      service.deps.principals.invalidate([userId])
    },
    async restrictedPool() {
      if (!restrictedRole) {
        restrictedRole = `kern_rls_${unique()}`
        const admin = new pg.Client({ connectionString: scratch.url })
        await admin.connect()
        await admin.query(`create role "${restrictedRole}" login password 'rls' nosuperuser nobypassrls`)
        await admin.query(`grant usage on schema mod_core to "${restrictedRole}"`)
        await admin.query(
          `grant select, insert, update, delete on all tables in schema mod_core to "${restrictedRole}"`,
        )
        await admin.end()
      }
      const url = new URL(scratch.url)
      url.username = restrictedRole
      url.password = 'rls'
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2 })
      restricted.push(pool)
      return pool
    },
    async stop() {
      for (const pool of restricted) await pool.end().catch(() => {})
      await service.stop()
      await scratch.drop()
      if (restrictedRole) {
        const admin = new pg.Client({ connectionString: BASE_DATABASE_URL })
        await admin.connect()
        await admin.query(`drop role if exists "${restrictedRole}"`).catch(() => {})
        await admin.end()
      }
    },
  }
}

/** Error code of anything the stack can throw: `KernError.code` or an oRPC error `code`. */
export function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown }
  if (typeof e?.code === 'string') return e.code
  return String(e?.name ?? e?.message ?? err)
}

/** Assert that `fn` rejects with the given error code, and return the error for further assertions. */
export async function expectRejection(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    if (errorCode(err) !== code)
      throw new Error(`expected error code ${code}, got ${errorCode(err)}: ${String(err)}`)
    return err
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`)
}

/** True when `fn` resolves; false when it rejects with a permission-style error (re-throws anything else). */
export async function allowed(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (err) {
    const code = errorCode(err)
    if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return false
    throw err
  }
}
