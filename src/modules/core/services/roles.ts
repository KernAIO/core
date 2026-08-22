import type { core } from '@kernaio/contracts'
import { type Binding, KernError, type Kernel } from '@kernaio/kernel'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { serBinding, serRole } from '../lib/ser.js'
import { memberships, roleBindings, roles } from '../schema/index.js'
import { type Ctx, permissionsChanged } from './common.js'

type Upsert = z.infer<typeof core.UpsertRole>

function validatePermissions(kernel: Kernel, keys: string[]) {
  const unknown = keys.filter((k) => !kernel.authz.isKnown(k))
  if (unknown.length) throw KernError.badRequest('Unknown permission keys', { unknown })
  return [...new Set(keys)]
}

export async function list(ctx: Ctx, workspaceId: string): Promise<core.Role[]> {
  const rows = await ctx.kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(roles)
      .where(eq(roles.workspaceId, workspaceId))
      .orderBy(asc(roles.builtin), asc(roles.name)),
  )
  return rows.map(serRole)
}

export async function create(ctx: Ctx, workspaceId: string, input: Upsert): Promise<core.Role> {
  const permissions = validatePermissions(ctx.kernel, input.permissions)
  const row = await ctx.kernel.database.withWorkspace(workspaceId, async (tx) => {
    const dup = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), eq(roles.name, input.name)))
      .limit(1)
    if (dup.length) throw KernError.conflict('Role name is taken', 'core.role.name_taken')
    const [r] = await tx
      .insert(roles)
      .values({ workspaceId, name: input.name, description: input.description ?? null, permissions })
      .returning()
    return r!
  })
  await ctx.kernel.realtime.change(workspaceId, { module: 'core', entity: 'role', id: row.id, op: 'created' })
  return serRole(row)
}

export async function update(
  ctx: Ctx,
  workspaceId: string,
  id: string,
  patch: Partial<Upsert>,
): Promise<core.Role> {
  const { kernel } = ctx
  const row = await kernel.database.withWorkspace(workspaceId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) throw KernError.notFound('Role')
    if (existing.builtin) throw KernError.conflict('Built-in roles cannot be edited', 'core.role.builtin')
    const set: Partial<typeof roles.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.description !== undefined) set.description = patch.description
    if (patch.permissions !== undefined) set.permissions = validatePermissions(kernel, patch.permissions)
    const [r] = await tx.update(roles).set(set).where(eq(roles.id, id)).returning()
    return r!
  })
  const affected = (
    await kernel.database.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), sql`${id}::uuid = any(${memberships.roleIds})`))
  ).map((m) => m.userId)
  await permissionsChanged(kernel, workspaceId, affected.length ? affected : null, ctx.principal.userId)
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'role', id, op: 'updated' })
  return serRole(row)
}

export async function remove(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  const { kernel } = ctx
  await kernel.database.withWorkspace(workspaceId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) throw KernError.notFound('Role')
    if (existing.builtin) throw KernError.conflict('Built-in roles cannot be deleted', 'core.role.builtin')
    await tx.delete(roles).where(eq(roles.id, id))
  })
  const affected = (
    await kernel.database.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), sql`${id}::uuid = any(${memberships.roleIds})`))
  ).map((m) => m.userId)
  if (affected.length)
    await kernel.database.db
      .update(memberships)
      .set({ roleIds: sql`array_remove(${memberships.roleIds}, ${id}::uuid)` })
      .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, affected)))
  await permissionsChanged(kernel, workspaceId, null, ctx.principal.userId)
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'role', id, op: 'deleted' })
}

export function permissionRegistry(kernel: Kernel) {
  return kernel.authz.allPermissions().map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    module: p.module,
    scope: p.scope,
    dangerous: p.dangerous,
  }))
}

// ---------- bindings ----------
export async function listBindings(
  ctx: Ctx,
  workspaceId: string,
  filter: { scopeKind?: string; scopeId?: string },
): Promise<core.RoleBinding[]> {
  const conds = [eq(roleBindings.workspaceId, workspaceId)]
  if (filter.scopeKind) conds.push(eq(roleBindings.scopeKind, filter.scopeKind))
  if (filter.scopeId) conds.push(eq(roleBindings.scopeId, filter.scopeId))
  const rows = await ctx.kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(roleBindings)
      .where(and(...conds))
      .orderBy(asc(roleBindings.createdAt)),
  )
  return rows.map(serBinding)
}

export async function setBinding(
  ctx: Ctx,
  workspaceId: string,
  b: Omit<core.RoleBinding, 'id' | 'workspaceId'>,
): Promise<core.RoleBinding> {
  const { kernel } = ctx
  if (!b.roleId && !b.permissions.length) throw KernError.badRequest('Binding needs a roleId or permissions')
  const permissions = validatePermissions(kernel, b.permissions)
  if (b.scopeKind === 'workspace' && b.scopeId !== workspaceId)
    throw KernError.badRequest('workspace-scoped bindings must use the workspace id as scopeId')
  const row = await kernel.database.withWorkspace(workspaceId, async (tx) => {
    if (b.roleId) {
      const [r] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.id, b.roleId), eq(roles.workspaceId, workspaceId)))
        .limit(1)
      if (!r) throw KernError.notFound('Role')
    }
    // upsert on (subject, scope, role, deny)
    const conds = [
      eq(roleBindings.workspaceId, workspaceId),
      eq(roleBindings.subjectType, b.subjectType),
      eq(roleBindings.subjectId, b.subjectId),
      eq(roleBindings.scopeKind, b.scopeKind),
      eq(roleBindings.scopeId, b.scopeId),
      eq(roleBindings.deny, b.deny),
      b.roleId ? eq(roleBindings.roleId, b.roleId) : sql`${roleBindings.roleId} is null`,
    ]
    const [existing] = await tx
      .select()
      .from(roleBindings)
      .where(and(...conds))
      .limit(1)
    if (existing) {
      const [u] = await tx
        .update(roleBindings)
        .set({ permissions })
        .where(eq(roleBindings.id, existing.id))
        .returning()
      return u!
    }
    const [r] = await tx
      .insert(roleBindings)
      .values({
        workspaceId,
        subjectType: b.subjectType,
        subjectId: b.subjectId,
        roleId: b.roleId,
        permissions,
        scopeKind: b.scopeKind,
        scopeId: b.scopeId,
        deny: b.deny,
      })
      .returning()
    return r!
  })
  await permissionsChanged(
    kernel,
    workspaceId,
    b.subjectType === 'user' ? [b.subjectId] : null,
    ctx.principal.userId,
  )
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'binding', id: row.id, op: 'created' })
  return serBinding(row)
}

export async function deleteBinding(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  const { kernel } = ctx
  const row = await kernel.database.withWorkspace(workspaceId, async (tx) => {
    const [r] = await tx
      .delete(roleBindings)
      .where(and(eq(roleBindings.id, id), eq(roleBindings.workspaceId, workspaceId)))
      .returning()
    if (!r) throw KernError.notFound('Binding')
    return r
  })
  await permissionsChanged(
    kernel,
    workspaceId,
    row.subjectType === 'user' ? [row.subjectId] : null,
    ctx.principal.userId,
  )
  await kernel.realtime.change(workspaceId, { module: 'core', entity: 'binding', id, op: 'deleted' })
}

// ---------- AuthzStore (DB-backed) ----------
export async function customRolePermissions(
  kernel: Kernel,
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  const [m] = await kernel.database.db
    .select({ roleIds: memberships.roleIds })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1)
  if (!m?.roleIds.length) return []
  const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(and(eq(roles.workspaceId, workspaceId), inArray(roles.id, m.roleIds))),
  )
  return [...new Set(rows.flatMap((r) => r.permissions))]
}

export async function bindingsFor(
  kernel: Kernel,
  workspaceId: string,
  userId: string,
  groupIds: string[],
  role: string,
): Promise<Binding[]> {
  const subject = or(
    and(eq(roleBindings.subjectType, 'user'), eq(roleBindings.subjectId, userId)),
    and(eq(roleBindings.subjectType, 'builtin_role'), eq(roleBindings.subjectId, role)),
    groupIds.length
      ? and(eq(roleBindings.subjectType, 'group'), inArray(roleBindings.subjectId, groupIds))
      : sql`false`,
  )
  const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ b: roleBindings, rolePerms: roles.permissions })
      .from(roleBindings)
      .leftJoin(roles, eq(roles.id, roleBindings.roleId))
      .where(and(eq(roleBindings.workspaceId, workspaceId), subject)),
  )
  return rows.map((r) => ({
    subjectType: r.b.subjectType as Binding['subjectType'],
    subjectId: r.b.subjectId,
    permissions: [...new Set([...r.b.permissions, ...(r.rolePerms ?? [])])],
    scopeKind: r.b.scopeKind as Binding['scopeKind'],
    scopeId: r.b.scopeId,
    deny: r.b.deny,
  }))
}
