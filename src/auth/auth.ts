import { apiKey } from '@better-auth/api-key'
import { passkey } from '@better-auth/passkey'
import { sso } from '@better-auth/sso'
import { coreEvents } from '@kernalo/contracts/core'
import { type Kernel, uuidv7 } from '@kernalo/kernel'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer, jwt, magicLink, multiSession, twoFactor } from 'better-auth/plugins'
import type { CoreEnv } from '../env.js'
import { authSchema } from '../modules/core/schema/auth.js'
import { type Mailer, renderEmail } from './mail.js'

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
      apiKey({ enableSessionForAPIKeys: true, apiKeyHeaders: ['x-api-key'] }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      // SSO (OIDC/SAML) per workspace: providers are registered through Better Auth's /sso/register endpoint.
      // TODO: gate registration on `core.workspace.manage` of the target workspace (organizationId = workspaceId).
      sso(),
    ],
  })
  return auth
}
export type Auth = ReturnType<typeof createAuth>
