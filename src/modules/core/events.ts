/**
 * Events core publishes that are not in `@kernhq/contracts`.
 *
 * These are the erasure lifecycle. They live here rather than in the shared contract because core is
 * the only thing that can emit them, and because a module only ever *consumes* them — an event a
 * module subscribes to by name needs no generated type on the publisher's side.
 *
 * **`core.workspace.purge` and `core.account.purge` are the module boundary for deletion.** Every
 * module owns its own `mod_<id>` schema, and core must never reach into one; erasure therefore works
 * the only way it can, by asking. A module handles the event and deletes its own rows. A module that
 * does not handle it keeps the data, so the request records a *follow-up* naming it rather than
 * reporting an erasure that did not happen — see `services/deletion.ts`.
 */
import { defineEvent } from '@kernhq/contracts'
import { z } from 'zod'

const Subject = z.object({
  /** deletion request id, so a handler can report against it */
  requestId: z.string(),
  purgeAfter: z.string(),
})

export const coreLifecycleEvents = {
  workspaceDeletionScheduled: defineEvent(
    'core.workspace.deletion_scheduled',
    Subject.extend({ workspaceId: z.string() }),
    { description: 'A workspace is scheduled for erasure after its grace period' },
  ),
  workspaceDeletionCancelled: defineEvent(
    'core.workspace.deletion_cancelled',
    z.object({ workspaceId: z.string(), requestId: z.string() }),
    { description: 'A scheduled workspace erasure was called off inside the grace period' },
  ),
  /** The grace period is over: every module must delete this workspace's data now. */
  workspacePurge: defineEvent(
    'core.workspace.purge',
    z.object({ workspaceId: z.string(), requestId: z.string() }),
    { description: 'Delete everything you hold for this workspace' },
  ),
  accountDeletionScheduled: defineEvent(
    'core.account.deletion_scheduled',
    Subject.extend({ userId: z.string() }),
    { description: 'An account is scheduled for erasure after its grace period' },
  ),
  accountDeletionCancelled: defineEvent(
    'core.account.deletion_cancelled',
    z.object({ userId: z.string(), requestId: z.string() }),
    { description: 'A scheduled account erasure was called off inside the grace period' },
  ),
  /** The grace period is over: every module must delete this person's data now. */
  accountPurge: defineEvent('core.account.purge', z.object({ userId: z.string(), requestId: z.string() }), {
    description: 'Delete everything you hold for this person',
  }),
  exportReady: defineEvent(
    'core.export.ready',
    z.object({ exportId: z.string(), workspaceId: z.string(), sizeBytes: z.number().int().nonnegative() }),
    { description: 'A workspace export finished and can be downloaded' },
  ),
} as const
