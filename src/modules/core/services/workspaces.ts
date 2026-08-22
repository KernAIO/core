import type { BuiltinRole, core } from '@kernalo/contracts'
import { coreEvents } from '@kernalo/contracts/core'
import { KernError, type Kernel } from '@kernalo/kernel'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { serWorkspace } from '../lib/ser.js'
import { memberships, roles, workspaces } from '../schema/index.js'
import { getInstanceSettings } from './admin.js'
import { BUILTIN_ROLES, type Ctx, callerRole, permissionsChanged, requireUser } from './common.js'
import { workspaceSummaries } from './users.js'

export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'app',
  'auth',
  'invite',
  'login',
  'signup',
  'settings',
  'new',
  'www',
  'kern',
  'static',
  '_',
  'ws',
])
export const SlugInput = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)

export function validateSlug(slug: string) {
  if (!SlugInput.safeParse(slug).success) throw KernError.badRequest('Invalid slug', { slug })
  if (RESERVED_SLUGS.has(slug)) throw KernError.conflict('Slug is reserved', 'core.workspace.slug_reserved')
}
/** derive a slug from a name: lowercase, dashes, trimmed */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export async function getWorkspaceRow(kernel: Kernel, id: string) {
  const [w] = await kernel.database.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  return w ?? null
}
export async function requireWorkspace(kernel: Kernel, id: string) {
  const w = await getWorkspaceRow(kernel, id)
  if (!w) throw KernError.notFound('Workspace')
  return w
}

export async function list(ctx: Ctx): Promise<core.WorkspaceSummary[]> {
  return workspaceSummaries(ctx, requireUser(ctx.principal))
}

export async function create(
  ctx: Ctx,
  input: { name: string; slug: string; description?: string },
): Promise<core.Workspace> {
  const userId = requireUser(ctx.principal)
  const { kernel } = ctx
  validateSlug(input.slug)
  const settings = await getInstanceSettings(kernel)
  if (settings.allowWorkspaceCreation === 'admins' && !ctx.principal.instanceAdmin)
    throw KernError.forbidden('core.workspace.create')
  const db = kernel.database.db
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, input.slug))
    .limit(1)
  if (existing.length) throw KernError.conflict('Slug is taken', 'core.workspace.slug_taken')

  const row = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(workspaces)
      .values({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        createdBy: userId,
      })
      .returning()
    if (!w) throw new KernError('INTERNAL', 'Workspace insert failed')
    await tx.insert(memberships).values({ workspaceId: w.id, userId, role: 'owner', status: 'active' })
    // builtin role rows (read-only mirrors of the kernel defaults so UIs can list/inspect them)
    await tx.execute(sql`select set_config('app.workspace_id', ${w.id}, true)`)
    await tx.insert(roles).values(
      BUILTIN_ROLES.map((r) => ({
        workspaceId: w.id,
        name: r.charAt(0).toUpperCase() + r.slice(1),
        description: `Built-in ${r} role`,
        permissions: kernel.authz.defaultsFor(r),
        builtin: true,
        builtinKey: r,
      })),
    )
    return w
  })
  await permissionsChanged(kernel, row.id, [userId], userId)
  await kernel.emit(
    coreEvents.workspaceCreated,
    { workspaceId: row.id as never, slug: row.slug, createdBy: userId as never },
    { workspaceId: row.id, actorId: userId },
  )
  await kernel.emit(
    coreEvents.memberJoined,
    { workspaceId: row.id as never, userId: userId as never, role: 'owner' },
    { workspaceId: row.id, actorId: userId },
  )
  for (const mod of kernel.registry.all()) await mod.onWorkspaceEnabled?.(row.id, kernel)
  return serWorkspace(row)
}

export async function get(ctx: Ctx, workspaceId: string): Promise<core.Workspace> {
  return serWorkspace(await requireWorkspace(ctx.kernel, workspaceId))
}

export async function update(
  ctx: Ctx,
  workspaceId: string,
  patch: z.infer<typeof core.UpdateWorkspace>,
): Promise<core.Workspace> {
  const { kernel } = ctx
  await requireWorkspace(kernel, workspaceId)
  const set: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.description !== undefined) set.description = patch.description
  if (patch.logoUrl !== undefined) set.logoUrl = patch.logoUrl
  if (patch.accentColor !== undefined) set.accentColor = patch.accentColor
  if (patch.autoJoinDomains !== undefined)
    set.autoJoinDomains = patch.autoJoinDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (patch.defaultRole !== undefined) {
    if (patch.defaultRole === 'owner') throw KernError.badRequest('Default role cannot be owner')
    set.defaultRole = patch.defaultRole
  }
  const [w] = await kernel.database.db
    .update(workspaces)
    .set(set)
    .where(eq(workspaces.id, workspaceId))
    .returning()
  if (!w) throw KernError.notFound('Workspace')
  await kernel.emit(
    coreEvents.workspaceUpdated,
    { workspaceId: workspaceId as never, fields: Object.keys(patch) },
    { workspaceId, actorId: ctx.principal.userId },
  )
  await kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'workspace',
    id: workspaceId,
    op: 'updated',
  })
  return serWorkspace(w)
}

export async function archive(ctx: Ctx, workspaceId: string): Promise<core.Workspace> {
  const { kernel } = ctx
  const [w] = await kernel.database.db
    .update(workspaces)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspaceId)))
    .returning()
  if (!w) throw KernError.notFound('Workspace')
  await kernel.emit(
    coreEvents.workspaceArchived,
    { workspaceId: workspaceId as never },
    { workspaceId, actorId: ctx.principal.userId },
  )
  await kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'workspace',
    id: workspaceId,
    op: 'updated',
    patch: { archivedAt: w.archivedAt?.toISOString() },
  })
  return serWorkspace(w)
}

export async function myPermissions(
  ctx: Ctx,
  workspaceId: string,
): Promise<{ role: string; permissions: string[]; version: number }> {
  const role: BuiltinRole | null = callerRole(ctx.principal, workspaceId)
  if (!role) throw KernError.forbidden()
  const set = await ctx.kernel.authz.effective(ctx.principal, workspaceId)
  return { role, permissions: [...set].sort(), version: ctx.principal.permissionVersion }
}
