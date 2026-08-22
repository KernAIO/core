import type { BuiltinRole, core, Page } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError } from '@kernhq/kernel'
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { decodeCursor, encodeCursor, paginate } from '../lib/cursor.js'
import { serMember } from '../lib/ser.js'
import { groupMembers, memberships, roles, user } from '../schema/index.js'
import {
  type Ctx,
  callerRole,
  countOwners,
  ilikeEscape,
  permissionsChanged,
  ROLE_RANK,
  requireUser,
} from './common.js'

export async function list(
  ctx: Ctx,
  input: { workspaceId: string; q?: string; status?: string; cursor?: string; limit: number },
): Promise<Page<core.Member>> {
  const db = ctx.kernel.database.db
  const cur = decodeCursor(input.cursor)
  const conds = [eq(memberships.workspaceId, input.workspaceId)]
  if (input.status) conds.push(eq(memberships.status, input.status))
  if (input.q) {
    const q = `%${ilikeEscape(input.q)}%`
    conds.push(
      or(sql`${user.name} ilike ${q}`, sql`${user.email} ilike ${q}`, sql`${user.username} ilike ${q}`)!,
    )
  }
  if (cur) conds.push(gt(memberships.id, cur.id))
  const rows = await db
    .select({ m: memberships, u: user })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(...conds))
    .orderBy(asc(memberships.id))
    .limit(input.limit + 1)
  const page = paginate(rows, input.limit, (r) => encodeCursor(null, r.m.id))
  return { items: page.items.map((r) => serMember(r.m, r.u)), nextCursor: page.nextCursor }
}

async function getMember(ctx: Ctx, workspaceId: string, userId: string) {
  const [row] = await ctx.kernel.database.db
    .select({ m: memberships, u: user })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1)
  if (!row) throw KernError.notFound('Member')
  return row
}

/** Only owners may grant/revoke owner; admins may manage members below owner. */
function assertCanAssignRole(
  ctx: Ctx,
  workspaceId: string,
  targetCurrent: BuiltinRole,
  targetNew: BuiltinRole,
) {
  const me = callerRole(ctx.principal, workspaceId)
  if (!me) throw KernError.forbidden()
  if (me !== 'owner' && (targetCurrent === 'owner' || targetNew === 'owner'))
    throw KernError.forbidden('core.members.manage')
  if (ROLE_RANK[targetNew] > ROLE_RANK[me]) throw KernError.forbidden('core.members.manage')
}

export async function update(
  ctx: Ctx,
  input: { workspaceId: string; userId: string; patch: z.infer<typeof core.UpdateMember> },
): Promise<core.Member> {
  const { kernel } = ctx
  const db = kernel.database.db
  const { m } = await getMember(ctx, input.workspaceId, input.userId)
  const patch = input.patch
  const set: Partial<typeof memberships.$inferInsert> = { updatedAt: new Date() }
  if (patch.role !== undefined && patch.role !== m.role) {
    assertCanAssignRole(ctx, input.workspaceId, m.role as BuiltinRole, patch.role)
    if (m.role === 'owner' && (await countOwners(kernel, input.workspaceId)) <= 1)
      throw KernError.conflict('Cannot demote the last owner', 'core.members.last_owner')
    set.role = patch.role
  }
  if (patch.status !== undefined && patch.status !== m.status) {
    if (m.role === 'owner') assertCanAssignRole(ctx, input.workspaceId, 'owner', 'owner')
    if (
      m.role === 'owner' &&
      patch.status !== 'active' &&
      (await countOwners(kernel, input.workspaceId)) <= 1
    )
      throw KernError.conflict('Cannot suspend the last owner', 'core.members.last_owner')
    set.status = patch.status
  }
  if (patch.roleIds !== undefined) {
    if (patch.roleIds.length) {
      const known = await kernel.database.withWorkspace(input.workspaceId, (tx) =>
        tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(
              eq(roles.workspaceId, input.workspaceId),
              inArray(roles.id, patch.roleIds!),
              eq(roles.builtin, false),
            ),
          ),
      )
      if (known.length !== new Set(patch.roleIds).size)
        throw KernError.badRequest('Unknown role id', { roleIds: patch.roleIds })
    }
    set.roleIds = [...new Set(patch.roleIds)]
  }
  if (patch.title !== undefined) set.title = patch.title
  if (patch.groupIds !== undefined) {
    const groupIds = [...new Set(patch.groupIds)]
    await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
      await tx
        .delete(groupMembers)
        .where(and(eq(groupMembers.workspaceId, input.workspaceId), eq(groupMembers.userId, input.userId)))
      if (groupIds.length)
        await tx
          .insert(groupMembers)
          .values(
            groupIds.map((groupId) => ({ workspaceId: input.workspaceId, groupId, userId: input.userId })),
          )
    })
    set.groupIds = groupIds
  }
  const [updated] = await db.update(memberships).set(set).where(eq(memberships.id, m.id)).returning()
  const { u } = await getMember(ctx, input.workspaceId, input.userId)
  await permissionsChanged(kernel, input.workspaceId, [input.userId], ctx.principal.userId)
  await kernel.emit(
    coreEvents.memberUpdated,
    {
      workspaceId: input.workspaceId as never,
      userId: input.userId as never,
      role: (updated?.role ?? m.role) as BuiltinRole,
    },
    { workspaceId: input.workspaceId, actorId: ctx.principal.userId },
  )
  await kernel.realtime.change(input.workspaceId, {
    module: 'core',
    entity: 'member',
    id: m.id,
    op: 'updated',
  })
  return serMember(updated ?? m, u)
}

export async function remove(
  ctx: Ctx,
  workspaceId: string,
  userId: string,
  opts: { self?: boolean } = {},
): Promise<void> {
  const { kernel } = ctx
  const { m } = await getMember(ctx, workspaceId, userId)
  if (!opts.self) assertCanAssignRole(ctx, workspaceId, m.role as BuiltinRole, m.role as BuiltinRole)
  if (m.role === 'owner' && m.status === 'active' && (await countOwners(kernel, workspaceId)) <= 1)
    throw KernError.conflict(
      'Cannot remove the last owner – transfer ownership first',
      'core.members.last_owner',
    )
  await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.workspaceId, workspaceId), eq(groupMembers.userId, userId))),
  )
  await kernel.database.db.delete(memberships).where(eq(memberships.id, m.id))
  await permissionsChanged(kernel, workspaceId, [userId], ctx.principal.userId)
  await kernel.emit(
    coreEvents.memberRemoved,
    { workspaceId: workspaceId as never, userId: userId as never },
    { workspaceId, actorId: ctx.principal.userId },
  )
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'member', id: m.id, op: 'deleted' })
}

export async function leave(ctx: Ctx, workspaceId: string): Promise<void> {
  return remove(ctx, workspaceId, requireUser(ctx.principal), { self: true })
}

/** ids + roles of active members (for other services: fan-out, mentions) */
export async function workspaceMembers(
  ctx: Ctx,
  workspaceId: string,
): Promise<Array<{ userId: string; role: BuiltinRole; roleIds: string[]; groupIds: string[] }>> {
  const rows = await ctx.kernel.database.db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      roleIds: memberships.roleIds,
      groupIds: memberships.groupIds,
    })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')))
  return rows.map((r) => ({ ...r, role: r.role as BuiltinRole }))
}
