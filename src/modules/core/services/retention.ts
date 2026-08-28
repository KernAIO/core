/**
 * The one enforcement site for the `auditRetentionDays` entitlement.
 *
 * The key has been in `kernel.entitlements` — and on the pricing page, as 7 days / 90 days / 2 years
 * — while nothing anywhere read it, so every plan kept every audit row for ever and the three tiers
 * differed in nothing but the number printed beside them. An entitlement key nothing enforces is a
 * promise the product does not keep, in whichever direction it happens to fall.
 *
 * **Unlimited retention is the default and must stay cheap.** `entitlements.of` answers `UNLIMITED`
 * with no I/O when no billing module is hosted, which is every self-hosted instance, so this job
 * walks the workspaces, is told there is no limit, and deletes nothing. It is also what happens when
 * a biller exists and is unreachable (`source: 'unavailable'`): a billing outage must never be able
 * to delete a customer's audit trail, and answering "no limit" is what makes that automatic.
 */
import type { Kernel } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import { workspaces } from '../schema/index.js'

/**
 * Rows removed per statement.
 *
 * The activity stream is **not** partitioned — the plan was a monthly partition per workspace and
 * `activity_events` is a plain table with a `(workspace_id, occurred_at)` index — so there is no
 * partition to detach and this is a delete. Bounded so that one workspace with years of history
 * cannot hold a transaction (or the job) open indefinitely; whatever a pass does not reach, the next
 * pass does. Moving the table to monthly partitions would turn each of these into a `drop table`,
 * and is the change worth making before an instance is large enough for this to matter.
 */
const BATCH = 5_000
/** Statements per workspace per pass: 50k rows is far more than a day of activity produces. */
const MAX_BATCHES = 10

/**
 * Delete audit rows older than `days` for one workspace. Returns how many went.
 *
 * `ctid` rather than `id in (select …)`: it addresses the physical row, so the planner deletes
 * exactly the batch it just read instead of re-running the predicate over the whole partition of the
 * index.
 */
export async function pruneWorkspaceAudit(
  kernel: Kernel,
  workspaceId: string,
  days: number,
): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoff = new Date(Date.now() - days * 86_400_000)
  let deleted = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const res = await kernel.database.withWorkspace(workspaceId, (tx) =>
      tx.execute(sql`
        delete from mod_core.activity_events
        where ctid in (
          select ctid from mod_core.activity_events
          where workspace_id = ${workspaceId} and occurred_at < ${cutoff}
          limit ${BATCH}
        )
      `),
    )
    const n = (res as { rowCount?: number | null }).rowCount ?? 0
    deleted += n
    if (n < BATCH) break
  }
  return deleted
}

export interface RetentionPass {
  /** workspaces whose plan sets a retention limit */
  limited: number
  deleted: number
}

/** Nightly pass: ask each workspace's plan how long it keeps audit rows, and hold it to that. */
export async function runAuditRetention(kernel: Kernel): Promise<RetentionPass> {
  const rows = await kernel.database.db.select({ id: workspaces.id }).from(workspaces)
  const out: RetentionPass = { limited: 0, deleted: 0 }
  for (const { id } of rows) {
    const { auditRetentionDays } = await kernel.entitlements.of(id)
    if (auditRetentionDays === null) continue
    out.limited++
    try {
      out.deleted += await pruneWorkspaceAudit(kernel, id, auditRetentionDays)
    } catch (err) {
      // One workspace's failure must not stop the rest of the instance being pruned.
      kernel.log.warn({ err: (err as Error).message, workspaceId: id }, 'audit retention pass failed')
    }
  }
  return out
}
