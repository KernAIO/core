import type { core, Page } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError } from '@kernhq/kernel'
import { and, asc, eq, exists, gt, inArray, isNull, ne, not, or, sql } from 'drizzle-orm'
import { decodeCursor, encodeCursor, paginate } from '../lib/cursor.js'
import { serUser, serUserPublic } from '../lib/ser.js'
import { memberships, notifications, user, workspaces } from '../schema/index.js'
import { type Ctx, ilikeEscape, requireUser } from './common.js'

export async function getUserRow(ctx: Ctx, id: string) {
  const [u] = await ctx.kernel.database.db.select().from(user).where(eq(user.id, id)).limit(1)
  return u ?? null
}

export async function me(
  ctx: Ctx,
): Promise<{ user: core.User; workspaces: core.WorkspaceSummary[]; permissionVersion: number }> {
  const userId = requireUser(ctx.principal)
  const u = await getUserRow(ctx, userId)
  if (!u) throw KernError.unauthorized()
  return {
    user: serUser(u),
    workspaces: await workspaceSummaries(ctx, userId),
    permissionVersion: u.permissionVersion,
  }
}

export async function workspaceSummaries(ctx: Ctx, userId: string): Promise<core.WorkspaceSummary[]> {
  const db = ctx.kernel.database.db
  const rows = await db
    .select({ w: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(eq(memberships.userId, userId), eq(memberships.status, 'active'), isNull(workspaces.archivedAt)),
    )
    .orderBy(asc(workspaces.name))
  const counts = await db
    .select({
      workspaceId: notifications.workspaceId,
      unread: sql<number>`count(*)::int`,
      mentions: sql<number>`count(*) filter (where ${notifications.urgent})::int`,
    })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt), isNull(notifications.archivedAt)),
    )
    .groupBy(notifications.workspaceId)
  const byWs = new Map(counts.map((c) => [c.workspaceId, c]))
  const memberCounts = await db
    .select({ workspaceId: memberships.workspaceId, n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.status, 'active'),
        inArray(
          memberships.workspaceId,
          rows.map((r) => r.w.id),
        ),
      ),
    )
    .groupBy(memberships.workspaceId)
  const mc = new Map(memberCounts.map((c) => [c.workspaceId, c.n]))
  return rows.map((r) => ({
    id: r.w.id as core.WorkspaceSummary['id'],
    slug: r.w.slug,
    name: r.w.name,
    logoUrl: r.w.logoUrl,
    accentColor: r.w.accentColor,
    role: r.role as core.WorkspaceSummary['role'],
    unread: byWs.get(r.w.id)?.unread ?? 0,
    mentions: byWs.get(r.w.id)?.mentions ?? 0,
    memberCount: mc.get(r.w.id) ?? 0,
  }))
}

export async function updateMe(ctx: Ctx, patch: core.UpdateMe): Promise<core.User> {
  const userId = requireUser(ctx.principal)
  const db = ctx.kernel.database.db
  if (patch.username !== undefined && patch.username !== null) {
    const taken = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.username, patch.username), ne(user.id, userId)))
      .limit(1)
    if (taken.length) throw KernError.conflict('Username is taken', 'core.user.username_taken')
  }
  const set: Partial<typeof user.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.username !== undefined) set.username = patch.username
  if (patch.avatarUrl !== undefined) set.image = patch.avatarUrl
  if (patch.locale !== undefined) set.locale = patch.locale
  if (patch.timezone !== undefined) set.timezone = patch.timezone
  const [u] = await db.update(user).set(set).where(eq(user.id, userId)).returning()
  if (!u) throw KernError.notFound('User')
  await ctx.kernel.emit(
    coreEvents.userUpdated,
    { userId: userId as never, fields: Object.keys(patch) },
    { actorId: userId },
  )
  return serUser(u)
}

/** Public profile – visible to anyone sharing a workspace with the caller (or the caller themself / admins). */
export async function getPublic(ctx: Ctx, id: string): Promise<core.UserPublic> {
  const userId = requireUser(ctx.principal)
  const u = await getUserRow(ctx, id)
  if (!u || u.status === 'deleted') throw KernError.notFound('User')
  if (id !== userId && !ctx.principal.instanceAdmin && ctx.principal.kind !== 'service') {
    const shared = await sharesWorkspace(ctx, userId, id)
    if (!shared) throw KernError.notFound('User')
  }
  return serUserPublic(u)
}

export async function sharesWorkspace(ctx: Ctx, a: string, b: string): Promise<boolean> {
  const db = ctx.kernel.database.db
  const m2 = db
    .select({ w: memberships.workspaceId })
    .from(memberships)
    .where(and(eq(memberships.userId, b), eq(memberships.status, 'active')))
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.userId, a), eq(memberships.status, 'active'), inArray(memberships.workspaceId, m2)),
    )
    .limit(1)
  return rows.length > 0
}

/** Users the caller may invite/mention: members of every workspace they share (optionally excluding members of one). */
export async function directory(
  ctx: Ctx,
  input: { q?: string; excludeWorkspaceId?: string; cursor?: string; limit: number },
): Promise<Page<core.UserPublic & { sharedWorkspaces: string[] }>> {
  const userId = requireUser(ctx.principal)
  const db = ctx.kernel.database.db
  const myWs = db
    .select({ w: memberships.workspaceId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
  const cur = decodeCursor(input.cursor)
  const conds = [
    inArray(memberships.workspaceId, myWs),
    eq(memberships.status, 'active'),
    ne(user.id, userId),
    eq(user.status, 'active'),
  ]
  if (input.q) {
    const q = `%${ilikeEscape(input.q)}%`
    conds.push(
      or(sql`${user.name} ilike ${q}`, sql`${user.email} ilike ${q}`, sql`${user.username} ilike ${q}`)!,
    )
  }
  if (input.excludeWorkspaceId) {
    const ex = input.excludeWorkspaceId
    conds.push(
      not(
        exists(
          db
            .select({ one: sql`1` })
            .from(sql`${memberships} mx`)
            .where(sql`mx.workspace_id = ${ex} and mx.user_id = ${user.id}`),
        ),
      ),
    )
  }
  if (cur) conds.push(gt(user.id, cur.id))
  const rows = await db
    .select({ u: user, shared: sql<string[]>`array_agg(distinct ${memberships.workspaceId}::text)` })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(...conds))
    .groupBy(user.id)
    .orderBy(asc(user.id))
    .limit(input.limit + 1)
  const page = paginate(rows, input.limit, (r) => encodeCursor(null, r.u.id))
  return {
    items: page.items.map((r) => ({ ...serUserPublic(r.u), sharedWorkspaces: r.shared })),
    nextCursor: page.nextCursor,
  }
}

/**
 * Profiles for a list of user ids, for a service that holds ids and needs names to draw beside them.
 *
 * **An email address is only ever handed out for a workspace the caller names**, and only for people
 * who are actually members of it. That is the same rule `getPublic` applies to an end user — you see
 * the address of somebody you share a workspace with — expressed for a service principal, which has
 * no memberships of its own to check. Without it this returned `serUserPublic(u)` for *any* id: a
 * module in any service could hand core a list of uuids and get back the addresses, which on a
 * multi-tenant instance is a cross-tenant leak with no attacker sophistication in it at all.
 *
 * Callers that only render names (chat's `UserDirectory`, which reads `name`, `username` and
 * `avatarUrl`) need no workspace and keep working — they simply stop being told the address.
 */
export async function getMany(
  ctx: Ctx,
  ids: string[],
  opts: { workspaceId?: string } = {},
): Promise<core.UserPublic[]> {
  if (!ids.length) return []
  const db = ctx.kernel.database.db
  if (!opts.workspaceId) {
    const rows = await db.select().from(user).where(inArray(user.id, ids))
    return rows.map((u) => serUserPublic(u, { email: false }))
  }
  const rows = await db
    .select({ u: user })
    .from(user)
    .innerJoin(memberships, eq(memberships.userId, user.id))
    .where(
      and(
        inArray(user.id, ids),
        eq(memberships.workspaceId, opts.workspaceId),
        eq(memberships.status, 'active'),
      ),
    )
  return rows.map((r) => serUserPublic(r.u))
}
