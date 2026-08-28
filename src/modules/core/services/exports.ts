/**
 * Taking a copy of a workspace's data out of Kern.
 *
 * `core.export.run` has been a permission key in `@kernhq/contracts` with nothing behind it, while
 * the terms, the privacy policy, the docs site and the billing module's own suspension copy ("keeps
 * their sign-in and can read and export what is theirs") all promise the feature. For an EU customer
 * portability is not a feature at all, it is an obligation.
 *
 * Two things shape the implementation:
 *
 * - **Core exports core's data, and asks every module for the rest.** A module owns its `mod_<id>`
 *   schema and core must never read it; the export therefore calls `<module>.export` through the
 *   broker for each module enabled in the workspace. No module implements that procedure yet, so
 *   today every one of them lands in `followUps` — which is the honest outcome. Silently shipping an
 *   archive that says "export" and contains only core's rows would be worse than the missing
 *   feature, because the customer would believe they had their data.
 * - **Files are a manifest, not bytes.** A workspace's attachments can be hundreds of gigabytes;
 *   streaming them into one archive turns a background job into an outage. The manifest carries
 *   every file's id, name, size, checksum and storage key, and each one is downloadable through the
 *   API the app already uses.
 *
 * An export is reachable **while a workspace is suspended** — see `httpRoutes` in
 * `src/modules/core/index.ts` for how, and ADR 0003 §6 for why.
 */

import { gzipSync } from 'node:zlib'
import { KernError, type Kernel, NO_RESPONDERS, uuidv7 } from '@kernhq/kernel'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { coreLifecycleEvents } from '../events.js'
import {
  activityEvents,
  dashboardLayouts,
  dashboardSettings,
  dataExports,
  files,
  groupMembers,
  groups,
  invitations,
  memberships,
  roleBindings,
  roles,
  searchDocuments,
  user,
  workspaceModules,
} from '../schema/index.js'
import { getWorkspaceRow } from './workspaces.js'

/** How long a finished export stays downloadable before the cleanup pass removes it. */
export const EXPORT_TTL_HOURS = 72
/** Activity rows carried in an export. An audit log can be millions of rows; this is the recent tail. */
const ACTIVITY_LIMIT = 50_000
/** Format version of the archive, so a reader can tell what it is looking at. */
const FORMAT = 'kern.workspace-export/1'

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired'

export interface ExportRecord {
  id: string
  workspaceId: string
  status: ExportStatus
  sizeBytes: number | null
  followUps: string[]
  error: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

const ser = (r: typeof dataExports.$inferSelect): ExportRecord => ({
  id: r.id,
  workspaceId: r.workspaceId,
  status: r.status as ExportStatus,
  sizeBytes: r.sizeBytes,
  followUps: r.followUps,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
})

/** Storage key of an export, under the workspace's own prefix so a purge by prefix takes it too. */
export const exportKey = (workspaceId: string, id: string) => `ws/${workspaceId}/core/exports/${id}.json.gz`

/**
 * Record the request and hand the work to a job.
 *
 * Deliberately not done inline: an export reads every table a workspace has, and holding an HTTP
 * request open for it would time out on exactly the large workspaces that most need one.
 */
export async function request(
  kernel: Kernel,
  input: { workspaceId: string; requestedBy: string },
): Promise<ExportRecord> {
  const ws = await getWorkspaceRow(kernel, input.workspaceId)
  if (!ws) throw KernError.notFound('Workspace')
  /**
   * One build at a time, and the caller gets the one already running.
   *
   * An export is a copy of the *whole* workspace in the bucket. Two clicks on a button that answers
   * 202 and then appears to do nothing would put two of them there and read every table twice — on
   * exactly the large workspaces where that costs the most. A finished export is not in the way: an
   * owner who wants a fresh one after the last is `ready` gets a new row.
   */
  const [open] = await kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .select()
      .from(dataExports)
      .where(
        and(
          eq(dataExports.workspaceId, input.workspaceId),
          or(eq(dataExports.status, 'pending'), eq(dataExports.status, 'running'))!,
        ),
      )
      .limit(1),
  )
  if (open) return ser(open)
  const id = uuidv7()
  const [row] = await kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .insert(dataExports)
      .values({
        id,
        workspaceId: input.workspaceId,
        requestedBy: input.requestedBy,
        status: 'pending',
        expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
      })
      .returning(),
  )
  if (!row) throw new KernError('INTERNAL', 'Could not record the export request')
  await kernel.jobs
    .send('core.export.build', { exportId: id, workspaceId: input.workspaceId })
    .catch((err: Error) => kernel.log.warn({ err: err.message }, 'export job enqueue failed'))
  return ser(row)
}

export async function list(kernel: Kernel, workspaceId: string): Promise<ExportRecord[]> {
  const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(dataExports)
      .where(eq(dataExports.workspaceId, workspaceId))
      .orderBy(desc(dataExports.createdAt))
      .limit(50),
  )
  return rows.map(ser)
}

export async function get(kernel: Kernel, workspaceId: string, id: string): Promise<ExportRecord> {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(dataExports)
      .where(and(eq(dataExports.id, id), eq(dataExports.workspaceId, workspaceId)))
      .limit(1),
  )
  if (!row) throw KernError.notFound('Export')
  return ser(row)
}

/** A short-lived URL for a finished export. */
export async function downloadUrl(
  kernel: Kernel,
  workspaceId: string,
  id: string,
): Promise<{ url: string; expiresAt: string }> {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(dataExports)
      .where(and(eq(dataExports.id, id), eq(dataExports.workspaceId, workspaceId)))
      .limit(1),
  )
  if (!row) throw KernError.notFound('Export')
  if (row.status !== 'ready' || !row.key)
    throw KernError.conflict('Export is not ready yet', 'core.export.not_ready')
  if (row.expiresAt && row.expiresAt.getTime() < Date.now())
    throw KernError.conflict('Export has expired; request a new one', 'core.export.expired')
  const ttl = 900
  const url = await kernel.storage.presignGet(row.key, {
    expiresIn: ttl,
    filename: `kern-export-${workspaceId}.json.gz`,
    disposition: 'attachment',
    contentType: 'application/gzip',
  })
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }
}

/**
 * Ask one module for its share of the workspace.
 *
 * Returns `null` when nobody answers, which is a fact rather than an error: NATS reports "no
 * responders" in one round trip, so "this module has no export procedure" is knowable and is
 * recorded as a follow-up. Anything else that goes wrong is recorded the same way — an export that
 * fails wholesale because one module threw would leave the customer with nothing.
 */
async function askModule(kernel: Kernel, moduleId: string, workspaceId: string): Promise<unknown | null> {
  try {
    return await kernel.call(`${moduleId}.export`, { workspaceId }, kernel.system)
  } catch (err) {
    const reason = (err as { reason?: string; details?: { reason?: string } }).reason
    if (reason !== NO_RESPONDERS)
      kernel.log.warn({ err: (err as Error).message, moduleId, workspaceId }, 'module export failed')
    return null
  }
}

/** Job body: read everything, gzip it, put it in the bucket, mark the row ready. */
export async function build(kernel: Kernel, exportId: string, workspaceId: string): Promise<ExportRecord> {
  await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx.update(dataExports).set({ status: 'running' }).where(eq(dataExports.id, exportId)),
  )
  try {
    const { document, followUps } = await collect(kernel, workspaceId)
    const body = gzipSync(Buffer.from(JSON.stringify(document, null, 2), 'utf8'))
    const key = exportKey(workspaceId, exportId)
    await kernel.storage.put(key, body, 'application/gzip')
    const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .update(dataExports)
        .set({
          status: 'ready',
          key,
          sizeBytes: body.byteLength,
          followUps,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
        })
        .where(eq(dataExports.id, exportId))
        .returning(),
    )
    if (!row) throw KernError.notFound('Export')
    await kernel.emit(
      coreLifecycleEvents.exportReady,
      { exportId, workspaceId, sizeBytes: body.byteLength },
      { workspaceId },
    )
    return ser(row)
  } catch (err) {
    const message = (err as Error).message
    const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .update(dataExports)
        .set({ status: 'failed', error: message.slice(0, 500), completedAt: new Date() })
        .where(eq(dataExports.id, exportId))
        .returning(),
    )
    kernel.log.error({ err: message, exportId, workspaceId }, 'workspace export failed')
    if (!row) throw err
    return ser(row)
  }
}

export interface ExportDocument {
  format: string
  kernVersion: string
  exportedAt: string
  workspace: unknown
  core: Record<string, unknown[]>
  files: unknown[]
  modules: Record<string, unknown>
  /** modules that own data in this workspace and could not contribute it */
  followUps: string[]
}

/** Everything core holds for a workspace, plus whatever the modules were able to hand over. */
export async function collect(
  kernel: Kernel,
  workspaceId: string,
): Promise<{ document: ExportDocument; followUps: string[] }> {
  const db = kernel.database.db
  const ws = await getWorkspaceRow(kernel, workspaceId)
  if (!ws) throw KernError.notFound('Workspace')

  // Global tables: keyed by workspace but outside RLS, so read on the plain connection.
  const memberRows = await db
    .select({ m: memberships, u: user })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
  const inviteRows = await db.select().from(invitations).where(eq(invitations.workspaceId, workspaceId))
  const fileRows = await db.select().from(files).where(eq(files.workspaceId, workspaceId))

  // Tenant tables: inside `withWorkspace`, so the RLS policies apply to the export too.
  const tenant = await kernel.database.withWorkspace(workspaceId, async (tx) => ({
    roles: await tx.select().from(roles).where(eq(roles.workspaceId, workspaceId)),
    groups: await tx.select().from(groups).where(eq(groups.workspaceId, workspaceId)),
    groupMembers: await tx.select().from(groupMembers).where(eq(groupMembers.workspaceId, workspaceId)),
    roleBindings: await tx.select().from(roleBindings).where(eq(roleBindings.workspaceId, workspaceId)),
    modules: await tx.select().from(workspaceModules).where(eq(workspaceModules.workspaceId, workspaceId)),
    dashboardLayouts: await tx
      .select()
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.workspaceId, workspaceId)),
    dashboardSettings: await tx
      .select()
      .from(dashboardSettings)
      .where(eq(dashboardSettings.workspaceId, workspaceId)),
    searchDocuments: await tx
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.workspaceId, workspaceId)),
    activity: await tx
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.workspaceId, workspaceId))
      .orderBy(desc(activityEvents.occurredAt))
      .limit(ACTIVITY_LIMIT),
  }))

  const modules: Record<string, unknown> = {}
  const followUps: string[] = []
  for (const manifest of kernel.manifests()) {
    if (manifest.core) continue
    if (!(await kernel.isModuleEnabled(workspaceId, manifest.id))) continue
    const contribution = await askModule(kernel, manifest.id, workspaceId)
    if (contribution === null) {
      followUps.push(
        `${manifest.id}: no export procedure — this module's data is not in this archive. It owns schema mod_${manifest.id}.`,
      )
      continue
    }
    modules[manifest.id] = contribution
  }

  const document: ExportDocument = {
    format: FORMAT,
    kernVersion: kernel.version,
    exportedAt: new Date().toISOString(),
    workspace: ws,
    core: {
      members: memberRows.map(({ m, u }) => ({
        ...m,
        user: { id: u.id, email: u.email, name: u.name, username: u.username, avatarUrl: u.image },
      })),
      invitations: inviteRows.map(({ token: _token, ...rest }) => rest),
      roles: tenant.roles,
      groups: tenant.groups,
      groupMembers: tenant.groupMembers,
      roleBindings: tenant.roleBindings,
      modules: tenant.modules,
      dashboardLayouts: tenant.dashboardLayouts,
      dashboardSettings: tenant.dashboardSettings,
      searchDocuments: tenant.searchDocuments,
      activity: tenant.activity,
    },
    // A manifest, not the bytes. Each entry is downloadable through `files.downloadUrl`.
    files: fileRows.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      sha256: f.sha256,
      key: f.key,
      attachedTo: f.attachedTo,
      uploadedBy: f.uploadedBy,
      status: f.status,
      createdAt: f.createdAt.toISOString(),
    })),
    modules,
    followUps,
  }
  return { document, followUps }
}

/**
 * Cron: drop artifacts past their TTL.
 *
 * An export is a copy of everything a workspace has, sitting in a bucket behind a presigned URL. One
 * that is never cleaned up is a second, permanent, unmanaged home for the customer's data — which is
 * the opposite of what an export is for, and the thing a retention policy is asked about first.
 */
export async function expireStale(kernel: Kernel): Promise<number> {
  const now = new Date()
  const rows = await kernel.database.db
    .select({ id: dataExports.id, workspaceId: dataExports.workspaceId, key: dataExports.key })
    .from(dataExports)
    .where(
      and(
        or(eq(dataExports.status, 'ready'), eq(dataExports.status, 'failed')),
        lt(dataExports.expiresAt, now),
      ),
    )
    .limit(500)
  for (const row of rows) {
    if (row.key) await kernel.storage.delete(row.key).catch(() => {})
    await kernel.database.withWorkspace(row.workspaceId, (tx) =>
      tx.update(dataExports).set({ status: 'expired', key: null }).where(eq(dataExports.id, row.id)),
    )
  }
  return rows.length
}
