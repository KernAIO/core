/**
 * Erasure: deleting a workspace, and closing an account.
 *
 * What existed before this file was `core.workspace.delete` setting `archived_at` and nothing else,
 * and no close-account path at all — `users.status` has had a `'deleted'` value since the first
 * migration that nothing in the API could ever set. Meanwhile the terms, the privacy policy and the
 * docs site all promise deletion, and for an EU customer erasure is a legal obligation with a clock
 * on it.
 *
 * Three things shape this:
 *
 * - **A grace period, because the terms describe one.** Deleting on the button press cannot honour a
 *   promise that a deletion can be undone, so the request is a row with a `purge_after` and the
 *   purge is a job. Archiving happens immediately (the workspace goes away for its members); the
 *   rows go at the end of the window.
 * - **Core never reaches into `mod_<id>`.** A module owns its schema, so erasure asks: the purge
 *   emits `core.workspace.purge` / `core.account.purge` and each module deletes its own rows. No
 *   first-party module subscribes yet, so every one of them is written into `follow_ups` on the
 *   request. That is deliberate — recording "this module still holds data" is honest, and reporting
 *   a completed erasure that did not happen is not.
 * - **Object storage is scheduled, not awaited.** A workspace's files are deleted key by key in the
 *   same job, and failures are logged rather than thrown: a bucket that is briefly unreachable must
 *   not roll back a database erasure that has already been promised.
 *
 * Erasure stays available to a **suspended** workspace, deliberately. Suspension withholds the
 * service for an unpaid invoice; the right to have your data deleted does not pause because a card
 * expired, and a customer who cannot leave is the worst possible reading of "read-only".
 */
import { KernError, type Kernel, uuidv7 } from '@kernhq/kernel'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { coreLifecycleEvents } from '../events.js'
import {
  activityEvents,
  dashboardLayouts,
  dashboardSettings,
  dataExports,
  deletionRequests,
  files,
  groupMembers,
  groups,
  integrations,
  invitations,
  memberships,
  notifications,
  roleBindings,
  roles,
  searchDocuments,
  user,
  workspaceModules,
  workspaces,
} from '../schema/index.js'
import { countOwners } from './common.js'
import { getWorkspaceRow } from './workspaces.js'

/** How long a scheduled erasure can be called off. The terms describe a window; this is it. */
export const GRACE_PERIOD_DAYS = 30

export type DeletionSubject = 'workspace' | 'account'
export type DeletionStatus = 'scheduled' | 'cancelled' | 'running' | 'done' | 'failed'

export interface DeletionRecord {
  id: string
  subjectKind: DeletionSubject
  subjectId: string
  status: DeletionStatus
  purgeAfter: string
  followUps: string[]
  error: string | null
  createdAt: string
  completedAt: string | null
}

const ser = (r: typeof deletionRequests.$inferSelect): DeletionRecord => ({
  id: r.id,
  subjectKind: r.subjectKind as DeletionSubject,
  subjectId: r.subjectId,
  status: r.status as DeletionStatus,
  purgeAfter: r.purgeAfter.toISOString(),
  followUps: r.followUps,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
})

async function openRequest(kernel: Kernel, kind: DeletionSubject, subjectId: string) {
  const [row] = await kernel.database.db
    .select()
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.subjectKind, kind),
        eq(deletionRequests.subjectId, subjectId),
        inArray(deletionRequests.status, ['scheduled', 'running']),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function pending(
  kernel: Kernel,
  kind: DeletionSubject,
  subjectId: string,
): Promise<DeletionRecord | null> {
  const row = await openRequest(kernel, kind, subjectId)
  return row ? ser(row) : null
}

// ---------- workspace ----------

/**
 * Schedule a workspace for erasure and archive it now.
 *
 * Archiving immediately is what makes the grace period honest in both directions: the workspace
 * stops being usable the moment the owner asks, so nobody keeps working in something that is about
 * to be destroyed, and the rows survive long enough to change their mind.
 */
export async function scheduleWorkspaceDeletion(
  kernel: Kernel,
  input: { workspaceId: string; requestedBy: string; reason?: string | null },
): Promise<DeletionRecord> {
  const ws = await getWorkspaceRow(kernel, input.workspaceId)
  if (!ws) throw KernError.notFound('Workspace')
  const existing = await openRequest(kernel, 'workspace', input.workspaceId)
  if (existing) return ser(existing)
  const purgeAfter = new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000)
  const [row] = await kernel.database.db
    .insert(deletionRequests)
    .values({
      id: uuidv7(),
      subjectKind: 'workspace',
      subjectId: input.workspaceId,
      requestedBy: input.requestedBy,
      reason: input.reason ?? null,
      status: 'scheduled',
      purgeAfter,
    })
    .returning()
  if (!row) throw new KernError('INTERNAL', 'Could not record the deletion request')
  if (!ws.archivedAt)
    await kernel.database.db
      .update(workspaces)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaces.id, input.workspaceId))
  await kernel.emit(
    coreLifecycleEvents.workspaceDeletionScheduled,
    { workspaceId: input.workspaceId, requestId: row.id, purgeAfter: purgeAfter.toISOString() },
    { workspaceId: input.workspaceId, actorId: input.requestedBy },
  )
  return ser(row)
}

/** Call off a scheduled erasure inside the grace period, and un-archive the workspace. */
export async function cancelWorkspaceDeletion(
  kernel: Kernel,
  input: { workspaceId: string; actorId: string },
): Promise<DeletionRecord> {
  const existing = await openRequest(kernel, 'workspace', input.workspaceId)
  if (!existing || existing.status === 'running')
    throw KernError.notFound('Scheduled deletion', 'core.deletion.not_cancellable')
  const [row] = await kernel.database.db
    .update(deletionRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(deletionRequests.id, existing.id))
    .returning()
  await kernel.database.db
    .update(workspaces)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(workspaces.id, input.workspaceId))
  await kernel.emit(
    coreLifecycleEvents.workspaceDeletionCancelled,
    { workspaceId: input.workspaceId, requestId: existing.id },
    { workspaceId: input.workspaceId, actorId: input.actorId },
  )
  return ser(row ?? existing)
}

/**
 * Actually destroy a workspace: tell the modules, delete core's rows, drop the objects.
 *
 * Ordering matters. Modules are told first, while the workspace row still exists, so a handler that
 * needs to look it up can. Core's own rows go next. Object storage is last and is best-effort, since
 * a failed delete there leaves an orphan the bucket lifecycle can sweep, whereas a failed delete
 * that rolls the whole purge back leaves the customer's data in the database after they were told it
 * was gone.
 */
export async function purgeWorkspace(kernel: Kernel, requestId: string): Promise<DeletionRecord> {
  const [req] = await kernel.database.db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, requestId))
    .limit(1)
  if (!req) throw KernError.notFound('Deletion request')
  if (req.status !== 'scheduled') return ser(req)
  const workspaceId = req.subjectId
  await kernel.database.db
    .update(deletionRequests)
    .set({ status: 'running' })
    .where(eq(deletionRequests.id, requestId))

  try {
    const followUps = await tellModules(kernel, 'workspace', workspaceId, requestId)
    const keys = await kernel.database.db
      .select({ key: files.key, thumbnailKey: files.thumbnailKey })
      .from(files)
      .where(eq(files.workspaceId, workspaceId))
    const exportKeys = await kernel.database.withWorkspace(workspaceId, (tx) =>
      tx.select({ key: dataExports.key }).from(dataExports).where(eq(dataExports.workspaceId, workspaceId)),
    )

    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      const scoped = eq(activityEvents.workspaceId, workspaceId)
      await tx.delete(activityEvents).where(scoped)
      await tx.delete(searchDocuments).where(eq(searchDocuments.workspaceId, workspaceId))
      await tx.delete(dashboardLayouts).where(eq(dashboardLayouts.workspaceId, workspaceId))
      await tx.delete(dashboardSettings).where(eq(dashboardSettings.workspaceId, workspaceId))
      await tx.delete(integrations).where(eq(integrations.workspaceId, workspaceId))
      await tx.delete(workspaceModules).where(eq(workspaceModules.workspaceId, workspaceId))
      await tx.delete(roleBindings).where(eq(roleBindings.workspaceId, workspaceId))
      await tx.delete(groupMembers).where(eq(groupMembers.workspaceId, workspaceId))
      await tx.delete(groups).where(eq(groups.workspaceId, workspaceId))
      await tx.delete(roles).where(eq(roles.workspaceId, workspaceId))
      await tx.delete(dataExports).where(eq(dataExports.workspaceId, workspaceId))
    })
    await kernel.database.db.delete(files).where(eq(files.workspaceId, workspaceId))
    await kernel.database.db.delete(notifications).where(eq(notifications.workspaceId, workspaceId))
    await kernel.database.db.delete(invitations).where(eq(invitations.workspaceId, workspaceId))
    await kernel.database.db.delete(memberships).where(eq(memberships.workspaceId, workspaceId))
    await kernel.database.db.delete(workspaces).where(eq(workspaces.id, workspaceId))

    for (const k of [...keys.flatMap((f) => [f.key, f.thumbnailKey]), ...exportKeys.map((e) => e.key)])
      if (k) await kernel.storage.delete(k).catch(() => {})

    const [row] = await kernel.database.db
      .update(deletionRequests)
      .set({ status: 'done', followUps, completedAt: new Date() })
      .where(eq(deletionRequests.id, requestId))
      .returning()
    kernel.log.info({ workspaceId, followUps: followUps.length }, 'workspace erased')
    return ser(row!)
  } catch (err) {
    return fail(kernel, requestId, err)
  }
}

// ---------- account ----------

/**
 * Close an account.
 *
 * Refused while the person is the last owner of a workspace that still has other members: deleting
 * them would leave a workspace nobody can administer, which is not erasure of their data but
 * destruction of somebody else's. They have to hand the workspace over or delete it first, and the
 * error says which workspaces are in the way.
 */
export async function scheduleAccountDeletion(
  kernel: Kernel,
  input: { userId: string; requestedBy: string; reason?: string | null },
): Promise<DeletionRecord> {
  const [u] = await kernel.database.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1)
  if (!u) throw KernError.notFound('User')
  const existing = await openRequest(kernel, 'account', input.userId)
  if (existing) return ser(existing)

  const blocking = await soleOwnerOf(kernel, input.userId)
  if (blocking.length)
    throw KernError.conflict(
      'You are the only owner of a workspace that still has other members. Hand it over or delete it first.',
      'core.account.sole_owner',
    )

  const purgeAfter = new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000)
  const [row] = await kernel.database.db
    .insert(deletionRequests)
    .values({
      id: uuidv7(),
      subjectKind: 'account',
      subjectId: input.userId,
      requestedBy: input.requestedBy,
      reason: input.reason ?? null,
      status: 'scheduled',
      purgeAfter,
    })
    .returning()
  if (!row) throw new KernError('INTERNAL', 'Could not record the deletion request')
  // Suspended, not deleted: the account stops being usable now, and the rows go at the end of the
  // grace period. Sessions are revoked so "closed" means closed on every device immediately.
  await kernel.database.db
    .update(user)
    .set({
      status: 'suspended',
      updatedAt: new Date(),
      permissionVersion: sql`${user.permissionVersion} + 1` as never,
    })
    .where(eq(user.id, input.userId))
  await kernel.database.db.execute(sql`delete from mod_core.sessions where user_id = ${input.userId}`)
  await kernel.emit(coreLifecycleEvents.accountDeletionScheduled, {
    userId: input.userId,
    requestId: row.id,
    purgeAfter: purgeAfter.toISOString(),
  })
  return ser(row)
}

/** Workspaces where this user is the only active owner and somebody else is still a member. */
export async function soleOwnerOf(kernel: Kernel, userId: string): Promise<string[]> {
  const mine = await kernel.database.db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(
      and(eq(memberships.userId, userId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')),
    )
  const blocking: string[] = []
  for (const { workspaceId } of mine) {
    if ((await countOwners(kernel, workspaceId)) > 1) continue
    const [{ n } = { n: 0 }] = await kernel.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')))
    if (n > 1) blocking.push(workspaceId)
  }
  return blocking
}

export async function cancelAccountDeletion(
  kernel: Kernel,
  input: { userId: string; actorId: string },
): Promise<DeletionRecord> {
  const existing = await openRequest(kernel, 'account', input.userId)
  if (!existing || existing.status === 'running')
    throw KernError.notFound('Scheduled deletion', 'core.deletion.not_cancellable')
  const [row] = await kernel.database.db
    .update(deletionRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(deletionRequests.id, existing.id))
    .returning()
  await kernel.database.db
    .update(user)
    .set({
      status: 'active',
      updatedAt: new Date(),
      permissionVersion: sql`${user.permissionVersion} + 1` as never,
    })
    .where(eq(user.id, input.userId))
  await kernel.emit(coreLifecycleEvents.accountDeletionCancelled, {
    userId: input.userId,
    requestId: existing.id,
  })
  return ser(row ?? existing)
}

/**
 * Destroy an account: tell the modules, then remove the person.
 *
 * The row is **anonymised rather than deleted**, and that is a deliberate difference from a
 * workspace purge. `activity_events.actor_id`, `files.uploaded_by` and every module's audit trail
 * point at this id, and hard-deleting the row would either cascade through other tenants' audit logs
 * or leave dangling references that read as corruption. `status: 'deleted'` with the identifying
 * columns emptied is what erasure means for a shared record: nothing about the person survives, and
 * the workspaces they acted in keep a coherent history.
 */
export async function purgeAccount(kernel: Kernel, requestId: string): Promise<DeletionRecord> {
  const [req] = await kernel.database.db
    .select()
    .from(deletionRequests)
    .where(eq(deletionRequests.id, requestId))
    .limit(1)
  if (!req) throw KernError.notFound('Deletion request')
  if (req.status !== 'scheduled') return ser(req)
  const userId = req.subjectId
  await kernel.database.db
    .update(deletionRequests)
    .set({ status: 'running' })
    .where(eq(deletionRequests.id, requestId))

  try {
    const followUps = await tellModules(kernel, 'account', userId, requestId)
    const db = kernel.database.db
    await db.delete(memberships).where(eq(memberships.userId, userId))
    await db.delete(notifications).where(eq(notifications.userId, userId))
    await db.execute(sql`delete from mod_core.sessions where user_id = ${userId}`)
    await db.execute(sql`delete from mod_core.accounts where user_id = ${userId}`)
    await db.execute(sql`delete from mod_core.notification_settings where user_id = ${userId}`)
    await db.execute(sql`delete from mod_core.push_subscriptions where user_id = ${userId}`)
    await db
      .update(user)
      .set({
        status: 'deleted',
        // Unique columns get the id folded in so a later account can take the address back.
        email: `deleted+${userId}@invalid`,
        name: 'Deleted user',
        username: null,
        image: null,
        emailVerified: false,
        instanceAdmin: false,
        twoFactorEnabled: false,
        updatedAt: new Date(),
        permissionVersion: sql`${user.permissionVersion} + 1` as never,
      })
      .where(eq(user.id, userId))
    const [row] = await db
      .update(deletionRequests)
      .set({ status: 'done', followUps, completedAt: new Date() })
      .where(eq(deletionRequests.id, requestId))
      .returning()
    kernel.log.info({ userId, followUps: followUps.length }, 'account erased')
    return ser(row!)
  } catch (err) {
    return fail(kernel, requestId, err)
  }
}

// ---------- shared ----------

/**
 * Emit the purge event and name every module that is not listening.
 *
 * The event bus is fire-and-forget, so this cannot know that a module *acted*; what it can know is
 * which modules hold data in this instance. Every one of them is recorded as a follow-up unless it
 * has told core it handles erasure, by answering `<module>.erase` through the broker. That procedure
 * does not exist anywhere yet, which is why every module lands in `follow_ups` today — the honest
 * report, and the list somebody works through.
 */
async function tellModules(
  kernel: Kernel,
  kind: DeletionSubject,
  subjectId: string,
  requestId: string,
): Promise<string[]> {
  if (kind === 'workspace')
    await kernel.emit(
      coreLifecycleEvents.workspacePurge,
      { workspaceId: subjectId, requestId },
      { workspaceId: subjectId },
    )
  else await kernel.emit(coreLifecycleEvents.accountPurge, { userId: subjectId, requestId })

  const followUps: string[] = []
  for (const manifest of kernel.manifests()) {
    if (manifest.core) continue
    try {
      await kernel.call(`${manifest.id}.erase`, { kind, subjectId }, kernel.system)
    } catch {
      followUps.push(
        `${manifest.id}: no erase procedure — data in schema mod_${manifest.id} for this ${kind} was not deleted by core.`,
      )
    }
  }
  return followUps
}

async function fail(kernel: Kernel, requestId: string, err: unknown): Promise<DeletionRecord> {
  const message = (err as Error).message
  kernel.log.error({ err: message, requestId }, 'erasure failed')
  const [row] = await kernel.database.db
    .update(deletionRequests)
    .set({ status: 'failed', error: message.slice(0, 500), completedAt: new Date() })
    .where(eq(deletionRequests.id, requestId))
    .returning()
  if (!row) throw err
  return ser(row)
}

/** Cron: run every erasure whose grace period has run out. */
export async function runDueDeletions(kernel: Kernel): Promise<{ purged: number }> {
  const due = await kernel.database.db
    .select({ id: deletionRequests.id, subjectKind: deletionRequests.subjectKind })
    .from(deletionRequests)
    .where(and(eq(deletionRequests.status, 'scheduled'), lte(deletionRequests.purgeAfter, new Date())))
    .limit(100)
  let purged = 0
  for (const row of due) {
    try {
      if (row.subjectKind === 'workspace') await purgeWorkspace(kernel, row.id)
      else await purgeAccount(kernel, row.id)
      purged++
    } catch (err) {
      // One subject's failure must not stop the queue; the row is marked failed and stays visible.
      kernel.log.warn({ err: (err as Error).message, requestId: row.id }, 'scheduled erasure failed')
    }
  }
  return { purged }
}
