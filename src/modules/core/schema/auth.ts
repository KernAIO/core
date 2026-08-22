/**
 * Better Auth tables (generated with `@better-auth/cli generate` for the configured plugin set, then moved into
 * the `mod_core` schema with uuid ids and snake_case columns). The `user` table doubles as Kern's users table.
 * Keep the JS property names in sync with Better Auth field names – the Drizzle adapter looks columns up by key.
 */
import { relations, sql } from 'drizzle-orm'
import { boolean, index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { coreSchema } from './base.js'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const user = coreSchema.table(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    /** Better Auth calls it `image`; exposed as `avatarUrl` */
    image: text('avatar_url'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    // --- Kern additional fields ---
    username: text('username').unique(),
    locale: text('locale').default('en').notNull(),
    timezone: text('timezone').default('UTC').notNull(),
    instanceAdmin: boolean('instance_admin').default(false).notNull(),
    status: text('status').default('active').notNull(),
    /** bumped whenever any membership/role/group of this user changes */
    permissionVersion: integer('permission_version').default(0).notNull(),
    // --- plugin fields ---
    twoFactorEnabled: boolean('two_factor_enabled').default(false),
    role: text('role'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: ts('ban_expires'),
  },
  (t) => [index('users_status_idx').on(t.status), index('users_name_idx').on(t.name)],
)

export const session = coreSchema.table(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const account = coreSchema.table(
  'accounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    /** OIDC issuer of the identity provider (set by the SSO/OAuth flows) */
    issuer: text('issuer'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    index('accounts_provider_idx').on(t.providerId, t.accountId),
  ],
)

export const verification = coreSchema.table(
  'verifications',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
)

export const twoFactor = coreSchema.table(
  'two_factors',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: ts('locked_until'),
  },
  (t) => [index('two_factors_user_idx').on(t.userId)],
)

export const passkey = coreSchema.table(
  'passkeys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: ts('created_at'),
    aaguid: text('aaguid'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId), index('passkeys_credential_idx').on(t.credentialID)],
)

export const jwks = coreSchema.table('jwks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at'),
  alg: text('alg'),
  crv: text('crv'),
})

export const apikey = coreSchema.table(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: ts('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: ts('last_request'),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('api_keys_config_idx').on(t.configId),
    index('api_keys_reference_idx').on(t.referenceId),
    index('api_keys_key_idx').on(t.key),
  ],
)

export const ssoProvider = coreSchema.table('sso_providers', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  issuer: text('issuer').notNull(),
  oidcConfig: text('oidc_config'),
  samlConfig: text('saml_config'),
  userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull().unique(),
  organizationId: text('organization_id'),
  domain: text('domain').notNull(),
})

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  twoFactors: many(twoFactor),
  passkeys: many(passkey),
  ssoProviders: many(ssoProvider),
}))
export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}))
export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}))
export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
  user: one(user, { fields: [twoFactor.userId], references: [user.id] }),
}))
export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, { fields: [passkey.userId], references: [user.id] }),
}))
export const ssoProviderRelations = relations(ssoProvider, ({ one }) => ({
  user: one(user, { fields: [ssoProvider.userId], references: [user.id] }),
}))

/** Passed to the Better Auth drizzle adapter (`schema` option); keys are Better Auth model names. */
export const authSchema = {
  user,
  session,
  account,
  verification,
  twoFactor,
  passkey,
  jwks,
  apikey,
  ssoProvider,
}
