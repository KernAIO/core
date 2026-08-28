import type { BuiltinRole, core } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { serWorkspace } from '../lib/ser.js'
import { memberships, roles, user, workspaces } from '../schema/index.js'
import { getInstanceSettings } from './admin.js'
import {
  BUILTIN_ROLES,
  type Ctx,
  callerRole,
  ilikeEscape,
  permissionsChanged,
  requireUser,
} from './common.js'
import { workspaceSummaries } from './users.js'

/**
 * Slugs a workspace may not take.
 *
 * A workspace lives at `/<slug>`, and the app puts a handful of its own pages at that same level —
 * `/sign-in`, `/workspaces`, `/onboarding` and the rest. SvelteKit prefers the static route, so a
 * workspace called "workspaces" would exist and simply never open. Every top-level route in
 * `repos/shell/src/routes` belongs here; add the name in the commit that adds the route.
 */
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
  // top-level pages in the app
  'sign-in',
  'sign-up',
  'forgot',
  'reset',
  'two-factor',
  'onboarding',
  'workspaces',
  'request',
  // MCP consent screen: an AI client lands here from /api/mcp/oauth/authorize
  'authorize',
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

/**
 * Every workspace on the instance, as identity only.
 *
 * Service-to-service, and thin on purpose: another module holds workspace ids and needs names to put
 * beside them, which is not a reason to hand it membership or settings. Archived workspaces are
 * included — an operator still has to see what an archived workspace was costing.
 */
export async function listAll(
  kernel: Kernel,
  input: { q?: string; limit: number },
): Promise<Array<{ id: string; name: string; slug: string; archivedAt: string | null }>> {
  const rows = await kernel.database.db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(input.q ? sql`${workspaces.name} ilike ${`%${ilikeEscape(input.q)}%`}` : undefined)
    .orderBy(workspaces.name)
    .limit(input.limit)
  return rows.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null }))
}

export async function list(ctx: Ctx): Promise<core.WorkspaceSummary[]> {
  return workspaceSummaries(ctx, requireUser(ctx.principal))
}

/**
 * A workspace needs a proven email address behind it.
 *
 * `requireEmailVerification` is off for sign-in on purpose — being unable to read your mail should
 * not lock you out of an account you already have — but that left the whole tenant-creating path
 * open to an address nobody had ever confirmed: on Kern Cloud, any string with an `@` in it got a
 * workspace instantly, with a slug, storage and an invitation form attached to it.
 *
 * Verification, not registration, is the gate — Kern Cloud keeps sign-up open. An invited person is
 * verified by their invitation (see `invitations.accept`), so this never stands between somebody and
 * the workspace they were asked to join; it only stands in front of creating a new one. Instance
 * admins and services pass: an operator restoring a tenant is not the case this is about.
 */
async function requireVerifiedEmail(ctx: Ctx): Promise<void> {
  const p = ctx.principal
  if (p.instanceAdmin || p.kind === 'service') return
  const [me] = await ctx.kernel.database.db
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, requireUser(p)))
    .limit(1)
  if (me?.emailVerified) return
  throw KernError.forbidden('core.workspace.email_unverified')
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
  await requireVerifiedEmail(ctx)
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
