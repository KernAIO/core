import { apiKey } from '@better-auth/api-key'
import { passkey } from '@better-auth/passkey'
import { sso } from '@better-auth/sso'
import { coreEvents } from '@kernhq/contracts/core'
import { type Kernel, uuidv7 } from '@kernhq/kernel'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { admin, bearer, jwt, magicLink, multiSession, twoFactor } from 'better-auth/plugins'
import type { CoreEnv } from '../env.js'
import { authSchema } from '../modules/core/schema/auth.js'
import { type Mailer, renderEmail } from './mail.js'
import { mayCreateAccount, SIGNUP_CLOSED } from './signup.js'

export interface AuthDeps {
  kernel: Kernel
  env: CoreEnv
  mailer: Mailer
}

export const AUTH_BASE_PATH = '/api/auth'

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
        const { html, text } = renderEmail({
          title: 'Reset your Kern password',
          intro: `Hi ${user.name}, click the button below to choose a new password. This link expires in one hour.`,
          actionUrl: url,
          actionLabel: 'Reset password',
        })
        await mailer.send({ to: user.email, subject: 'Reset your Kern password', text, html })
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        const { html, text } = renderEmail({
          title: 'Verify your email',
          intro: `Hi ${user.name}, please confirm your email address to finish setting up your Kern account.`,
          actionUrl: url,
          actionLabel: 'Verify email',
        })
        await mailer.send({ to: user.email, subject: 'Verify your Kern email', text, html })
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
          const { html, text } = renderEmail({
            title: 'Sign in to Kern',
            intro:
              'Click the button below to sign in. This link expires in 5 minutes and can only be used once.',
            actionUrl: url,
            actionLabel: 'Sign in',
          })
          await mailer.send({ to: email, subject: 'Your Kern sign-in link', text, html })
        },
        expiresIn: 60 * 5,
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
