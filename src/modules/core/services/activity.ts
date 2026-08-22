import type { core, Page } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { decodeCursor, encodeCursor, paginate } from '../lib/cursor.js'
import { serActivity } from '../lib/ser.js'
import { activityEvents } from '../schema/index.js'
import type { Ctx } from './common.js'

export async function record(
  kernel: Kernel,
  input: Omit<core.ActivityEvent, 'id' | 'occurredAt'> & { occurredAt?: string },
): Promise<core.ActivityEvent> {
  const [row] = await kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .insert(activityEvents)
      .values({
        workspaceId: input.workspaceId,
        module: input.module,
        objectModule: input.object.module,
        objectType: input.object.type,
        objectId: input.object.id,
        action: input.action,
        actorId: input.actorId,
        changes: input.changes ?? [],
        data: input.data ?? {},
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      })
      .returning(),
  )
  return serActivity(row!)
}

export async function list(
  ctx: Ctx,
  input: {
    workspaceId: string
    module?: string
    actorId?: string
    object?: { module: string; type: string; id: string }
    cursor?: string
    limit: number
  },
): Promise<Page<core.ActivityEvent>> {
  const cur = decodeCursor(input.cursor)
  const conds = [eq(activityEvents.workspaceId, input.workspaceId)]
  if (input.module) conds.push(eq(activityEvents.module, input.module))
  if (input.actorId) conds.push(eq(activityEvents.actorId, input.actorId))
  if (input.object)
    conds.push(
      eq(activityEvents.objectModule, input.object.module),
      eq(activityEvents.objectType, input.object.type),
      eq(activityEvents.objectId, input.object.id),
    )
  if (cur && typeof cur.sortKey === 'string') {
    const at = new Date(cur.sortKey)
    conds.push(
      or(
        lt(activityEvents.occurredAt, at),
        and(eq(activityEvents.occurredAt, at), lt(activityEvents.id, cur.id)),
      )!,
    )
  }
  const rows = await ctx.kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .select()
      .from(activityEvents)
      .where(and(...conds))
      .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
      .limit(input.limit + 1),
  )
  const page = paginate(rows, input.limit, (r) => encodeCursor(r.occurredAt.toISOString(), r.id))
  return { items: page.items.map(serActivity), nextCursor: page.nextCursor }
}
