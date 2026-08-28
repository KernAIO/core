/**
 * The record an operator leaves when they read a workspace they do not belong to.
 *
 * `workspaceScoped` skips the membership check for an instance admin, and it is right to: somebody
 * has to be able to repair a tenant. What was wrong is that it left nothing behind. An instance
 * admin resolves as `owner` of every workspace (`services/common.ts`), so they could read and delete
 * any file, search anything and open any channel, and the request was indistinguishable from the
 * customer's own — in the customer's own audit log most of all, where it simply did not appear.
 *
 * The kernel publishes `kernel.access.crossed` for every such request, from whichever service served
 * it, and this turns that signal into a durable row. Two decisions shape it:
 *
 * - **It is written to `activity_events`, the workspace's own audit log**, not to an operator-only
 *   table. That is the entire point: the workspace's owners and admins see it through
 *   `workspaces.audit`, which they already have. An audit trail only the operator can read audits
 *   nothing.
 * - **A machine on its own is not recorded.** A service principal crosses on internal plumbing and
 *   names nobody, so a row for it would be noise in a log a person has to read. A service credential
 *   carrying a *user* is recorded, because that is a person behind a machine.
 */
import type { Kernel } from '@kernhq/kernel'
import { MODULE_ID } from '../schema/base.js'
import { record } from './activity.js'

/** Payload of `kernel.access.crossed`; mirrors `UnscopedAccess` in the kernel. */
export interface UnscopedAccessEvent {
  workspaceId: string
  procedure: string
  via: 'instance_admin' | 'service'
  principal: { kind: string; userId: string | null; email: string | null; service: string | null }
  requestId: string
  ip: string
  at: string
}

/** `action` on the activity row, so a reader can filter the operator's visits out of the stream. */
export const ACCESS_CROSSED_ACTION = 'access.crossed'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function shouldRecord(access: UnscopedAccessEvent): boolean {
  return access.via === 'instance_admin' || Boolean(access.principal.userId)
}

/**
 * Write one audit row for one crossing.
 *
 * Never throws at the caller. It runs off an event handler on a request that has already been
 * answered, so a failure here must be a warning in the log and nothing else — an audit write that
 * can take a service down is worse than a gap in the audit trail.
 */
export async function recordUnscopedAccess(
  kernel: Kernel,
  access: UnscopedAccessEvent,
): Promise<'written' | 'skipped' | 'failed'> {
  if (!shouldRecord(access)) return 'skipped'
  if (!UUID.test(access.workspaceId)) return 'skipped'
  try {
    await record(kernel, {
      workspaceId: access.workspaceId as never,
      module: MODULE_ID,
      // The object is the workspace itself: what was reached is the tenant, and the procedure that
      // reached it is in `data`, where it can be read without being a foreign key to anything.
      object: { module: MODULE_ID, type: 'workspace', id: access.workspaceId as never },
      action: ACCESS_CROSSED_ACTION,
      actorId: (UUID.test(access.principal.userId ?? '') ? access.principal.userId : null) as never,
      changes: [],
      data: {
        procedure: access.procedure,
        via: access.via,
        principalKind: access.principal.kind,
        actorEmail: access.principal.email,
        service: access.principal.service,
        requestId: access.requestId,
        // A claim made by the proxy, never evidence — recorded so a line in the log can be found
        // again, not so anything can be decided on it.
        ip: access.ip,
      },
      occurredAt: access.at,
    })
    return 'written'
  } catch (err) {
    kernel.log.warn(
      { err: (err as Error).message, workspaceId: access.workspaceId, procedure: access.procedure },
      'could not record unscoped workspace access',
    )
    return 'failed'
  }
}
