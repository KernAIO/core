import type { BuiltinRole, Principal } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { memberships, user } from '../schema/index.js'

export interface Ctx {
  kernel: Kernel
  principal: Principal
}

export const ROLE_RANK: Record<BuiltinRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 }
export const BUILTIN_ROLES: BuiltinRole[] = ['owner', 'admin', 'member', 'guest']

export function requireUser(principal: Principal): string {
  if (!principal.userId) throw KernError.unauthorized()
  return principal.userId
}
export function membershipOf(principal: Principal, workspaceId: string) {
  return principal.memberships.find((m) => m.workspaceId === workspaceId && m.status === 'active') ?? null
}
/** builtin role of the caller in a workspace (instance admins/services count as owner) */
export function callerRole(principal: Principal, workspaceId: string): BuiltinRole | null {
  if (principal.instanceAdmin || principal.kind === 'service') return 'owner'
  return membershipOf(principal, workspaceId)?.role ?? null
}
export function requireRole(principal: Principal, workspaceId: string, min: BuiltinRole) {
  const r = callerRole(principal, workspaceId)
  if (!r || ROLE_RANK[r] < ROLE_RANK[min]) throw KernError.forbidden()
  return r
}

/** Bump `permission_version` for users and broadcast `core.permissions.changed` (drops caches everywhere). */
export async function permissionsChanged(
  kernel: Kernel,
  workspaceId: string,
  userIds: string[] | null,
  actorId?: string | null,
) {
  const db = kernel.database.db
  if (userIds === null) {
    await db
      .update(user)
      .set({ permissionVersion: sql`${user.permissionVersion} + 1` })
      .where(
        inArray(
          user.id,
          db
            .select({ id: memberships.userId })
            .from(memberships)
            .where(eq(memberships.workspaceId, workspaceId)),
        ),
      )
  } else if (userIds.length) {
    await db
      .update(user)
      .set({ permissionVersion: sql`${user.permissionVersion} + 1` })
      .where(inArray(user.id, userIds))
  }
  await kernel.emit(
    coreEvents.permissionsChanged,
    { workspaceId: workspaceId as never, userIds: userIds as never },
    { workspaceId, actorId: actorId ?? null },
  )
}

export async function countOwners(kernel: Kernel, workspaceId: string): Promise<number> {
  const [r] = await kernel.database.db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
  return r?.n ?? 0
}

export const ilikeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
export const nowIso = () => new Date().toISOString()
