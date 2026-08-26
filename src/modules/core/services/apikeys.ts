/**
 * Personal API keys: a member's own credential for calling the ordinary REST API directly.
 *
 * Key generation, hashing and storage are Better Auth's `apiKey` plugin — already installed and
 * already resolving a valid key to a principal in `src/auth/principal.ts`, just never wired to
 * anything a person could create one from. This file is that missing half: workspace/scope carried
 * in the plugin's own free-form `metadata`, and `list`/`revoke` reading the table directly rather
 * than through the plugin's session-bound endpoints, which have no path for "an admin acting on
 * someone else's key" — the same reason `src/mcp/oauth.ts` manages its own tables directly instead
 * of going through a generic layer built for a narrower case.
 */
import type { Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { KernError } from '@kernhq/kernel'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Auth } from '../../../auth/auth.js'
import { apikey, MODULE_ID, user } from '../schema/index.js'
import { audienceAllows, CAPABILITY_AUDIENCE_KEY } from './capability-audience.js'
import { getModuleSettings } from './modules.js'

export type ApiKeyScope = 'read' | 'read_write'

export interface ApiKeyMetadata {
  workspaceId: string
  scope: ApiKeyScope
}

export interface ApiKeyInfoRow {
  id: string
  name: string
  start: string | null
  scope: ApiKeyScope
  workspaceId: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null)

function parseMetadata(raw: string | null): ApiKeyMetadata | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ApiKeyMetadata>
    if (typeof v.workspaceId !== 'string') return null
    return { workspaceId: v.workspaceId, scope: v.scope === 'read_write' ? 'read_write' : 'read' }
  } catch {
    return null
  }
}

async function requireEligible(kernel: Kernel, principal: Principal, workspaceId: string): Promise<void> {
  await kernel.authz.requireMember(principal, workspaceId)
  const caps = await kernel.capabilities(workspaceId, MODULE_ID)
  // a switched-off capability answers 404 rather than 403, like everywhere else in Kern
  if (!caps.has('api_keys')) throw KernError.notFound('API keys')
  const membership = principal.memberships.find((m) => m.workspaceId === workspaceId)
  const settings = await getModuleSettings(kernel, workspaceId, MODULE_ID)
  if (!audienceAllows(settings[CAPABILITY_AUDIENCE_KEY], 'api_keys', membership?.groupIds ?? []))
    throw KernError.notFound('API keys')
}

/** Created once; the plaintext key is returned here and never again. */
export async function create(
  kernel: Kernel,
  auth: Auth,
  principal: Principal,
  input: { workspaceId: string; name: string; scope: ApiKeyScope; expiresInDays: number | null },
): Promise<ApiKeyInfoRow & { key: string }> {
  if (!principal.userId) throw KernError.unauthorized()
  await requireEligible(kernel, principal, input.workspaceId)

  const metadata: ApiKeyMetadata = { workspaceId: input.workspaceId, scope: input.scope }
  const created = await auth.api.createApiKey({
    body: {
      userId: principal.userId,
      name: input.name,
      prefix: 'kak_',
      expiresIn: input.expiresInDays ? input.expiresInDays * 86_400 : null,
      metadata,
    },
  })
  return {
    id: created.id,
    name: created.name ?? input.name,
    start: created.start,
    scope: input.scope,
    workspaceId: input.workspaceId,
    lastUsedAt: null,
    expiresAt: iso(created.expiresAt),
    createdAt: iso(created.createdAt)!,
    key: created.key,
  }
}

/** The caller's own keys in one workspace — always "mine"; an admin's view of everyone's is `listAll`. */
export async function list(
  kernel: Kernel,
  principal: Principal,
  workspaceId: string,
): Promise<ApiKeyInfoRow[]> {
  if (!principal.userId) throw KernError.unauthorized()
  const rows = await kernel.database.db
    .select()
    .from(apikey)
    .where(eq(apikey.referenceId, principal.userId))
    .orderBy(desc(apikey.createdAt))
  return rows.flatMap((r) => {
    const meta = parseMetadata(r.metadata)
    if (!meta || meta.workspaceId !== workspaceId) return []
    return [
      {
        id: r.id,
        name: r.name ?? '',
        start: r.start,
        scope: meta.scope,
        workspaceId: meta.workspaceId,
        lastUsedAt: iso(r.lastRequest),
        expiresAt: iso(r.expiresAt),
        createdAt: iso(r.createdAt)!,
      },
    ]
  })
}

export interface ApiKeyAdminRow extends ApiKeyInfoRow {
  userId: string
  userName: string
}

/** Every key issued in this workspace, whoever holds it — so an admin can revoke one on offboarding. */
export async function listAll(kernel: Kernel, workspaceId: string): Promise<ApiKeyAdminRow[]> {
  const rows = await kernel.database.db
    .select({ key: apikey, userName: user.name })
    .from(apikey)
    // `referenceId` is text (Better Auth's generic column, shared with non-uuid backends); user.id is
    // uuid. The plugin owns that table's shape, so the cast belongs on this side of the join.
    .leftJoin(user, sql`${user.id}::text = ${apikey.referenceId}`)
    .where(sql`(${apikey.metadata})::jsonb ->> 'workspaceId' = ${workspaceId}::text`)
    .orderBy(desc(apikey.createdAt))
  return rows.flatMap(({ key: r, userName }) => {
    const meta = parseMetadata(r.metadata)
    if (!meta) return []
    return [
      {
        id: r.id,
        name: r.name ?? '',
        start: r.start,
        scope: meta.scope,
        workspaceId: meta.workspaceId,
        lastUsedAt: iso(r.lastRequest),
        expiresAt: iso(r.expiresAt),
        createdAt: iso(r.createdAt)!,
        userId: r.referenceId,
        userName: userName ?? 'unknown',
      },
    ]
  })
}

/** A member always revokes their own key; an integration manager may revoke anyone's in their workspace. */
export async function revoke(kernel: Kernel, principal: Principal, id: string): Promise<{ ok: true }> {
  const [row] = await kernel.database.db.select().from(apikey).where(eq(apikey.id, id)).limit(1)
  if (!row) throw KernError.notFound('API key')
  const meta = parseMetadata(row.metadata)
  if (row.referenceId !== principal.userId) {
    if (!meta) throw KernError.notFound('API key')
    await kernel.authz.require(principal, 'core.integrations.manage', {
      kind: 'workspace',
      id: meta.workspaceId,
      workspaceId: meta.workspaceId,
    })
  }
  await kernel.database.db
    .delete(apikey)
    .where(and(eq(apikey.id, id), eq(apikey.referenceId, row.referenceId)))
  return { ok: true }
}
