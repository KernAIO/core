import type { core, Page } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import webpush from 'web-push'
import type { z } from 'zod'
import type { CoreDeps } from '../deps.js'
import { decodeCursor, encodeCursor, paginate } from '../lib/cursor.js'
import { serNotification } from '../lib/ser.js'
import { notificationSettings, notifications, pushSubscriptions, user } from '../schema/index.js'
import { getInstanceSetting, getInstanceSettings, setInstanceSetting } from './admin.js'
import { type Ctx, requireUser } from './common.js'

type NotificationSettings = z.infer<typeof core.NotificationSettings>

const DEFAULTS: core.NotificationTypeDef['defaults'] = { inapp: true, push: true, email: false }

// ---------- preferences ----------
type SettingsRow = typeof notificationSettings.$inferSelect

async function getSettingsRow(kernel: Kernel, userId: string): Promise<SettingsRow | null> {
  const [row] = await kernel.database.db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .limit(1)
  return row ?? null
}

export async function getSettings(ctx: Ctx): Promise<NotificationSettings> {
  const row = await getSettingsRow(ctx.kernel, requireUser(ctx.principal))
  return {
    emailDigest: (row?.emailDigest ?? 'daily') as NotificationSettings['emailDigest'],
    quietHours: row?.quietHours ?? null,
    preferences: (row?.preferences ?? []) as NotificationSettings['preferences'],
  }
}

export async function updateSettings(ctx: Ctx, input: NotificationSettings): Promise<NotificationSettings> {
  const userId = requireUser(ctx.principal)
  await ctx.kernel.database.db
    .insert(notificationSettings)
    .values({
      userId,
      emailDigest: input.emailDigest,
      quietHours: input.quietHours,
      preferences: input.preferences,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        emailDigest: input.emailDigest,
        quietHours: input.quietHours,
        preferences: input.preferences,
        updatedAt: new Date(),
      },
    })
  return input
}

/** Effective channel switches for one notification: per-workspace pref > global pref > module-declared defaults. */
export function resolveChannels(
  typeDef: (core.NotificationTypeDef & { module: string }) | undefined,
  settings: SettingsRow | null,
  type: string,
  workspaceId: string | null,
): { inapp: boolean; push: boolean; email: boolean; urgent: boolean } {
  const defaults = typeDef?.defaults ?? DEFAULTS
  const prefs = settings?.preferences ?? []
  const specific = workspaceId
    ? prefs.find((p) => p.type === type && p.workspaceId === workspaceId)
    : undefined
  const global = prefs.find((p) => p.type === type && p.workspaceId === null)
  const pick = specific ?? global
  return {
    inapp: pick?.inapp ?? defaults.inapp,
    push: pick?.push ?? defaults.push,
    email: pick?.email ?? defaults.email,
    urgent: typeDef?.urgent ?? false,
  }
}

/** true when `now` falls into the user's configured quiet hours (urgent notifications ignore this) */
export function inQuietHours(
  q: { start: string; end: string; timezone: string } | null | undefined,
  now = new Date(),
): boolean {
  if (!q) return false
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: q.timezone,
    })
    const hm = fmt.format(now)
    // window may wrap midnight, e.g. 22:00 → 07:00
    return q.start <= q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end
  } catch {
    return false
  }
}

// ---------- creation (broker `core.notifications.create` + internal callers) ----------
export async function createNotification(
  ctx: Ctx,
  _deps: CoreDeps,
  input: core.CreateNotification,
): Promise<core.Notification | null> {
  const { kernel } = ctx
  const typeDef = kernel.registry.notificationTypes().find((t) => t.type === input.type)
  const settings = await getSettingsRow(kernel, input.userId)
  const ch = resolveChannels(typeDef, settings, input.type, input.workspaceId)
  if (!ch.inapp && !ch.push && !ch.email) return null

  const [row] = await kernel.database.db
    .insert(notifications)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      module: input.module,
      type: input.type,
      title: input.title,
      body: input.body,
      object: input.object,
      url: input.url,
      actorId: input.actorId,
      data: input.data ?? {},
      groupKey: input.groupKey,
      urgent: ch.urgent,
      emailQueued: ch.email,
      // inapp off → keep the row for push/email bookkeeping but never surface it: mark read+archived
      readAt: ch.inapp ? null : new Date(),
      archivedAt: ch.inapp ? null : new Date(),
    })
    .returning()
  if (!row) throw new KernError('INTERNAL', 'Notification insert failed')

  const actor = input.actorId
    ? await kernel.database.db
        .select({ id: user.id, name: user.name, avatarUrl: user.image })
        .from(user)
        .where(eq(user.id, input.actorId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null
  const out = serNotification(row, actor)

  await kernel.emit(
    coreEvents.notificationCreated,
    {
      notificationId: row.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      type: input.type,
      urgent: ch.urgent,
    },
    { workspaceId: input.workspaceId, actorId: input.actorId },
  )
  if (ch.inapp) {
    await kernel.realtime.toUser(input.userId, { t: 'notification', notification: out })
    await sendBadge(kernel, input.userId, input.workspaceId)
  }
  if (ch.push && (ch.urgent || !inQuietHours(settings?.quietHours))) {
    await kernel.jobs
      .send('core.push.send', {
        userId: input.userId,
        title: input.title,
        body: input.body,
        url: input.url,
        tag: input.groupKey,
        workspaceId: input.workspaceId,
      })
      .catch((err: Error) => kernel.log.warn({ err: err.message }, 'push job enqueue failed'))
  }
  return out
}

/** push per-workspace unread/mention counters to the user's sockets (Badging API / workspace rail) */
export async function sendBadge(kernel: Kernel, userId: string, workspaceId: string | null) {
  if (!workspaceId) return
  const [c] = await kernel.database.db
    .select({
      unread: sql<number>`count(*)::int`,
      mentions: sql<number>`count(*) filter (where ${notifications.urgent})::int`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.workspaceId, workspaceId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
      ),
    )
  await kernel.realtime.toUser(userId, {
    t: 'badge',
    workspaceId: workspaceId as never,
    unread: c?.unread ?? 0,
    mentions: c?.mentions ?? 0,
  })
}

// ---------- inbox ----------
export async function list(
  ctx: Ctx,
  input: { workspaceId?: string; unreadOnly: boolean; cursor?: string; limit: number },
): Promise<Page<core.Notification>> {
  const userId = requireUser(ctx.principal)
  const db = ctx.kernel.database.db
  const cur = decodeCursor(input.cursor)
  const conds = [eq(notifications.userId, userId), isNull(notifications.archivedAt)]
  if (input.workspaceId) conds.push(eq(notifications.workspaceId, input.workspaceId))
  if (input.unreadOnly) conds.push(isNull(notifications.readAt))
  if (cur) conds.push(lt(notifications.id, cur.id))
  const rows = await db
    .select({ n: notifications, a: { id: user.id, name: user.name, avatarUrl: user.image } })
    .from(notifications)
    .leftJoin(user, eq(user.id, notifications.actorId))
    .where(and(...conds))
    .orderBy(desc(notifications.id))
    .limit(input.limit + 1)
  const page = paginate(rows, input.limit, (r) => encodeCursor(null, r.n.id))
  return {
    items: page.items.map((r) => serNotification(r.n, r.a?.id ? r.a : null)),
    nextCursor: page.nextCursor,
  }
}

export async function counts(
  ctx: Ctx,
): Promise<Array<{ workspaceId: core.WorkspaceSummary['id'] | null; unread: number; mentions: number }>> {
  const userId = requireUser(ctx.principal)
  const rows = await ctx.kernel.database.db
    .select({
      workspaceId: notifications.workspaceId,
      unread: sql<number>`count(*)::int`,
      mentions: sql<number>`count(*) filter (where ${notifications.urgent})::int`,
    })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt), isNull(notifications.archivedAt)),
    )
    .groupBy(notifications.workspaceId)
  return rows.map((r) => ({ workspaceId: r.workspaceId as never, unread: r.unread, mentions: r.mentions }))
}

export async function markRead(
  ctx: Ctx,
  input: { ids?: string[]; workspaceId?: string; all: boolean },
): Promise<{ updated: number }> {
  const userId = requireUser(ctx.principal)
  const conds = [eq(notifications.userId, userId), isNull(notifications.readAt)]
  if (input.ids?.length) conds.push(inArray(notifications.id, input.ids))
  else if (input.workspaceId) conds.push(eq(notifications.workspaceId, input.workspaceId))
  else if (!input.all) throw KernError.badRequest('Pass ids, workspaceId or all=true')
  const rows = await ctx.kernel.database.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conds))
    .returning({ id: notifications.id, workspaceId: notifications.workspaceId })
  const wsIds = [...new Set(rows.map((r) => r.workspaceId).filter((w): w is string => Boolean(w)))]
  for (const ws of wsIds) await sendBadge(ctx.kernel, userId, ws)
  return { updated: rows.length }
}

export async function archive(ctx: Ctx, id: string): Promise<core.Notification> {
  const userId = requireUser(ctx.principal)
  const [row] = await ctx.kernel.database.db
    .update(notifications)
    .set({ archivedAt: new Date(), readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning()
  if (!row) throw KernError.notFound('Notification')
  if (row.workspaceId) await sendBadge(ctx.kernel, userId, row.workspaceId)
  const actor = row.actorId
    ? await ctx.kernel.database.db
        .select({ id: user.id, name: user.name, avatarUrl: user.image })
        .from(user)
        .where(eq(user.id, row.actorId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null
  return serNotification(row, actor)
}

export function types(kernel: Kernel): Array<core.NotificationTypeDef & { module: string }> {
  return kernel.registry.notificationTypes()
}

// ---------- web push ----------
export interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

/** VAPID keys from env, or generated once and persisted in instance settings. */
export async function getVapid(ctx: Ctx, deps: CoreDeps): Promise<VapidKeys | null> {
  const { kernel } = ctx
  const env = deps.env
  const settings = await getInstanceSettings(kernel)
  const subject = env.VAPID_SUBJECT ?? `mailto:${settings.supportEmail ?? 'admin@localhost'}`
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject }
  const stored = await getInstanceSetting<{ publicKey: string; privateKey: string }>(kernel, 'vapid')
  if (stored) return { ...stored, subject }
  const keys = webpush.generateVAPIDKeys()
  await setInstanceSetting(kernel, 'vapid', keys)
  kernel.log.info('generated VAPID key pair (stored in instance settings)')
  return { ...keys, subject }
}

export async function subscribePush(
  ctx: Ctx,
  input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string },
): Promise<void> {
  const userId = requireUser(ctx.principal)
  await ctx.kernel.database.db
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent ?? null },
    })
}

export async function unsubscribePush(ctx: Ctx, endpoint: string): Promise<void> {
  const userId = requireUser(ctx.principal)
  await ctx.kernel.database.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
}

/** worker job: deliver one push message to every subscription of a user, pruning dead endpoints */
export async function deliverPush(
  ctx: Ctx,
  deps: CoreDeps,
  input: {
    userId: string
    title: string
    body: string | null
    url: string | null
    tag?: string | null
    workspaceId?: string | null
  },
): Promise<void> {
  const { kernel } = ctx
  const vapid = await getVapid(ctx, deps)
  if (!vapid) return
  const subs = await kernel.database.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))
  if (!subs.length) return
  const payload = JSON.stringify({
    title: input.title,
    body: input.body ?? undefined,
    url: input.url ?? undefined,
    tag: input.tag ?? undefined,
    workspaceId: input.workspaceId ?? undefined,
  })
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: 3600,
        },
      )
      await kernel.database.db
        .update(pushSubscriptions)
        .set({ lastUsedAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id))
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await kernel.database.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id))
        kernel.log.debug({ endpoint: sub.endpoint }, 'pruned dead push subscription')
      } else {
        kernel.log.warn({ err: (err as Error).message, status }, 'web push failed')
      }
    }
  }
}

// ---------- email digest (worker cron) ----------
const DIGEST_MIN_INTERVAL_MS = { hourly: 55 * 60_000, daily: 23 * 60 * 60_000 } as const

/** What one pass of the digest did. `failed` is what makes a bad relay visible in the job log. */
export interface DigestResult {
  sent: number
  failed: number
  /** recipients whose address the relay refused outright, and who will not be retried */
  abandoned: number
}

/**
 * Whether a delivery failure is the address's fault rather than the moment's.
 *
 * An SMTP 5xx is the recipient being refused — no such mailbox, the domain does not accept mail,
 * the relay has blacklisted the address. Retrying that every hour for ever sends nothing and spends
 * the sending domain's reputation on hard bounces, so those notifications are stamped as done. A
 * 4xx, a timeout or a dropped connection is the moment's fault and is left to the next pass.
 */
function isPermanentMailFailure(err: unknown): boolean {
  const e = err as { responseCode?: unknown; code?: unknown }
  if (typeof e?.responseCode === 'number') return e.responseCode >= 500 && e.responseCode < 600
  return e?.code === 'EENVELOPE' || e?.code === 'EMESSAGE'
}

export async function runDigest(ctx: Ctx, deps: CoreDeps): Promise<DigestResult> {
  const { kernel } = ctx
  const db = kernel.database.db
  // users that have queued, unread, not-yet-emailed notifications
  const pending = await db
    .select({ userId: notifications.userId, n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.emailQueued, true), isNull(notifications.emailedAt), isNull(notifications.readAt)),
    )
    .groupBy(notifications.userId)
  let sent = 0
  let failed = 0
  let abandoned = 0
  for (const p of pending) {
    /**
     * One recipient never takes the run down with them.
     *
     * A corporate relay answering 550 at RCPT TO for a departed employee used to throw straight out
     * of this loop: everybody after that user in the pass got nothing, their `emailedAt` stayed
     * unset, and the same address broke the same run again an hour later, for ever. The failure is
     * per user now, it is counted so a spike is visible in the job's log, and a *permanent* refusal
     * stamps the notifications as done rather than queueing them for the next thousand attempts —
     * the notification is still in the person's inbox in the app, which is where they will see it.
     */
    try {
      const digested = await digestOneUser(ctx, deps, p.userId)
      if (digested) sent++
    } catch (err) {
      const permanent = isPermanentMailFailure(err)
      failed++
      kernel.log.warn(
        { userId: p.userId, err: (err as Error).message, permanent },
        permanent
          ? 'notification digest refused for this address; not retrying'
          : 'notification digest failed for one user; the rest of the run continues',
      )
      if (!permanent) continue
      abandoned++
      await markDigested(kernel, p.userId).catch((e: Error) =>
        kernel.log.warn({ userId: p.userId, err: e.message }, 'could not stamp an abandoned digest'),
      )
    }
  }
  return { sent, failed, abandoned }
}

/** Marks everything currently queued for this user as having been through the digest. */
async function markDigested(kernel: Kernel, userId: string): Promise<void> {
  await kernel.database.db
    .update(notifications)
    .set({ emailedAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.emailQueued, true),
        isNull(notifications.emailedAt),
      ),
    )
  await kernel.database.db
    .insert(notificationSettings)
    .values({ userId, lastDigestAt: new Date() })
    .onConflictDoUpdate({ target: notificationSettings.userId, set: { lastDigestAt: new Date() } })
}

/** One recipient's digest. False when there was nothing to send; throws what the relay throws. */
async function digestOneUser(ctx: Ctx, deps: CoreDeps, userId: string): Promise<boolean> {
  const { kernel } = ctx
  const db = kernel.database.db
  const settings = await getSettingsRow(kernel, userId)
  const cadence = (settings?.emailDigest ?? 'daily') as 'off' | 'hourly' | 'daily'
  if (cadence === 'off') return false
  const last = settings?.lastDigestAt?.getTime() ?? 0
  if (Date.now() - last < DIGEST_MIN_INTERVAL_MS[cadence]) return false
  const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1)
  if (u?.status !== 'active') return false
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.emailQueued, true),
        isNull(notifications.emailedAt),
        isNull(notifications.readAt),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(50)
  if (!rows.length) return false
  const lines = rows.map((n) => `• ${n.title}${n.body ? ` — ${n.body}` : ''}`)
  const base = kernel.env.KERN_BASE_URL.replace(/\/$/, '')
  await deps.mailer.send({
    to: u.email,
    subject: `Kern: ${rows.length} unread notification${rows.length === 1 ? '' : 's'}`,
    text: `Hi ${u.name},\n\nWhile you were away:\n\n${lines.join('\n')}\n\nOpen your inbox: ${base}/inbox\n`,
  })
  await markDigested(kernel, userId)
  return true
}
