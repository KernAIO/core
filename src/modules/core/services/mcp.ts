/**
 * Workspace-facing MCP operations behind the core router: what the consent screen reads, what an
 * admin sees under Settings → Integrations, and how anybody disconnects their own AI client.
 *
 * The OAuth machinery lives in `src/mcp/oauth.ts`; this file is the thin, permission-checked layer
 * above it, shaped like every other service in this module.
 */
import type { Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { KernError } from '@kernhq/kernel'
import { and, eq } from 'drizzle-orm'
import type { McpOauth } from '../../../mcp/oauth.js'
import { MODULE_ID, mcpClients, mcpConsents, mcpTokens, user } from '../schema/index.js'

export interface Ctx {
  kernel: Kernel
  principal: Principal
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export async function authorizeInfo(
  kernel: Kernel,
  oauth: McpOauth,
  principal: Principal,
  requestId: string,
): Promise<{
  id: string
  clientName: string
  clientUri: string | null
  logoUri: string | null
  scopes: string[]
  returning: boolean
  expiresAt: string
}> {
  if (!principal.userId) throw KernError.unauthorized()
  const req = await oauth.getAuthRequest(requestId)
  // another user's request does not exist, as far as this caller is concerned
  if (!req || req.userId !== principal.userId) throw KernError.notFound('Authorization request')
  const client = await oauth.getClient(req.clientId)
  const [prior] = await kernel.database.db
    .select({ id: mcpConsents.id })
    .from(mcpConsents)
    .where(and(eq(mcpConsents.userId, req.userId), eq(mcpConsents.clientId, req.clientId)))
    .limit(1)
  return {
    id: req.id,
    clientName: client?.name ?? req.clientId,
    clientUri: client?.clientUri ?? null,
    logoUri: client?.logoUri ?? null,
    scopes: req.scope ? req.scope.split(' ').filter(Boolean) : [],
    returning: !!prior,
    expiresAt: iso(req.expiresAt)!,
  }
}

/** The consent said yes — but only for a workspace whose door MCP stands behind. */
export async function approve(
  kernel: Kernel,
  oauth: McpOauth,
  principal: Principal,
  input: { requestId: string; workspaceId: string },
): Promise<{ redirectUrl: string }> {
  await kernel.authz.requireMember(principal, input.workspaceId)
  const caps = await kernel.capabilities(input.workspaceId, MODULE_ID)
  // a switched-off capability answers 404 rather than 403, like everywhere else in Kern
  if (!caps.has('mcp')) throw KernError.notFound('MCP')
  return oauth.approve({
    requestId: input.requestId,
    userId: principal.userId as string,
    workspaceId: input.workspaceId,
  })
}

export async function deny(
  oauth: McpOauth,
  principal: Principal,
  requestId: string,
): Promise<{ redirectUrl: string }> {
  if (!principal.userId) throw KernError.unauthorized()
  return oauth.deny(requestId, principal.userId)
}

export interface ConnectedClient {
  clientId: string
  name: string
  clientUri: string | null
  logoUri: string | null
  redirectUris: string[]
  firstParty: boolean
  createdBy: string | null
  createdAt: string
  workspaceId: string
  activeTokens: number
  lastUsedAt: string | null
}

/**
 * Clients seen in this workspace — a live token or a consent counts. Grouped here rather than on
 * the client row because the same registered client may be used by several members at once.
 */
export async function listConnectedClients(kernel: Kernel, workspaceId: string): Promise<ConnectedClient[]> {
  const db = kernel.database.db
  const clients = await db.select().from(mcpClients)
  const tokens = await db.select().from(mcpTokens).where(eq(mcpTokens.workspaceId, workspaceId))
  const consents = await db.select().from(mcpConsents).where(eq(mcpConsents.workspaceId, workspaceId))
  const byClient = new Map<string, ConnectedClient & { _live: number; _lastUsed: Date | null }>()
  const touch = (clientId: string) => {
    const c = clients.find((x) => x.clientId === clientId)
    if (!c) return // a client that was never registered cannot be shown honestly
    let e = byClient.get(clientId)
    if (!e) {
      e = {
        clientId: c.clientId,
        name: c.name,
        clientUri: c.clientUri,
        logoUri: c.logoUri,
        redirectUris: c.redirectUris,
        firstParty: c.firstParty,
        createdBy: c.createdBy,
        createdAt: iso(c.createdAt)!,
        workspaceId,
        activeTokens: 0,
        lastUsedAt: null,
        _live: 0,
        _lastUsed: null,
      }
      byClient.set(clientId, e)
    }
    return e!
  }
  const now = Date.now()
  for (const t of tokens) {
    const dead = t.revokedAt || t.expiresAt.getTime() < now
    const e = touch(t.clientId)
    if (!e || dead) continue
    e._live++
    if (!e._lastUsed || (t.lastUsedAt && t.lastUsedAt > e._lastUsed)) e._lastUsed = t.lastUsedAt
  }
  for (const c of consents) touch(c.clientId)
  return [...byClient.values()].map(({ _live, _lastUsed, ...rest }) => ({
    ...rest,
    activeTokens: _live,
    lastUsedAt: iso(_lastUsed),
  }))
}

export interface TokenInfoRow {
  id: string
  clientId: string
  clientName: string
  userId: string
  userName: string
  workspaceId: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
}

export async function listWorkspaceTokens(kernel: Kernel, workspaceId: string): Promise<TokenInfoRow[]> {
  const db = kernel.database.db
  const rows = await db
    .select({ token: mcpTokens, userName: user.name })
    .from(mcpTokens)
    .leftJoin(user, eq(user.id, mcpTokens.userId))
    .where(eq(mcpTokens.workspaceId, workspaceId))
  const clients = await db.select().from(mcpClients)
  const out: TokenInfoRow[] = []
  for (const r of rows) {
    if (r.token.revokedAt) continue
    out.push({
      id: r.token.id,
      clientId: r.token.clientId,
      clientName: clients.find((c) => c.clientId === r.token.clientId)?.name ?? r.token.clientId,
      userId: r.token.userId,
      userName: r.userName ?? 'unknown',
      workspaceId: r.token.workspaceId,
      scopes: r.token.scopes,
      createdAt: iso(r.token.createdAt)!,
      lastUsedAt: iso(r.token.lastUsedAt),
      expiresAt: iso(r.token.expiresAt)!,
    })
  }
  return out
}

/**
 * Disconnecting means the whole connection, not one half-hour token: everything issued from the
 * same consent (same client, user and workspace) dies together. A member may always disconnect
 * their own client; an integration manager may disconnect anybody's in their workspace.
 */
export async function revokeConnection(
  kernel: Kernel,
  principal: Principal,
  tokenId: string,
): Promise<{ ok: true }> {
  const [row] = await kernel.database.db.select().from(mcpTokens).where(eq(mcpTokens.id, tokenId)).limit(1)
  if (!row) throw KernError.notFound('Token')
  if (row.userId !== principal.userId)
    await kernel.authz.require(principal, 'core.integrations.manage', {
      kind: 'workspace',
      id: row.workspaceId,
      workspaceId: row.workspaceId,
    })
  await kernel.database.db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokens.clientId, row.clientId),
        eq(mcpTokens.userId, row.userId),
        eq(mcpTokens.workspaceId, row.workspaceId),
      ),
    )
  return { ok: true }
}
