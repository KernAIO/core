import type { core } from '@kernhq/contracts'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { serGroup, serUserPublic } from '../lib/ser.js'
import { groupMembers, groups, memberships, user } from '../schema/index.js'
import { type Ctx, permissionsChanged } from './common.js'
import { validateSlug } from './workspaces.js'

type Upsert = z.infer<typeof core.UpsertGroup>

export async function list(ctx: Ctx, workspaceId: string): Promise<core.Group[]> {
  return ctx.kernel.database.withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select({
        g: groups,
        n: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
      })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId))
      .orderBy(asc(groups.name))
    return rows.map((r) => serGroup(r.g, r.n))
  })
}

export async function create(ctx: Ctx, workspaceId: string, input: Upsert): Promise<core.Group> {
  validateSlug(input.handle)
  const row = await ctx.kernel.database.withWorkspace(workspaceId, async (tx) => {
    const dup = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.workspaceId, workspaceId), eq(groups.handle, input.handle)))
      .limit(1)
    if (dup.length) throw KernError.conflict('Group handle is taken', 'core.group.handle_taken')
    const [g] = await tx
      .insert(groups)
      .values({ workspaceId, name: input.name, handle: input.handle, description: input.description ?? null })
      .returning()
    return g!
  })
  await ctx.kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'group',
    id: row.id,
    op: 'created',
  })
  return serGroup(row, 0)
}

export async function update(
  ctx: Ctx,
  workspaceId: string,
  id: string,
  patch: Partial<Upsert>,
): Promise<core.Group> {
  if (patch.handle) validateSlug(patch.handle)
  const out = await ctx.kernel.database.withWorkspace(workspaceId, async (tx) => {
    const set: Partial<typeof groups.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.handle !== undefined) set.handle = patch.handle
    if (patch.description !== undefined) set.description = patch.description
    const [g] = await tx
      .update(groups)
      .set(set)
      .where(and(eq(groups.id, id), eq(groups.workspaceId, workspaceId)))
      .returning()
    if (!g) throw KernError.notFound('Group')
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, id))
    return serGroup(g, n)
  })
  await ctx.kernel.realtime.change(workspaceId, { module: 'core', entity: 'group', id, op: 'updated' })
  return out
}

export async function remove(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  const { kernel } = ctx
  const userIds = await kernel.database.withWorkspace(workspaceId, async (tx) => {
    const ms = await tx
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, id))
    const [g] = await tx
      .delete(groups)
      .where(and(eq(groups.id, id), eq(groups.workspaceId, workspaceId)))
      .returning({ id: groups.id })
    if (!g) throw KernError.notFound('Group')
    return ms.map((m) => m.userId)
  })
  await syncMembershipGroupIds(kernel, workspaceId, userIds)
  await permissionsChanged(kernel, workspaceId, userIds, ctx.principal.userId)
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'group', id, op: 'deleted' })
}

export async function setMembers(
  ctx: Ctx,
  workspaceId: string,
  id: string,
  userIds: string[],
): Promise<core.Group> {
  const { kernel } = ctx
  const wanted = [...new Set(userIds)]
  const affected = await kernel.database.withWorkspace(workspaceId, async (tx) => {
    const [g] = await tx
      .select()
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.workspaceId, workspaceId)))
      .limit(1)
    if (!g) throw KernError.notFound('Group')
    if (wanted.length) {
      const members = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, wanted)))
      if (members.length !== wanted.length) throw KernError.badRequest('All users must be workspace members')
    }
    const before = (
      await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, id))
    ).map((m) => m.userId)
    await tx.delete(groupMembers).where(eq(groupMembers.groupId, id))
    if (wanted.length)
      await tx.insert(groupMembers).values(wanted.map((userId) => ({ workspaceId, groupId: id, userId })))
    return [...new Set([...before, ...wanted])]
  })
  await syncMembershipGroupIds(kernel, workspaceId, affected)
  await permissionsChanged(kernel, workspaceId, affected, ctx.principal.userId)
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'group', id, op: 'updated' })
  const [g] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx.select().from(groups).where(eq(groups.id, id)).limit(1),
  )
  return serGroup(g!, wanted.length)
}

/** replace the set of groups of one user (used by member update / invitation accept) */
export async function setMembersForUser(ctx: Ctx, workspaceId: string, userId: string, groupIds: string[]) {
  const { kernel } = ctx
  await kernel.database.withWorkspace(workspaceId, async (tx) => {
    await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.workspaceId, workspaceId), eq(groupMembers.userId, userId)))
    if (groupIds.length) {
      const known = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.workspaceId, workspaceId), inArray(groups.id, groupIds)))
      if (known.length)
        await tx.insert(groupMembers).values(known.map((g) => ({ workspaceId, groupId: g.id, userId })))
    }
  })
  await syncMembershipGroupIds(kernel, workspaceId, [userId])
}

export async function members(ctx: Ctx, workspaceId: string, id: string): Promise<core.UserPublic[]> {
  const ids = await ctx.kernel.database.withWorkspace(workspaceId, async (tx) => {
    const [g] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, id), eq(groups.workspaceId, workspaceId)))
      .limit(1)
    if (!g) throw KernError.notFound('Group')
    return (
      await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, id))
    ).map((m) => m.userId)
  })
  if (!ids.length) return []
  const rows = await ctx.kernel.database.db
    .select()
    .from(user)
    .where(inArray(user.id, ids))
    .orderBy(asc(user.name))
  return rows.map((u) => serUserPublic(u))
}

/** keep memberships.group_ids (global, used for principal loading) in sync with group_members */
export async function syncMembershipGroupIds(kernel: Kernel, workspaceId: string, userIds: string[]) {
  if (!userIds.length) return
  const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ userId: groupMembers.userId, groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(and(eq(groupMembers.workspaceId, workspaceId), inArray(groupMembers.userId, userIds))),
  )
  const byUser = new Map<string, string[]>()
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.groupId])
  for (const userId of userIds) {
    await kernel.database.db
      .update(memberships)
      .set({ groupIds: byUser.get(userId) ?? [], updatedAt: new Date() })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
  }
}
