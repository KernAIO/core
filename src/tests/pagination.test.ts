/**
 * Cursor pagination.
 *
 * Every paged endpoint has to walk a list exactly once: no row skipped, no row repeated, and a stable
 * order even when the sort key ties (the activity log sorts by timestamp, and bulk imports happily
 * write a hundred rows with the same one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as activity from '../modules/core/services/activity.js'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { expectRejection, startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let owner: TestUser
let api: CoreApi
let workspaceId: string
const memberIds: string[] = []
const MEMBERS = 11
const NOTIFICATIONS = 17
const ACTIVITY = 25

interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Walk every page and return the ids in order, failing loudly if the walk does not terminate.
 * `limit` is deliberately co-prime with the row count so the last page is partial.
 */
async function walk<T extends { id: string }>(
  fetch: (cursor?: string) => Promise<Page<T>>,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page: Page<T> = await fetch(cursor)
    expect(page.items.length, 'a page must never exceed the limit').toBeLessThanOrEqual(limit)
    if (page.nextCursor) expect(page.items.length, 'only the last page may be short').toBe(limit)
    ids.push(...page.items.map((i) => i.id))
    cursor = page.nextCursor ?? undefined
    pages++
    if (pages > 100) throw new Error('pagination did not terminate')
  } while (cursor)
  return { ids, pages }
}

function expectExactlyOnce(ids: string[], expected: string[]) {
  expect(new Set(ids).size, 'no id may repeat across pages').toBe(ids.length)
  expect([...ids].sort()).toEqual([...expected].sort())
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Owner' })
  workspaceId = (
    await owner.api.workspaces.create({ name: 'Paging', slug: `paging-${Date.now().toString(36)}` })
  ).id
  api = await core.apiOf(owner.id)
  memberIds.push(owner.id)

  for (let i = 0; i < MEMBERS - 1; i++) {
    const user = await core.signUp({ name: `Member ${i}` })
    const [invitation] = await api.workspaces.invitations.create({
      workspaceId,
      invites: [{ email: user.email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })
    await user.api.workspaces.invitations.accept({ token: await core.inviteToken(invitation!.id) })
    memberIds.push(user.id)
  }

  for (let i = 0; i < NOTIFICATIONS; i++)
    await core.kernel.call('core.notifications.create', {
      userId: owner.id,
      workspaceId,
      module: 'core',
      type: 'core.system',
      title: `Notification ${i}`,
      body: null,
      object: null,
      url: null,
      data: {},
      groupKey: null,
      actorId: null,
    })

  // A third of the activity rows share one timestamp so the (occurredAt, id) tiebreak is exercised.
  const shared = new Date('2024-03-01T09:00:00.000Z').toISOString()
  for (let i = 0; i < ACTIVITY; i++)
    await activity.record(core.kernel, {
      workspaceId: workspaceId as never,
      module: 'core',
      object: { module: 'core', type: 'note', id: `01920000-0000-7000-8000-${String(i).padStart(12, '0')}` },
      action: 'created',
      actorId: null,
      changes: [],
      data: { i },
      occurredAt: i % 3 === 0 ? shared : new Date(Date.UTC(2024, 2, 2, 0, 0, i)).toISOString(),
    })
})
afterAll(async () => {
  await core?.stop()
})

describe('members', () => {
  it('returns every member exactly once across pages', async () => {
    const { ids, pages } = await walk(
      (cursor) => api.workspaces.members.list({ workspaceId, limit: 4, cursor }),
      4,
    )
    expect(pages).toBe(Math.ceil(MEMBERS / 4) + (MEMBERS % 4 === 0 ? 1 : 0))
    expect(ids).toHaveLength(MEMBERS)
    expect(new Set(ids).size).toBe(MEMBERS)

    const all = await api.workspaces.members.list({ workspaceId, limit: 200 })
    expectExactlyOnce(
      ids,
      all.items.map((m) => m.id),
    )
    // the paged order matches the unpaged order
    expect(ids).toEqual(all.items.map((m) => m.id))
  })

  it('keeps filters applied on every page', async () => {
    const { ids } = await walk(
      (cursor) => api.workspaces.members.list({ workspaceId, status: 'active', limit: 3, cursor }),
      3,
    )
    expect(ids).toHaveLength(MEMBERS)
  })
})

describe('notifications', () => {
  it('returns every notification exactly once, newest first', async () => {
    const { ids } = await walk((cursor) => api.notifications.list({ limit: 5, cursor, unreadOnly: false }), 5)
    const all = await api.notifications.list({ limit: 200, unreadOnly: false })
    expect(ids).toHaveLength(NOTIFICATIONS)
    expectExactlyOnce(
      ids,
      all.items.map((n) => n.id),
    )
    expect(ids).toEqual(all.items.map((n) => n.id))
  })
})

describe('activity log', () => {
  it('returns every event exactly once even when timestamps tie', async () => {
    const { ids } = await walk((cursor) => api.workspaces.audit({ workspaceId, limit: 4, cursor }), 4)
    const all = await api.workspaces.audit({ workspaceId, limit: 200 })
    expect(ids.length).toBe(all.items.length)
    expect(ids.length).toBeGreaterThanOrEqual(ACTIVITY)
    expectExactlyOnce(
      ids,
      all.items.map((a) => a.id),
    )
    expect(ids).toEqual(all.items.map((a) => a.id))

    // the shared timestamp really is shared, otherwise the tiebreak was never exercised
    const times = all.items.map((a) => a.occurredAt)
    expect(new Set(times).size).toBeLessThan(times.length)
  })

  it('paginates a filtered view consistently', async () => {
    const { ids } = await walk(
      (cursor) => api.workspaces.audit({ workspaceId, module: 'core', limit: 6, cursor }),
      6,
    )
    const all = await api.workspaces.audit({ workspaceId, module: 'core', limit: 200 })
    expectExactlyOnce(
      ids,
      all.items.map((a) => a.id),
    )
  })
})

describe('user directory', () => {
  it('returns every visible user exactly once', async () => {
    const { ids } = await walk((cursor) => api.users.directory({ limit: 4, cursor }), 4)
    const all = await api.users.directory({ limit: 200 })
    expect(ids).toHaveLength(MEMBERS - 1) // everyone but the caller
    expectExactlyOnce(
      ids,
      all.items.map((u) => u.id),
    )
  })
})

describe('instance admin listings', () => {
  it('pages users and workspaces exactly once', async () => {
    await core.promoteToInstanceAdmin(owner.id)
    const adminApi = await core.apiOf(owner.id)

    const users = await walk((cursor) => adminApi.admin.users({ limit: 4, cursor }), 4)
    const allUsers = await adminApi.admin.users({ limit: 200 })
    expect(users.ids).toHaveLength(allUsers.items.length)
    expect(allUsers.total).toBe(allUsers.items.length)
    expectExactlyOnce(
      users.ids,
      allUsers.items.map((u) => u.id),
    )

    const workspaces = await walk((cursor) => adminApi.admin.workspaces({ limit: 1, cursor }), 1)
    const allWorkspaces = await adminApi.admin.workspaces({ limit: 200 })
    expectExactlyOnce(
      workspaces.ids,
      allWorkspaces.items.map((w) => w.id),
    )
  })
})

describe('cursor validation', () => {
  it('rejects a malformed cursor rather than silently restarting the walk', async () => {
    await expectRejection(
      () => api.workspaces.members.list({ workspaceId, limit: 5, cursor: 'not-a-cursor' }),
      'BAD_REQUEST',
    )
    await expectRejection(
      () => api.notifications.list({ limit: 5, cursor: 'zzzz', unreadOnly: false }),
      'BAD_REQUEST',
    )
  })

  it('returns no cursor when the page exactly drains the list', async () => {
    const page = await api.workspaces.members.list({ workspaceId, limit: MEMBERS })
    expect(page.items).toHaveLength(MEMBERS)
    expect(page.nextCursor).toBeNull()
  })
})
