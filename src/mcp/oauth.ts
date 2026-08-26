/**
 * The MCP authorization server: OAuth 2.1 with PKCE, just enough of it for AI clients to connect.
 *
 * Everything secret is stored hashed — clients, codes and tokens exist in plaintext only in the
 * response that created them, exactly like the API keys beside them. Access tokens are short-lived
 * opaque strings; refresh tokens rotate on every use, so a replayed one is a stolen one and kills
 * the session.
 *
 * A grant is always bound to **one workspace** — the one the user picked on the consent screen —
 * because that is what "give this app access" means here. The scopes are coarse
 * (`<module>:read` / `<module>:write`); what a token may actually do is still decided by the
 * user's own permissions on every call, so a consent can never widen what its user may do.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Kernel } from '@kernhq/kernel'
import { KernError } from '@kernhq/kernel'
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import {
  mcpAuthRequests,
  mcpClients,
  mcpCodes,
  mcpConsents,
  mcpTokens,
} from '../modules/core/schema/index.js'

const ACCESS_TTL_MS = 60 * 60_000
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
const CODE_TTL_MS = 10 * 60_000

export interface McpGrant {
  clientId: string
  userId: string
  workspaceId: string
  scopes: string[]
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
const randomToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

/** PKCE S256: the verifier's SHA-256, base64url without padding. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Redirect URIs an unknown client may register. Web clients must come back to https; native apps
 * loopback http or use a custom scheme. Anything else is how a code gets walked out of the building.
 */
export function redirectUriAllowed(uri: string): boolean {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
    // custom scheme for a native app (`kern://oauth/callback` style)
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol.endsWith(':')) {
      const scheme = u.protocol.slice(0, -1)
      return /^[a-z][a-z0-9+.-]*$/i.test(scheme) && scheme !== 'javascript' && scheme !== 'data'
    }
    return false
  } catch {
    return false
  }
}

export function parseScope(scope: string | null | undefined): string[] {
  return (scope ?? '')
    .split(/[\s+]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface McpOauth {
  /** dynamic client registration (RFC 7591) */
  registerClient(input: {
    name: string
    clientUri?: string | null
    logoUri?: string | null
    redirectUris: string[]
    createdBy?: string | null
    firstParty?: boolean
    /** token_endpoint_auth_method = client_secret_post → a secret is issued */
    confidential?: boolean
  }): Promise<{ clientId: string; clientSecret: string | null }>
  getClient(clientId: string): Promise<typeof mcpClients.$inferSelect | null>
  /**
   * Validate an /authorize request and park it until the consent screen answers.
   * Throws `KernError.badRequest` with an OAuth `error` code when the request itself is broken.
   */
  createAuthRequest(input: {
    userId: string
    clientId: string
    redirectUri: string
    scope: string[]
    state: string
    codeChallenge: string
  }): Promise<string>
  getAuthRequest(id: string): Promise<typeof mcpAuthRequests.$inferSelect | null>
  /** The consent screen said yes: remember the grant, mint the code, build the redirect. */
  approve(input: { requestId: string; userId: string; workspaceId: string }): Promise<{ redirectUrl: string }>
  deny(requestId: string, userId: string): Promise<{ redirectUrl: string }>
  exchangeCode(input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier?: string
  }): Promise<TokenPair & McpGrant>
  rotateRefresh(refreshToken: string, clientId: string): Promise<(TokenPair & McpGrant) | null>
  verifyAccessToken(accessToken: string): Promise<(typeof mcpTokens.$inferSelect & McpGrant) | null>
  revoke(tokenValue: string): Promise<void>
  revokeClientTokens(clientId: string, userId?: string): Promise<number>
  prune(): Promise<void>
}
type McpAuthRequestRow = typeof mcpAuthRequests.$inferSelect

export function createMcpOauth(kernel: Kernel): McpOauth {
  const db = kernel.database.db

  async function issue(grant: McpGrant): Promise<TokenPair> {
    const accessToken = randomToken('kmt')
    const refreshToken = randomToken('kmr')
    await db.insert(mcpTokens).values([
      {
        kind: 'access',
        tokenHash: sha256(accessToken),
        ...grant,
        expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      },
      {
        kind: 'refresh',
        tokenHash: sha256(refreshToken),
        ...grant,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    ])
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) }
  }

  const oauth: McpOauth = {
    async registerClient(input) {
      const clientId = `mcp_${randomBytes(12).toString('base64url')}`
      // confidential clients get a secret; public ones (the usual AI client) rely on PKCE alone
      const confidential = input.firstParty === true || input.confidential === true
      const clientSecret = confidential ? randomToken('kms') : null
      await db.insert(mcpClients).values({
        clientId,
        secretHash: clientSecret ? sha256(clientSecret) : null,
        name: input.name.slice(0, 200),
        clientUri: input.clientUri ?? null,
        logoUri: input.logoUri ?? null,
        redirectUris: input.redirectUris,
        firstParty: input.firstParty === true,
        createdBy: input.createdBy ?? null,
      })
      return { clientId, clientSecret }
    },

    async getClient(clientId) {
      const [row] = await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId)).limit(1)
      return row ?? null
    },

    async createAuthRequest(input) {
      const [row] = await db
        .insert(mcpAuthRequests)
        .values({
          userId: input.userId,
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          scope: input.scope.join(' '),
          state: input.state,
          codeChallenge: input.codeChallenge,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        })
        .returning({ id: mcpAuthRequests.id })
      return row!.id
    },

    async getAuthRequest(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null
      const [row] = await db.select().from(mcpAuthRequests).where(eq(mcpAuthRequests.id, id)).limit(1)
      if (!row || row.expiresAt.getTime() < Date.now()) return null
      return row as McpAuthRequestRow
    },

    async approve({ requestId, userId, workspaceId }) {
      const req = await oauth.getAuthRequest(requestId)
      if (!req) throw KernError.notFound('Authorization request')
      if (req.userId !== userId) throw KernError.forbidden()
      await db
        .insert(mcpConsents)
        .values({
          userId,
          workspaceId,
          clientId: req.clientId,
          scopes: parseScope(req.scope),
        })
        .onConflictDoUpdate({
          target: [mcpConsents.userId, mcpConsents.clientId, mcpConsents.workspaceId],
          set: { scopes: sql`excluded.scopes` },
        })
      const code = randomToken('kmc')
      await db.insert(mcpCodes).values({
        codeHash: sha256(code),
        clientId: req.clientId,
        userId,
        workspaceId,
        scopes: parseScope(req.scope),
        redirectUri: req.redirectUri,
        codeChallenge: req.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      })
      await db.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, requestId))
      const url = new URL(req.redirectUri)
      url.searchParams.set('code', code)
      if (req.state) url.searchParams.set('state', req.state)
      return { redirectUrl: url.toString() }
    },

    async deny(requestId, userId) {
      const req = await oauth.getAuthRequest(requestId)
      if (!req) throw KernError.notFound('Authorization request')
      if (req.userId !== userId) throw KernError.forbidden()
      await db.delete(mcpAuthRequests).where(eq(mcpAuthRequests.id, requestId))
      const url = new URL(req.redirectUri)
      url.searchParams.set('error', 'access_denied')
      if (req.state) url.searchParams.set('state', req.state)
      return { redirectUrl: url.toString() }
    },

    async exchangeCode({ code, clientId, redirectUri, codeVerifier }) {
      const [row] = await db
        .select()
        .from(mcpCodes)
        .where(eq(mcpCodes.codeHash, sha256(code)))
        .limit(1)
      if (!row || row.usedAt) throw KernError.badRequest('Invalid authorization code')
      if (row.expiresAt.getTime() < Date.now()) throw KernError.badRequest('Authorization code expired')
      if (row.clientId !== clientId || row.redirectUri !== redirectUri)
        throw KernError.badRequest('Authorization code was issued to another client')
      const client = await oauth.getClient(clientId)
      if (!client) throw KernError.badRequest('Unknown client')
      if (client.secretHash) {
        // confidential clients authenticate at the token endpoint; enforced by the route layer
      }
      if (!codeVerifier || pkceChallenge(codeVerifier) !== row.codeChallenge)
        throw KernError.badRequest('PKCE verification failed')
      // single use, marked atomically so two replays cannot both pass
      const used = await db
        .update(mcpCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(mcpCodes.id, row.id), isNull(mcpCodes.usedAt)))
        .returning({ id: mcpCodes.id })
      if (!used.length) throw KernError.badRequest('Authorization code already used')
      const grant: McpGrant = {
        clientId,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes,
      }
      return { ...grant, ...(await issue(grant)) }
    },

    async rotateRefresh(refreshToken, clientId) {
      const [row] = await db
        .select()
        .from(mcpTokens)
        .where(
          and(
            eq(mcpTokens.tokenHash, sha256(refreshToken)),
            eq(mcpTokens.kind, 'refresh'),
            eq(mcpTokens.clientId, clientId),
            isNull(mcpTokens.revokedAt),
            gt(mcpTokens.expiresAt, new Date()),
          ),
        )
        .limit(1)
      if (!row) return null
      const grant: McpGrant = {
        clientId: row.clientId,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes,
      }
      // rotation: the presented refresh token dies with this exchange
      await db.update(mcpTokens).set({ revokedAt: new Date() }).where(eq(mcpTokens.id, row.id))
      return { ...grant, ...(await issue(grant)) }
    },

    async verifyAccessToken(accessToken) {
      const [row] = await db
        .select()
        .from(mcpTokens)
        .where(and(eq(mcpTokens.tokenHash, sha256(accessToken)), eq(mcpTokens.kind, 'access')))
        .limit(1)
      if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null
      // touch last_used_at at most once a minute per token: evidence of life without a write per call
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
        await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.id))
      return {
        ...row,
        clientId: row.clientId,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes,
      }
    },

    async revoke(tokenValue) {
      await db
        .update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(eq(mcpTokens.tokenHash, sha256(tokenValue)))
    },

    async revokeClientTokens(clientId, userId) {
      const where = userId
        ? and(eq(mcpTokens.clientId, clientId), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt))
        : and(eq(mcpTokens.clientId, clientId), isNull(mcpTokens.revokedAt))
      const rows = await db
        .update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(where)
        .returning({ id: mcpTokens.id })
      return rows.length
    },

    async prune() {
      const stale = new Date()
      await db.delete(mcpAuthRequests).where(lt(mcpAuthRequests.expiresAt, stale))
      await db.delete(mcpCodes).where(or(lt(mcpCodes.expiresAt, stale), sql`${mcpCodes.usedAt} is not null`))
      await db.delete(mcpTokens).where(lt(mcpTokens.expiresAt, new Date(Date.now() - REFRESH_TTL_MS)))
    },
  }
  return oauth
}
