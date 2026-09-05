import { apiKey } from '@better-auth/api-key'
import { passkey } from '@better-auth/passkey'
import { sso } from '@better-auth/sso'
import { coreEvents } from '@kernhq/contracts/core'
import { type Kernel, uuidv7 } from '@kernhq/kernel'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { admin, bearer, jwt, magicLink, multiSession, twoFactor } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import type { CoreEnv } from '../env.js'
import { authSchema, user as userTable } from '../modules/core/schema/auth.js'
import { composeEmail, type EmailLocale, emailCopy, emailLocale } from './emails.js'
import { type Mailer, type MailMessage, MailNotConfiguredError } from './mail.js'
import { mayCreateAccount, SIGNUP_CLOSED } from './signup.js'

export interface AuthDeps {
  kernel: Kernel
  env: CoreEnv
  mailer: Mailer
}

export const AUTH_BASE_PATH = '/api/auth'

/** How long a sign-in link lives. The email says so, so the two read the same number. */
export const MAGIC_LINK_EXPIRY_SECONDS = 60 * 5

/** Origins browsers may call auth from (app dev server, Caddy domain, extra CORS origins). */
export function trustedOrigins(kernel: Kernel, env: CoreEnv): string[] {
  const set = new Set<string>([kernel.env.KERN_BASE_URL])
  for (const o of (kernel.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    set.add(o)
  if (env.BETTER_AUTH_URL) set.add(env.BETTER_AUTH_URL)
  set.add(kernel.env.CORE_URL)
  return [...set]
}

/**
 * Proxies whose `X-Forwarded-For` entries Better Auth may believe, by default.
 *
 * The same set the shipped `Caddyfile` trusts (`trusted_proxies static private_ranges`), because
 * the two answer the same question one hop apart and a client IP that Caddy preserves and core then
 * discards is worse than either alone. Better Auth walks the header from the right and stops at the
 * first hop it does not trust, so every proxy between the client and this process has to be in
 * here: with none of them, a chain of more than one entry resolves to *no* IP at all and the
 * per-IP limiter collapses into one instance-wide bucket — 3 sign-ins per 10 seconds for everybody
 * at once, which is how ordinary people are refused sign-in because somebody else signed in.
 *
 * A public proxy in front (Cloudflare, a cloud load balancer) is not private and has to be named in
 * `KERN_TRUSTED_PROXIES`, or everyone behind that proxy shares one bucket.
 */
export const PRIVATE_PROXY_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '::1/128',
  'fd00::/8',
] as const

/** The private ranges plus whatever `KERN_TRUSTED_PROXIES` adds. */
export function trustedProxies(env: CoreEnv): string[] {
  const extra = (env.KERN_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([...PRIVATE_PROXY_RANGES, ...extra])]
}

/**
 * What Kern allows per client IP, rather than what Better Auth defaults to.
 *
 * Better Auth's built-in rule for sign-in, sign-up and password change is 3 requests per 10
 * seconds, which is tight enough that one person mistyping a password three times is locked out of
 * their own instance for the rest of the window. These are Kern's numbers: generous enough for a
 * person, far too tight for credential stuffing, and tightest on the endpoints that *send mail*,
 * because those spend somebody's sending reputation as well as their CPU.
 *
 * Order matters: Better Auth takes the *first* key that matches, so an exact path has to sit above
 * the wildcard that would also cover it.
 */
export const RATE_LIMIT = {
  window: 60,
  max: 120,
  rules: {
    // sends mail — kept at the same rate whichever door it is asked through
    '/sign-in/magic-link': { window: 60, max: 5 },
    '/request-password-reset': { window: 60, max: 5 },
    '/send-verification-email': { window: 60, max: 5 },
    '/forget-password/*': { window: 60, max: 5 },
    '/magic-link/*': { window: 60, max: 5 },
    // guesses a secret
    '/sign-in/*': { window: 60, max: 10 },
    '/sign-up/*': { window: 60, max: 5 },
    '/change-password': { window: 60, max: 10 },
    '/change-email': { window: 60, max: 10 },
    '/two-factor/*': { window: 60, max: 10 },
  },
} as const

export function createAuth({ kernel, env, mailer }: AuthDeps) {
  const baseURL = env.BETTER_AUTH_URL ?? kernel.env.CORE_URL
  const appUrl = kernel.env.KERN_BASE_URL
  const rpID = env.PASSKEY_RP_ID ?? new URL(appUrl).hostname
  const isProd = env.NODE_ENV === 'production'

  const socialProviders: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {}
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    socialProviders.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
    socialProviders.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET)
    socialProviders.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenantId: env.MICROSOFT_TENANT_ID ?? 'common',
    }

  const fallbackLocale = emailLocale(env.KERN_DEFAULT_LOCALE)
  /**
   * The locale on a Better Auth user row.
   *
   * `locale` is one of our `additionalFields`, so it is on the row the hook is handed at runtime
   * and absent from Better Auth's own `User` type — the same reason `definePayload` below casts.
   */
  const localeOf = (u: unknown): EmailLocale =>
    emailLocale((u as { locale?: string | null } | null)?.locale, fallbackLocale)
  /**
   * A magic link is asked for by address, not by session, so the recipient's language has to be
   * looked up. An address nobody has signed up with gets the instance default — which is also the
   * only honest answer, since there is no person to have a preference yet.
   */
  const localeOfEmail = async (email: string): Promise<EmailLocale> => {
    try {
      const [row] = await kernel.database.db
        .select({ locale: userTable.locale })
        .from(userTable)
        .where(eq(userTable.email, email.trim().toLowerCase()))
        .limit(1)
      return emailLocale(row?.locale, fallbackLocale)
    } catch (err) {
      kernel.log.warn({ err: (err as Error).message }, 'could not read the recipient locale')
      return fallbackLocale
    }
  }
  /**
   * Sends, and turns "this instance cannot send mail at all" into an answer the browser can show.
   *
   * Without this the request either succeeds (the old log-and-return mailer) or fails as a bare
   * 500; both leave the person staring at "Check your inbox" for a message that does not exist.
   */
  const sendAuthMail = async (msg: MailMessage): Promise<void> => {
    try {
      await mailer.send(msg)
    } catch (err) {
      if (err instanceof MailNotConfiguredError)
        throw new APIError('SERVICE_UNAVAILABLE', {
          message:
            'This instance cannot send email yet, so the link could not be delivered. Ask an administrator to configure outbound mail.',
          code: 'MAIL_NOT_CONFIGURED',
        })
      throw err
    }
  }

  const auth = betterAuth({
    appName: 'Kern',
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET ?? kernel.env.KERN_SECRET,
    trustedOrigins: trustedOrigins(kernel, env),
    database: drizzleAdapter(kernel.database.db, { provider: 'pg', schema: authSchema }),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: 'kern',
      useSecureCookies: isProd && appUrl.startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax' },
      // Without this, `X-Forwarded-For: <client>, <caddy>` resolves to no IP at all (Better Auth
      // refuses to believe a multi-entry header from an unnamed proxy, which is right), and every
      // request on the instance shares one rate-limit bucket. See `PRIVATE_PROXY_RANGES`.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: trustedProxies(env) },
    },
    /**
     * On everywhere but a developer's machine.
     *
     * Better Auth enables this in production only; an instance running with `NODE_ENV=test`, and
     * this repository's own suite, would otherwise have no limiter to prove anything about. The
     * numbers are Kern's (see `RATE_LIMIT`) rather than the library's defaults, and the store is
     * per process: two replicas mean two buckets, which is a weaker limit than it looks and still
     * the right trade against a shared store on the sign-in path.
     */
    rateLimit: {
      enabled: env.NODE_ENV !== 'development',
      window: RATE_LIMIT.window,
      max: RATE_LIMIT.max,
      storage: 'memory',
      customRules: { ...RATE_LIMIT.rules },
    },
    user: {
      additionalFields: {
        username: { type: 'string', required: false, input: true },
        locale: { type: 'string', required: false, defaultValue: 'en', input: true },
        timezone: { type: 'string', required: false, defaultValue: 'UTC', input: true },
        instanceAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
        status: { type: 'string', required: false, defaultValue: 'active', input: false },
        permissionVersion: { type: 'number', required: false, defaultValue: 0, input: false },
      },
      /**
       * The one place `allowSignup` is enforced, and it covers every sign-up path there is.
       *
       * Better Auth runs this immediately before `create-user` for every authentication method,
       * because all of them provision through `internalAdapter.createUser` — email+password, social
       * OAuth, magic link, SSO (OIDC and SAML), email OTP, SIWE, phone number and the admin plugin.
       * Passkeys cannot create an account at all (the plugin registers a credential against a
       * session that already exists), so they are covered by the account having been gated already.
       *
       * `link-account` and `sign-in` are deliberately let through: an existing account adding a
       * second provider, or signing in with one, is not a sign-up, and refusing it would lock people
       * out of accounts they already have the moment an administrator closes registration.
       *
       * Better Auth treats a throw here as a refusal, so a database that cannot answer closes
       * sign-up rather than opening it. That is the right direction for a gate.
       */
      validateUserInfo: async ({ user: candidate, source }) => {
        if (source.action !== 'create-user') return
        const verdict = await mayCreateAccount(
          kernel,
          env,
          String(candidate.email ?? ''),
          source.method ?? 'unknown',
        )
        if (verdict.ok) return
        kernel.log.warn(
          { method: source.method, reason: verdict.code },
          'sign-up refused: this instance is invite-only',
        )
        return { error: verdict.code ?? SIGNUP_CLOSED, errorDescription: verdict.message }
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // no cookie cache: permission/admin changes must be visible on the next request
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      async sendResetPassword({ user, url }) {
        const locale = localeOf(user)
        await sendAuthMail({
          to: user.email,
          ...composeEmail(locale, emailCopy(locale).resetPassword({ name: user.name }), url),
        })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        const locale = localeOf(user)
        await sendAuthMail({
          to: user.email,
          ...composeEmail(locale, emailCopy(locale).verifyEmail({ name: user.name }), url),
        })
      },
    },
    socialProviders,
    hooks: {
      /**
       * Registering an identity provider is a plan feature on instances that sell one.
       *
       * It has to be caught here rather than in a Kern procedure, because the endpoint belongs to
       * Better Auth and never passes through the module router. `organizationId` is the workspace —
       * without one there is nothing to check a plan against, so the request is refused rather than
       * quietly treated as unlimited.
       */
      before: createAuthMiddleware(async (ctx) => {
        /**
         * Impersonation is off, and the endpoint says so rather than 404ing.
         *
         * The admin plugin ships `/admin/impersonate-user`, the session table carries
         * `impersonated_by`, and the docs promised "impersonate for support (audited)" — while
         * nothing in the product started an impersonation, ended one, displayed one, or wrote a
         * record of one. An unaudited way to become any customer, reachable by every instance
         * admin, is not a support tool; on Kern Cloud it is the difference between an operator and
         * somebody reading a company's private chat. Until there is recorded consent from the
         * account being impersonated, the honest state is closed.
         *
         * Reading a workspace as an admin is still possible and is what `core.access.crossed`
         * audits (see `services/access.ts`); that leaves a trace the customer can see, which this
         * never did.
         */
        if (
          ctx.path.startsWith('/admin/impersonate-user') ||
          ctx.path.startsWith('/admin/stop-impersonating')
        )
          throw new APIError('FORBIDDEN', {
            message:
              'Impersonation is disabled on this instance. Administrator access to a workspace is recorded in that workspace’s audit log instead.',
            code: 'IMPERSONATION_DISABLED',
          })
        if (!ctx.path.startsWith('/sso/register')) return
        const workspaceId = (ctx.body as { organizationId?: string } | undefined)?.organizationId
        if (!workspaceId)
          throw new APIError('BAD_REQUEST', {
            message: 'organizationId is required: an identity provider belongs to a workspace',
          })
        if (!(await kernel.entitlements.has(workspaceId, 'sso'))) {
          const { planName } = await kernel.entitlements.of(workspaceId)
          throw new APIError('FORBIDDEN', {
            message: planName
              ? `Single sign-on is not included in the ${planName} plan`
              : 'Single sign-on is not included in this workspace plan',
            code: 'BILLING_SSO_NOT_INCLUDED',
          })
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await kernel.emit(
              coreEvents.userCreated,
              { userId: user.id as never, email: user.email },
              { actorId: user.id },
            )
          },
        },
      },
    },
    plugins: [
      magicLink({
        async sendMagicLink({ email, url }) {
          const locale = await localeOfEmail(email)
          await sendAuthMail({
            to: email,
            ...composeEmail(
              locale,
              emailCopy(locale).magicLink({ minutes: MAGIC_LINK_EXPIRY_SECONDS / 60 }),
              url,
            ),
          })
        },
        expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
      }),
      twoFactor({ issuer: 'Kern' }),
      passkey({ rpID, rpName: 'Kern', origin: new URL(appUrl).origin }),
      bearer(),
      jwt({
        jwt: {
          issuer: baseURL,
          audience: 'kern',
          expirationTime: '15m',
          definePayload: ({ user, session }) => {
            const u = user as typeof user & {
              instanceAdmin?: boolean
              permissionVersion?: number
              locale?: string
            }
            return {
              email: user.email,
              name: user.name,
              adm: Boolean(u.instanceAdmin),
              pv: Number(u.permissionVersion ?? 0),
              sid: session.id,
              locale: u.locale ?? 'en',
            }
          },
        },
      }),
      multiSession({ maximumSessions: 10 }),
      // `enableMetadata` is what lets a key carry the workspace and scope it was created for —
      // without it `createApiKey` refuses any `metadata` at all, and there would be nowhere honest
      // to put either.
      apiKey({ enableSessionForAPIKeys: true, apiKeyHeaders: ['x-api-key'], enableMetadata: true }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      // SSO (OIDC/SAML) per workspace: providers are registered through Better Auth's /sso/register
      // endpoint. The `before` hook above refuses registration when the workspace's plan does not
      // include SSO.
      // TODO: also gate registration on `core.workspace.manage` of the target workspace — the plan
      // check is not a permission check, and today any member of an entitled workspace can register.
      sso(),
    ],
  })
  return auth
}
export type Auth = ReturnType<typeof createAuth>
