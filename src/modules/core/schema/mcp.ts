/**
 * Model Context Protocol tables in `mod_core`.
 *
 * Global, not row-level-secured — like the Better Auth tables and `files`, these are keyed by user
 * or client rather than by workspace alone (a token belongs to one workspace, but an OAuth client
 * may be used from several). Access is decided in code: consent rows and tokens only ever act for
 * their own user.
 */
import { sql } from 'drizzle-orm'
import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// drizzle-kit loads this file directly; re-declare rather than import from base.ts
export const coreMcpSchema = pgSchema('mod_core')

/** An OAuth client that asked to connect — created by dynamic client registration. */
export const mcpClients = coreMcpSchema.table(
  'mcp_clients',
  {
    clientId: text('client_id').primaryKey(),
    /** null for public clients (PKCE-only): AI clients on a phone or desktop hold no secret */
    secretHash: text('secret_hash'),
    name: text('name').notNull(),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    redirectUris: text('redirect_uris').array().notNull().default(sql`'{}'::text[]`),
    firstParty: boolean('first_party').notNull().default(false),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('mcp_clients_created_by_idx').on(t.createdBy)],
)

/**
 * An authorization request waiting for its user to click allow or deny in the app. Carries the
 * whole original query so the consent screen needs none of the OAuth machinery.
 */
export const mcpAuthRequests = coreMcpSchema.table(
  'mcp_auth_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scope: text('scope'),
    state: text('state').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('mcp_auth_requests_user_idx').on(t.userId)],
)

/** A user said yes: this client may have tokens for me in this workspace with these scopes. */
export const mcpConsents = coreMcpSchema.table(
  'mcp_consents',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    clientId: text('client_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // one row per (user, client, workspace); scopes widen by rewriting it
    uniqueIndex('mcp_consents_uq').on(t.userId, t.clientId, t.workspaceId),
  ],
)

/** Authorization codes: single-use, ten minutes, stored hashed like everything secret. */
export const mcpCodes = coreMcpSchema.table(
  'mcp_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    codeHash: text('code_hash').notNull().unique(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('mcp_codes_user_idx').on(t.userId)],
)

/** Access and refresh tokens. The raw value exists only in the response that created it. */
export const mcpTokens = coreMcpSchema.table(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    kind: text('kind').notNull(), // access | refresh
    tokenHash: text('token_hash').notNull().unique(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mcp_tokens_user_idx').on(t.userId),
    index('mcp_tokens_workspace_idx').on(t.workspaceId),
    index('mcp_tokens_client_idx').on(t.clientId),
  ],
)
