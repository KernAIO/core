import type { core } from '@kernhq/contracts'
import { type Binding, KernError, type Kernel } from '@kernhq/kernel'
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

/**
 * What a guest holds at workspace level before anything is given to it: nothing that belongs to a
 * project, a space or an object.
 *
 * A guest is the role a customer picks for an external contractor, and both surfaces that describe
 * it promise scoping — shell's `roles_builtin_guest` says "Sees only what they are explicitly
 * given". It was not true. `invitations.guestScopes` is validated, written onto the invitation and
 * the membership and serialised back, and **no authorization code anywhere reads it**; meanwhile
 * `tracker` gives `guest` five project-scoped defaults and `quire` three space-scoped ones, so
 * every guest could read and edit every project and every space in the workspace.
 *
 * The obvious repair — write a project-scoped `role_binding` per `guestScope` — changes nothing,
 * and it is worth writing down why. `Authz.can()` only consults narrow-scope bindings when the
 * *caller* asks at a narrow scope, and when it finds none it falls through to `effective()`, which
 * is the builtin defaults. `requires()`, which is what a module's list procedures use, always asks
 * at workspace scope. So an allow-binding on the one project a guest was given never restrains the
 * others: it grants what was already granted.
 *
 * The floor is the other half of that mechanism, and it is the half that bites. `effective()`
 * applies **workspace-scoped** bindings and honours `deny`, so one synthetic deny here removes every
 * project/space/object permission from a guest's workspace-level set — and `can()` at a project
 * scope still prefers an explicit binding there, because the chain it walks excludes workspace.
 * A guest with a project binding therefore reads that project and nothing else, which is what the
 * interface has been promising all along; a guest with no binding reads nothing, which is the
 * fail-closed answer and the right one to ship.
 *
 * Two deliberate limits:
 *
 * - **A custom role still grants.** The keys a member's own roles carry are excluded from the
 *   floor, because `effective()` adds them before it applies bindings and a blanket deny would
 *   silently undo an administrator's explicit grant. "Explicitly given" includes a role.
 * - **A scoped guest still cannot *list*.** `requires()` asks at workspace scope, so
 *   `tracker.projects.list` refuses a guest whatever bindings it holds. Fixing that means a module
 *   listing at workspace scope and filtering per project, which is a change in every module rather
 *   than here. Reading a named issue in a bound project already works.
 *
 * **This is no longer where the floor is enforced, and it never covered more than core.** The list
 * below is `allPermissions()` of the process that answers, which is always core — so it named
 * core's keys and the five modules core hosts, and a guest in `chat`, `mail` or `collab` was
 * restrained by nothing at all. `Authz.effective()` applies the floor locally now, from the defs of
 * whichever process is asking, so it covers every service by construction.
 *
 * What is left here is the rolling-deploy half. A service running an image older than that kernel
 * change still gets exactly the binding it gets today, so no restraint is removed while the two
 * versions run side by side; a service running the new kernel applies the same deletions twice,
 * which is idempotent. Once no supported image predates the local floor this function and its
 * synthetic binding can go.
 */
function guestFloor(kernel: Kernel, granted: ReadonlySet<string>): string[] {
  return kernel.authz
    .allPermissions()
    .filter((p) => p.scope !== 'workspace' && p.scope !== 'instance' && !granted.has(p.key))
    .map((p) => p.key)
}

/**
 * A guest scope is an object ref — `module:type:id`, e.g. `tracker:project:<uuid>`. `project` and
 * `space` are the two module hierarchies that have their own permission scope; everything else is
 * bound as an object, which is what a chat channel or a single document is.
 */
function guestScopeKind(type: string): Binding['scopeKind'] {
  return type === 'project' ? 'project' : type === 'space' ? 'space' : 'object'
}

/**
 * Turn the guest scopes a membership carries into the allow half of the guest model.
 *
 * The floor removes every project/space/object permission from a guest's workspace-level set. That
 * is the whole of the fail-closed half and, on its own, it means a guest reads nothing — which is
 * why `invitations.guestScopes` mattered: an administrator picks the projects an external
 * contractor may see, and until now that choice was validated, stored, serialised and read by no
 * authorization code anywhere. Nothing turned it into a grant.
 *
 * One binding per scope does. `Authz.can()` consults narrow-scope bindings before it falls through
 * to `effective()`, and the chain it walks excludes workspace, so a project-scoped allow survives
 * the workspace-scoped floor. That is a real read and not a decorative row: `tracker`'s
 * `issues.get` and `issues.query` carry no router-level `requires()` and check at project scope
 * through `AccessService`, so a guest bound to one project reads that project's issues and is
 * refused the others.
 *
 * What it grants is the module's own guest defaults **at that scope kind** — the keys the module
 * already says a guest should have, restored for the one project the administrator named. Deriving
 * them beats a hardcoded list for the same reason `permissionRegistry` does: the module owns its
 * permissions and a copy here would drift the first time one moved.
 *
 * Two things it deliberately does not do:
 *
 * - **A module core does not host gets no binding.** The keys come from `kernel.authz`, so a
 *   `chat:channel:<id>` scope finds nothing here and is skipped with a warning rather than written
 *   as an empty binding, which would read as a grant and be none. That is the same boundary the
 *   floor used to have, pointed the other way, and it is why the floor moved into the kernel: core
 *   can restrain nothing it cannot name, and it can grant nothing it cannot name either.
 * - **It does not let the guest list.** `tracker.projects.list` asks at workspace scope and refuses
 *   whatever bindings the guest holds. `issues.query` filters per project and does work.
 */
export async function applyGuestScopes(
  kernel: Kernel,
  workspaceId: string,
  userId: string,
  scopes: string[],
): Promise<number> {
  if (!scopes.length) return 0
  const defs = kernel.authz.allPermissions()
  let written = 0
  for (const scope of scopes) {
    const [moduleId, type, ...rest] = scope.split(':')
    const scopeId = rest.join(':')
    if (!moduleId || !type || !scopeId) {
      kernel.log.warn({ scope }, 'guest scope is not a module:type:id ref; no binding written')
      continue
    }
    const scopeKind = guestScopeKind(type)
    const permissions = defs
      .filter((p) => p.module === moduleId && p.scope === scopeKind && p.defaultRoles?.includes('guest'))
      .map((p) => p.key)
    if (!permissions.length) {
      kernel.log.warn(
        { scope, moduleId, scopeKind },
        'no guest-default permission at this scope is known to this process; no binding written',
      )
      continue
    }
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      const conds = [
        eq(roleBindings.workspaceId, workspaceId),
        eq(roleBindings.subjectType, 'user'),
        eq(roleBindings.subjectId, userId),
        eq(roleBindings.scopeKind, scopeKind),
        eq(roleBindings.scopeId, scopeId),
        eq(roleBindings.deny, false),
        sql`${roleBindings.roleId} is null`,
      ]
      const [existing] = await tx
        .select({ id: roleBindings.id })
        .from(roleBindings)
        .where(and(...conds))
        .limit(1)
      if (existing) await tx.update(roleBindings).set({ permissions }).where(eq(roleBindings.id, existing.id))
      else
        await tx.insert(roleBindings).values({
          workspaceId,
          subjectType: 'user',
          subjectId: userId,
          roleId: null,
          permissions,
          scopeKind,
          scopeId,
          deny: false,
        })
    })
    written++
  }
  return written
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
  const stored: Binding[] = rows.map((r) => ({
    subjectType: r.b.subjectType as Binding['subjectType'],
    subjectId: r.b.subjectId,
    permissions: [...new Set([...r.b.permissions, ...(r.rolePerms ?? [])])],
    scopeKind: r.b.scopeKind as Binding['scopeKind'],
    scopeId: r.b.scopeId,
    deny: r.b.deny,
  }))
  if (role !== 'guest') return stored
  const floor = guestFloor(kernel, new Set(await customRolePermissions(kernel, workspaceId, userId)))
  if (!floor.length) return stored
  // First, so a stored workspace-scoped allow for this guest is applied after it and wins:
  // `effective()` walks the list in order and the last word on a key is the one that counts.
  return [
    {
      subjectType: 'builtin_role',
      subjectId: 'guest',
      permissions: floor,
      scopeKind: 'workspace',
      scopeId: workspaceId,
      deny: true,
    },
    ...stored,
  ]
}
