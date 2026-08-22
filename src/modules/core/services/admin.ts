import type { core, Page } from '@kernaio/contracts'
import { KernError, type Kernel } from '@kernaio/kernel'
import { and, asc, desc, eq, gt, ne, or, sql } from 'drizzle-orm'
import { decodeCursor, encodeCursor, paginate } from '../lib/cursor.js'
import { serUser, serWorkspace } from '../lib/ser.js'
import { instanceSettings, memberships, user, workspaces } from '../schema/index.js'
import { type Ctx, ilikeEscape } from './common.js'

const INSTANCE_KEY = 'instance'

export async function getInstanceSetting<T>(kernel: Kernel, key: string): Promise<T | null> {
  const [row] = await kernel.database.db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1)
  return (row?.value as T) ?? null
}
export async function setInstanceSetting(kernel: Kernel, key: string, value: unknown): Promise<void> {
  await kernel.database.db
    .insert(instanceSettings)
    .values({ key, value: value as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: value as never, updatedAt: new Date() },
    })
}

export async function getInstanceSettings(kernel: Kernel): Promise<core.InstanceSettings> {
  const stored = (await getInstanceSetting<Partial<core.InstanceSettings>>(kernel, INSTANCE_KEY)) ?? {}
  const { InstanceSettings } = await import('@kernaio/contracts/core')
  return InstanceSettings.parse({ baseUrl: kernel.env.KERN_BASE_URL, ...stored })
}

export function requireInstanceAdmin(ctx: Ctx) {
  if (!ctx.principal.instanceAdmin && ctx.principal.kind !== 'service')
    throw KernError.forbidden('core.instance.admin')
}

export async function updateSettings(
  ctx: Ctx,
  patch: Partial<core.InstanceSettings>,
): Promise<core.InstanceSettings> {
  requireInstanceAdmin(ctx)
  const current = await getInstanceSettings(ctx.kernel)
  const next = { ...current, ...patch }
  await setInstanceSetting(ctx.kernel, INSTANCE_KEY, next)
  return next
}

export async function listUsers(
  ctx: Ctx,
  input: { q?: string; cursor?: string; limit: number },
): Promise<Page<core.User>> {
  requireInstanceAdmin(ctx)
  const cur = decodeCursor(input.cursor)
  const conds = [ne(user.status, 'deleted')]
  if (input.q) {
    const q = `%${ilikeEscape(input.q)}%`
    conds.push(
      or(sql`${user.name} ilike ${q}`, sql`${user.email} ilike ${q}`, sql`${user.username} ilike ${q}`)!,
    )
  }
  if (cur) conds.push(gt(user.id, cur.id))
  const rows = await ctx.kernel.database.db
    .select()
    .from(user)
    .where(and(...conds))
    .orderBy(asc(user.id))
    .limit(input.limit + 1)
  const [{ n } = { n: 0 }] = await ctx.kernel.database.db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(ne(user.status, 'deleted'))
  const page = paginate(rows, input.limit, (r) => encodeCursor(null, r.id))
  return { items: page.items.map(serUser), nextCursor: page.nextCursor, total: n }
}

export async function setUserStatus(
  ctx: Ctx,
  input: { id: string; status: 'active' | 'suspended'; instanceAdmin?: boolean },
): Promise<core.User> {
  requireInstanceAdmin(ctx)
  const set: Partial<typeof user.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
    permissionVersion: sql`${user.permissionVersion} + 1` as never,
  }
  if (input.instanceAdmin !== undefined) {
    if (input.id === ctx.principal.userId && input.instanceAdmin === false)
      throw KernError.conflict('You cannot remove your own instance admin flag', 'core.admin.self')
    set.instanceAdmin = input.instanceAdmin
    set.role = input.instanceAdmin ? 'admin' : 'user'
  }
  if (input.status === 'suspended' && input.id === ctx.principal.userId)
    throw KernError.conflict('You cannot suspend yourself', 'core.admin.self')
  const [u] = await ctx.kernel.database.db.update(user).set(set).where(eq(user.id, input.id)).returning()
  if (!u) throw KernError.notFound('User')
  if (input.status === 'suspended') {
    // revoke all sessions
    await ctx.kernel.database.db.execute(sql`delete from mod_core.sessions where user_id = ${input.id}`)
  }
  return serUser(u)
}

export async function listWorkspaces(
  ctx: Ctx,
  input: { cursor?: string; limit: number },
): Promise<Page<core.Workspace & { memberCount: number }>> {
  requireInstanceAdmin(ctx)
  const cur = decodeCursor(input.cursor)
  const rows = await ctx.kernel.database.db
    .select({
      w: workspaces,
      n: sql<number>`(select count(*)::int from ${memberships} m where m.workspace_id = ${workspaces.id} and m.status = 'active')`,
    })
    .from(workspaces)
    .where(cur ? gt(workspaces.id, cur.id) : undefined)
    .orderBy(asc(workspaces.id))
    .limit(input.limit + 1)
  const page = paginate(rows, input.limit, (r) => encodeCursor(null, r.w.id))
  return {
    items: page.items.map((r) => ({ ...serWorkspace(r.w), memberCount: r.n })),
    nextCursor: page.nextCursor,
  }
}

export function listModules(ctx: Ctx) {
  requireInstanceAdmin(ctx)
  return ctx.kernel.manifests().map((m) => ({ ...m, host: ctx.kernel.service, healthy: true }))
}

export { desc }
