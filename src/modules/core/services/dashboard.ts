import type { core } from '@kernhq/contracts'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { type DashboardItemRow, dashboardLayouts, dashboardSettings } from '../schema/index.js'
import { type Ctx, requireUser } from './common.js'

const DEFAULT_PRESET = 'my-work'
const DEFAULT_POLICY: core.DashboardPolicy = 'default'

type Surface = 'home'

/**
 * `items` is a jsonb column, so the database guarantees nothing about what is in it — only that it
 * is JSON. A row written by an older version of the app, by a later one that has been rolled back,
 * or by hand, must not be able to draw two cards on top of each other or place one off the grid.
 *
 * The app repairs geometry properly when it renders (it knows the twelve-column grid); this is the
 * narrower guarantee the server owes every reader: well-formed items, in range, no duplicate ids.
 */
function sanitise(items: unknown): core.DashboardItem[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: core.DashboardItem[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Partial<DashboardItemRow>
    if (typeof it.i !== 'string' || typeof it.widget !== 'string') continue
    if (seen.has(it.i)) continue
    seen.add(it.i)
    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : fallback
    out.push({
      i: it.i,
      widget: it.widget,
      x: clamp(it.x, 0, 11, 0),
      y: clamp(it.y, 0, 200, 0),
      w: clamp(it.w, 1, 12, 4),
      h: clamp(it.h, 1, 12, 2),
      size: it.size === 's' || it.size === 'm' || it.size === 'l' || it.size === 'xl' ? it.size : 'm',
      settings: (it.settings ?? {}) as core.DashboardItem['settings'],
    })
    if (out.length === 40) break
  }
  return out
}

type WorkspaceId = core.DashboardLayout['workspaceId']
type UserId = NonNullable<core.DashboardLayout['userId']>

function toLayout(
  workspaceId: WorkspaceId,
  surface: Surface,
  row: { userId: string | null; items: unknown; presetId: string | null; updatedAt: Date } | null,
  userId: UserId | null,
): core.DashboardLayout {
  // The branded id types live at the contract boundary; a database row is plain text. This function
  // is that boundary, so the assertion belongs here rather than in a lie about the row's shape.
  return {
    workspaceId,
    surface,
    userId: (row ? row.userId : userId) as UserId | null,
    items: row ? sanitise(row.items) : [],
    presetId: row?.presetId ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  }
}

async function readSettings(kernel: Kernel, workspaceId: WorkspaceId, surface: Surface) {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(dashboardSettings)
      .where(and(eq(dashboardSettings.workspaceId, workspaceId), eq(dashboardSettings.surface, surface)))
      .limit(1),
  )
  return {
    policy: ((row?.policy ?? DEFAULT_POLICY) as core.DashboardPolicy) ?? DEFAULT_POLICY,
    defaultPresetId: row?.defaultPresetId ?? DEFAULT_PRESET,
  }
}

async function readLayout(kernel: Kernel, workspaceId: WorkspaceId, surface: Surface, userId: UserId | null) {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.workspaceId, workspaceId),
          eq(dashboardLayouts.surface, surface),
          userId === null ? isNull(dashboardLayouts.userId) : eq(dashboardLayouts.userId, userId),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

/**
 * What to draw, resolved through the policy so the client never re-implements this table.
 *
 * The one line that separates `open` from `default` is that `open` never consults the workspace
 * row — which is exactly what "everyone starts from a preset and arranges their own" means.
 */
export async function get(
  ctx: Ctx,
  input: { workspaceId: WorkspaceId; surface: Surface },
): Promise<core.DashboardView> {
  const userId = requireUser(ctx.principal) as UserId
  const { workspaceId, surface } = input
  const { policy, defaultPresetId } = await readSettings(ctx.kernel, workspaceId, surface)

  const workspaceRow = policy === 'open' ? null : await readLayout(ctx.kernel, workspaceId, surface, null)
  const personalRow = policy === 'locked' ? null : await readLayout(ctx.kernel, workspaceId, surface, userId)

  const chosen = personalRow ?? workspaceRow
  const source = personalRow ? 'personal' : workspaceRow ? 'workspace' : 'preset'

  return {
    policy,
    defaultPresetId,
    // `source: 'preset'` carries no items on purpose: a preset is a list of widget ids, and a widget
    // id is a client concept. The app expands `defaultPresetId`; the server never has to know that
    // `tracker.assigned-to-me` exists.
    layout: toLayout(workspaceId, surface, chosen, personalRow ? userId : null),
    source,
    canCustomise: policy !== 'locked',
  }
}

async function upsertLayout(
  ctx: Ctx,
  workspaceId: WorkspaceId,
  surface: Surface,
  userId: UserId | null,
  items: core.DashboardItem[],
  presetId: string | null,
): Promise<core.DashboardLayout> {
  const actor = requireUser(ctx.principal) as UserId
  const rows = items as unknown as DashboardItemRow[]
  const [row] = await ctx.kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .insert(dashboardLayouts)
      .values({ workspaceId, userId, surface, items: rows, presetId, updatedBy: actor })
      .onConflictDoUpdate({
        // The conflict target has to name the partial index's predicate, or Postgres cannot tell
        // which of the two unique indexes this insert is meant to arbitrate against.
        target: [dashboardLayouts.workspaceId, dashboardLayouts.surface],
        targetWhere: isNull(dashboardLayouts.userId),
        set: { items: rows, presetId, updatedBy: actor, updatedAt: sql`now()` },
      })
      .returning(),
  )
  return toLayout(workspaceId, surface, row ?? null, userId)
}

/** The caller's own layout. Refused outright when the workspace locked it. */
export async function save(
  ctx: Ctx,
  input: { workspaceId: WorkspaceId; surface: Surface; items: core.DashboardItem[]; presetId: string | null },
): Promise<core.DashboardLayout> {
  const userId = requireUser(ctx.principal) as UserId
  const { policy } = await readSettings(ctx.kernel, input.workspaceId, input.surface)
  // Hiding the button is presentation. This is the policy.
  if (policy === 'locked') {
    throw new KernError('CONFLICT', 'This dashboard is set by the workspace', {
      reason: 'core.dashboard.locked',
    })
  }
  const actor = userId
  const rows = input.items as unknown as DashboardItemRow[]
  const [row] = await ctx.kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .insert(dashboardLayouts)
      .values({
        workspaceId: input.workspaceId,
        userId,
        surface: input.surface,
        items: rows,
        presetId: input.presetId,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        // Same reason as the workspace upsert: the unique index is partial, so the predicate is
        // part of naming it.
        target: [dashboardLayouts.workspaceId, dashboardLayouts.userId, dashboardLayouts.surface],
        targetWhere: isNotNull(dashboardLayouts.userId),
        set: { items: rows, presetId: input.presetId, updatedBy: actor, updatedAt: sql`now()` },
      })
      .returning(),
  )
  // Deliberately no `realtime.change` here. One person moving a card must not invalidate every
  // other member's dashboard, and the mutation's own onSuccess already updates the caller's cache.
  return toLayout(input.workspaceId, input.surface, row ?? null, userId)
}

/** Drop the caller's own layout, so the workspace's — or the preset — applies again. */
export async function reset(
  ctx: Ctx,
  input: { workspaceId: WorkspaceId; surface: Surface },
): Promise<core.DashboardView> {
  const userId = requireUser(ctx.principal) as UserId
  await ctx.kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .delete(dashboardLayouts)
      .where(
        and(
          eq(dashboardLayouts.workspaceId, input.workspaceId),
          eq(dashboardLayouts.surface, input.surface),
          eq(dashboardLayouts.userId, userId),
        ),
      ),
  )
  return get(ctx, input)
}

export async function settingsGet(
  ctx: Ctx,
  input: { workspaceId: WorkspaceId; surface: Surface },
): Promise<core.DashboardSettings> {
  const { policy, defaultPresetId } = await readSettings(ctx.kernel, input.workspaceId, input.surface)
  const row = await readLayout(ctx.kernel, input.workspaceId, input.surface, null)
  return {
    policy,
    defaultPresetId,
    workspace: row ? toLayout(input.workspaceId, input.surface, row, null) : null,
  }
}

export async function settingsSet(
  ctx: Ctx,
  input: {
    workspaceId: WorkspaceId
    surface: Surface
    policy?: core.DashboardPolicy
    defaultPresetId?: string
  },
): Promise<core.DashboardSettings> {
  const actor = requireUser(ctx.principal) as UserId
  const current = await readSettings(ctx.kernel, input.workspaceId, input.surface)
  const policy = input.policy ?? current.policy
  const defaultPresetId = input.defaultPresetId ?? current.defaultPresetId

  await ctx.kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .insert(dashboardSettings)
      .values({
        workspaceId: input.workspaceId,
        surface: input.surface,
        policy,
        defaultPresetId,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: [dashboardSettings.workspaceId, dashboardSettings.surface],
        set: { policy, defaultPresetId, updatedBy: actor, updatedAt: sql`now()` },
      }),
  )
  await announce(ctx, input.workspaceId)
  return settingsGet(ctx, input)
}

export async function saveWorkspace(
  ctx: Ctx,
  input: { workspaceId: WorkspaceId; surface: Surface; items: core.DashboardItem[]; presetId: string | null },
): Promise<core.DashboardLayout> {
  const layout = await upsertLayout(ctx, input.workspaceId, input.surface, null, input.items, input.presetId)
  await announce(ctx, input.workspaceId)
  return layout
}

/**
 * Only the workspace-wide writes announce themselves: they change what other people see, which is
 * the whole reason a realtime message exists.
 */
function announce(ctx: Ctx, workspaceId: WorkspaceId) {
  return ctx.kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'dashboard',
    id: workspaceId,
    op: 'updated',
  })
}
