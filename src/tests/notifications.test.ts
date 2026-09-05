/**
 * Notifications: the inbox lifecycle (create → counts → markRead → archive) and the preference
 * matrix that decides which channels a notification is allowed to use.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { notifications as notificationsTable } from '../modules/core/schema/index.js'
import { inQuietHours, resolveChannels, runDigest } from '../modules/core/services/notifications.js'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let user: TestUser
let api: CoreApi
let wsA: string
let wsB: string
/** jobs enqueued since the last reset, so the tests can see push fan-out decisions */
let enqueued: Array<{ name: string; data: unknown }> = []

const notify = (over: Record<string, unknown> = {}) =>
  core.kernel.call<{ id: string } | null>('core.notifications.create', {
    userId: user.id,
    workspaceId: wsA,
    module: 'core',
    type: 'core.system',
    title: 'Something happened',
    body: null,
    object: null,
    url: null,
    data: {},
    groupKey: null,
    actorId: null,
    ...over,
  })

const reset = async () => {
  await core.kernel.database.db.delete(notificationsTable).where(eq(notificationsTable.userId, user.id))
  await api.notifications.updateSettings({ emailDigest: 'daily', quietHours: null, preferences: [] })
  enqueued = []
}

beforeAll(async () => {
  core = await startCore()
  user = await core.signUp({ name: 'Reader' })
  const stamp = Date.now().toString(36)
  wsA = (await user.api.workspaces.create({ name: 'A', slug: `notif-a-${stamp}` })).id
  wsB = (await user.api.workspaces.create({ name: 'B', slug: `notif-b-${stamp}` })).id
  api = await core.apiOf(user.id)

  const send = core.kernel.jobs.send.bind(core.kernel.jobs)
  core.kernel.jobs.send = async (name, data, opts) => {
    enqueued.push({ name, data })
    return send(name, data, opts)
  }
})
afterEach(async () => {
  await reset()
})
afterAll(async () => {
  await core?.stop()
})

describe('inbox lifecycle', () => {
  it('creates, counts, marks read and archives', async () => {
    const first = await notify({ title: 'One' })
    const second = await notify({ title: 'Two' })
    const other = await notify({ title: 'Elsewhere', workspaceId: wsB })
    const mention = await notify({ type: 'core.mention', title: 'You were mentioned' })
    expect(first).not.toBeNull()

    const inbox = await api.notifications.list({ limit: 20, unreadOnly: false })
    expect(inbox.items.map((x) => x.title)).toEqual(['You were mentioned', 'Elsewhere', 'Two', 'One'])
    expect(inbox.items.every((x) => x.readAt === null)).toBe(true)

    // counts are grouped per workspace, and `core.mention` is urgent so it also counts as a mention
    const counts = await api.notifications.counts()
    expect(counts.find((c) => c.workspaceId === wsA)).toEqual({
      workspaceId: wsA,
      unread: 3,
      mentions: 1,
    })
    expect(counts.find((c) => c.workspaceId === wsB)).toEqual({
      workspaceId: wsB,
      unread: 1,
      mentions: 0,
    })

    // marking two by id only touches those two
    expect(await api.notifications.markRead({ ids: [first!.id, second!.id], all: false })).toEqual({
      updated: 2,
    })
    expect((await api.notifications.list({ limit: 20, unreadOnly: true })).items.map((x) => x.title)).toEqual(
      ['You were mentioned', 'Elsewhere'],
    )
    // and marking them again is a no-op
    expect(await api.notifications.markRead({ ids: [first!.id], all: false })).toEqual({ updated: 0 })

    // marking a whole workspace leaves the other one alone
    expect(await api.notifications.markRead({ workspaceId: wsA, all: false })).toEqual({ updated: 1 })
    expect((await api.notifications.counts()).map((c) => c.workspaceId)).toEqual([wsB])

    // archiving removes it from the inbox entirely and implies read
    const archived = await api.notifications.archive({ id: other!.id })
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.readAt).not.toBeNull()
    expect(
      (await api.notifications.list({ limit: 20, unreadOnly: false })).items.map((x) => x.id),
    ).not.toContain(other!.id)
    expect(await api.notifications.counts()).toEqual([])

    // `all: true` covers every workspace at once
    await notify({ title: 'Later A' })
    await notify({ title: 'Later B', workspaceId: wsB })
    expect((await api.notifications.markRead({ all: true })).updated).toBe(2)
    expect(await api.notifications.counts()).toEqual([])
    expect(mention).not.toBeNull()
  })

  it('rejects markRead without a target and archive of somebody else’s notification', async () => {
    await expect(api.notifications.markRead({ all: false })).rejects.toThrow()

    const stranger = await core.signUp()
    const theirs = await core.kernel.call<{ id: string }>('core.notifications.create', {
      userId: stranger.id,
      workspaceId: null,
      module: 'core',
      type: 'core.system',
      title: 'Not yours',
      body: null,
      object: null,
      url: null,
      data: {},
      groupKey: null,
      actorId: null,
    })
    await expect(api.notifications.archive({ id: theirs.id })).rejects.toThrow()
  })

  it('lists the notification types every hosted module declared', async () => {
    const types = await api.notifications.types()
    const byType = new Map(types.map((t) => [t.type, t]))
    expect([...byType.keys()]).toEqual(
      expect.arrayContaining([
        'core.invitation.received',
        'core.mention',
        'core.member.joined',
        'core.system',
      ]),
    )
    expect(byType.get('core.mention')?.urgent).toBe(true)
    expect(byType.get('core.member.joined')?.defaults).toEqual({ inapp: true, push: false, email: false })
    expect(byType.get('core.mention')?.module).toBe('core')
  })
})

describe('preferences decide which channels are used', () => {
  const stored = (id: string) =>
    core.kernel.database.db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.id, id))
      .limit(1)
      .then((r) => r[0])

  it('drops the notification entirely when every channel is switched off', async () => {
    await api.notifications.updateSettings({
      emailDigest: 'daily',
      quietHours: null,
      preferences: [{ type: 'core.system', workspaceId: null, inapp: false, push: false, email: false }],
    })

    expect(await notify({ title: 'Silenced' })).toBeNull()
    const rows = await core.kernel.database.db
      .select()
      .from(notificationsTable)
      .where(and(eq(notificationsTable.userId, user.id), eq(notificationsTable.type, 'core.system')))
    expect(rows).toEqual([])
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toEqual([])
  })

  it('keeps a row for the email trail but hides it from the inbox when in-app is off', async () => {
    await api.notifications.updateSettings({
      emailDigest: 'daily',
      quietHours: null,
      preferences: [{ type: 'core.system', workspaceId: null, inapp: false, push: false, email: true }],
    })

    const created = await notify({ title: 'Email only' })
    expect(created).not.toBeNull()
    const row = await stored(created!.id)
    expect(row?.emailQueued).toBe(true)
    expect(row?.readAt).not.toBeNull()
    expect(row?.archivedAt).not.toBeNull()

    expect((await api.notifications.list({ limit: 20, unreadOnly: false })).items).toEqual([])
    expect(await api.notifications.counts()).toEqual([])
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toEqual([])
  })

  it('lets a per-workspace preference override the global one', async () => {
    await api.notifications.updateSettings({
      emailDigest: 'daily',
      quietHours: null,
      preferences: [
        { type: 'core.system', workspaceId: null, inapp: false, push: false, email: false },
        { type: 'core.system', workspaceId: wsA, inapp: true, push: false, email: false },
      ],
    })

    expect(await notify({ title: 'Muted globally', workspaceId: wsB })).toBeNull()
    expect(await notify({ title: 'But not in A', workspaceId: wsA })).not.toBeNull()
    expect(
      (await api.notifications.list({ limit: 20, unreadOnly: false })).items.map((x) => x.title),
    ).toEqual(['But not in A'])
  })

  it('enqueues a push only when the push channel is on', async () => {
    // `core.member.joined` defaults to in-app only
    await notify({ type: 'core.member.joined', title: 'Someone joined' })
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toEqual([])

    // `core.mention` defaults to all three channels
    await notify({ type: 'core.mention', title: 'Mentioned' })
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toHaveLength(1)
  })

  it('resolveChannels prefers workspace over global over module defaults', () => {
    const def = {
      module: 'core',
      type: 'core.system',
      label: 'System',
      defaults: { inapp: true, push: false, email: true },
      urgent: false,
    }
    const settings = {
      preferences: [
        { type: 'core.system', workspaceId: null, inapp: false, push: true, email: false },
        { type: 'core.system', workspaceId: 'ws-1', inapp: true, push: false, email: false },
      ],
    } as never

    expect(resolveChannels(def, null, 'core.system', 'ws-1')).toEqual({
      inapp: true,
      push: false,
      email: true,
      urgent: false,
    })
    expect(resolveChannels(def, settings, 'core.system', 'ws-1')).toEqual({
      inapp: true,
      push: false,
      email: false,
      urgent: false,
    })
    expect(resolveChannels(def, settings, 'core.system', 'ws-2')).toEqual({
      inapp: false,
      push: true,
      email: false,
      urgent: false,
    })
    // an unknown type falls back to the built-in defaults
    expect(resolveChannels(undefined, null, 'made.up', null)).toEqual({
      inapp: true,
      push: true,
      email: false,
      urgent: false,
    })
  })

  it('inQuietHours handles windows that wrap midnight', () => {
    const at = (iso: string) => new Date(iso)
    const night = { start: '22:00', end: '07:00', timezone: 'UTC' }
    const day = { start: '09:00', end: '17:00', timezone: 'UTC' }

    expect(inQuietHours(null)).toBe(false)
    expect(inQuietHours(night, at('2024-01-01T23:30:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2024-01-01T03:00:00Z'))).toBe(true)
    expect(inQuietHours(night, at('2024-01-01T12:00:00Z'))).toBe(false)
    expect(inQuietHours(day, at('2024-01-01T12:00:00Z'))).toBe(true)
    expect(inQuietHours(day, at('2024-01-01T18:00:00Z'))).toBe(false)
    // the window is evaluated in the user's timezone, not the server's
    expect(inQuietHours({ ...night, timezone: 'Asia/Tehran' }, at('2024-01-01T19:00:00Z'))).toBe(true)
    // a bad timezone must not throw or silently mute everything
    expect(inQuietHours({ ...night, timezone: 'Not/AZone' }, at('2024-01-01T23:30:00Z'))).toBe(false)
  })

  it('suppresses push during quiet hours but lets urgent notifications through', async () => {
    const hhmm = new Date().toISOString().slice(11, 16)
    const end = `${String((Number(hhmm.slice(0, 2)) + 2) % 24).padStart(2, '0')}:${hhmm.slice(3)}`
    await api.notifications.updateSettings({
      emailDigest: 'daily',
      quietHours: { start: hhmm, end, timezone: 'UTC' },
      preferences: [{ type: 'core.system', workspaceId: null, inapp: true, push: true, email: false }],
    })

    await notify({ title: 'Quiet' })
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toEqual([])

    // `core.mention` is urgent: quiet hours do not apply
    await notify({ type: 'core.mention', title: 'Urgent' })
    expect(enqueued.filter((j) => j.name === 'core.push.send')).toHaveLength(1)
  })
})

describe('email digest', () => {
  /** run the cron pass and return the digests it mailed to our user */
  const digest = async () => {
    const before = core.mailbox.length
    await runDigest({ kernel: core.kernel, principal: core.kernel.system }, core.service.deps)
    return core.mailbox.slice(before).filter((m) => m.to === user.email)
  }

  it('emails queued unread notifications and never sends twice', async () => {
    await api.notifications.updateSettings({ emailDigest: 'hourly', quietHours: null, preferences: [] })
    await notify({ title: 'Digest me', type: 'core.system' })

    const sent = await digest()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('1 unread notification')
    expect(sent[0]!.text).toContain('Digest me')

    // a second pass has nothing left to send for this user
    expect(await digest()).toEqual([])
  })

  it('respects emailDigest: off', async () => {
    await api.notifications.updateSettings({ emailDigest: 'off', quietHours: null, preferences: [] })
    await notify({ title: 'Never mailed', type: 'core.system' })

    expect(await digest()).toEqual([])
  })

  it('does not queue an email for a type whose email channel is off', async () => {
    await api.notifications.updateSettings({
      emailDigest: 'hourly',
      quietHours: null,
      preferences: [{ type: 'core.system', workspaceId: null, inapp: true, push: false, email: false }],
    })
    await notify({ title: 'In-app only', type: 'core.system' })

    expect(await digest()).toEqual([])
  })

  it('skips notifications the user has already read', async () => {
    await api.notifications.updateSettings({ emailDigest: 'hourly', quietHours: null, preferences: [] })
    await notify({ title: 'Read before the digest ran', type: 'core.system' })
    await api.notifications.markRead({ all: true })

    expect(await digest()).toEqual([])
  })

  /**
   * A relay refusing one address used to end the whole run.
   *
   * `mailer.send` threw straight out of the loop, so everybody the pass had not reached yet got
   * nothing and kept their `emailedAt` unset — and because the job is hourly, the same departed
   * employee's 550 broke the same run every hour, for ever.
   */
  it('keeps going when the relay refuses one recipient, and stops retrying that address', async () => {
    // Two accounts of their own, so neither carries a `lastDigestAt` from an earlier test.
    const refused = await core.signUp({ name: 'Departed employee' })
    const reachable = await core.signUp({ name: 'Second reader' })
    const queue = (userId: string, title: string) =>
      core.kernel.call('core.notifications.create', {
        userId,
        workspaceId: null,
        module: 'core',
        type: 'core.system',
        title,
        body: null,
        object: null,
        url: null,
        data: {},
        groupKey: null,
        actorId: null,
      })
    await queue(refused.id, 'For an address that no longer exists')
    await queue(reachable.id, 'For somebody who is still here')

    const delivered: string[] = []
    const real = core.service.deps.mailer
    core.service.deps.mailer = {
      async send(msg) {
        if (msg.to === refused.email)
          throw Object.assign(new Error('550 5.1.1 Recipient address rejected: user unknown'), {
            responseCode: 550,
          })
        delivered.push(msg.to)
      },
    }
    try {
      const run = () => runDigest({ kernel: core.kernel, principal: core.kernel.system }, core.service.deps)
      expect(await run()).toEqual({ sent: 1, failed: 1, abandoned: 1 })
      expect(delivered).toEqual([reachable.email])

      // A permanent refusal is not tried again an hour later: the notification is still in the
      // person's inbox in the app, and the address is not worth another thousand attempts.
      delivered.length = 0
      expect(await run()).toEqual({ sent: 0, failed: 0, abandoned: 0 })
    } finally {
      core.service.deps.mailer = real
    }
  })
})
