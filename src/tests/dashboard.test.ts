/**
 * The workspace dashboard.
 *
 * The part worth testing is not that a layout round-trips — it is the resolution table. Three
 * policies times three states of the world (a personal layout, only a workspace one, neither) is
 * nine answers, and the whole point of resolving them on the server is that the client never has to
 * reimplement them. Beyond that: `locked` has to be refused by the server rather than by a hidden
 * button, the workspace row has to be unique despite its null `user_id`, and one workspace must not
 * be able to read another's.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { expectRejection, startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let owner: TestUser
let member: TestUser
let ownerApi: CoreApi
let memberApi: CoreApi
let ws: string

const item = (widget: string, x = 0, y = 0) => ({
  i: randomUUID(),
  widget,
  x,
  y,
  w: 4,
  h: 2,
  size: 'm' as const,
  settings: {},
})

const setPolicy = (policy: 'locked' | 'default' | 'open') =>
  ownerApi.dashboard.settings.set({ workspaceId: ws, surface: 'home', policy })

const clearPersonal = async (api: CoreApi) => {
  await api.dashboard.reset({ workspaceId: ws, surface: 'home' })
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Owner' })
  member = await core.signUp({ name: 'Member' })
  ws = (await owner.api.workspaces.create({ name: 'Dash', slug: `dash-${Date.now().toString(36)}` })).id
  ownerApi = await core.apiOf(owner.id)
  const [invitation] = await ownerApi.workspaces.invitations.create({
    workspaceId: ws,
    invites: [{ email: member.email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
  })
  await (await core.apiOf(member.id)).workspaces.invitations.accept({
    token: await core.inviteToken(invitation!.id),
  })
  memberApi = await core.apiOf(member.id)
}, 120_000)

afterAll(async () => core?.stop())

describe('defaults', () => {
  it('a workspace nobody has configured resolves to a preset', async () => {
    const view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    expect(view.policy).toBe('default')
    expect(view.source).toBe('preset')
    expect(view.defaultPresetId).toBe('my-work')
    expect(view.canCustomise).toBe(true)
    // A preset carries no items on the wire: the app expands it, because a widget id is a client
    // concept the server has never heard of.
    expect(view.layout.items).toEqual([])
  })
})

describe('the resolution table', () => {
  it('default: personal beats workspace beats preset', async () => {
    await setPolicy('default')
    await ownerApi.dashboard.settings.saveWorkspace({
      workspaceId: ws,
      surface: 'home',
      items: [item('core.waiting-on-you')],
      presetId: null,
    })
    await clearPersonal(memberApi)

    let view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    expect(view.source).toBe('workspace')
    expect(view.layout.items[0]?.widget).toBe('core.waiting-on-you')

    await memberApi.dashboard.save({
      workspaceId: ws,
      surface: 'home',
      items: [item('tracker.assigned-to-me')],
      presetId: null,
    })
    view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    expect(view.source).toBe('personal')
    expect(view.layout.items[0]?.widget).toBe('tracker.assigned-to-me')
  })

  it('open ignores the workspace layout entirely', async () => {
    await setPolicy('open')
    await clearPersonal(memberApi)
    const view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    // The workspace row still exists from the previous test — under `open` it is simply not consulted.
    expect(view.source).toBe('preset')
    expect(view.layout.items).toEqual([])
  })

  it('locked serves the workspace layout even when the person has one of their own', async () => {
    await setPolicy('default')
    await memberApi.dashboard.save({
      workspaceId: ws,
      surface: 'home',
      items: [item('chat.unread-conversations')],
      presetId: null,
    })
    await setPolicy('locked')

    const view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    expect(view.source).toBe('workspace')
    expect(view.layout.items[0]?.widget).toBe('core.waiting-on-you')
    expect(view.canCustomise).toBe(false)
  })
})

describe('locked is a policy, not a hidden button', () => {
  it('refuses a personal save', async () => {
    await setPolicy('locked')
    const err = await expectRejection(
      () =>
        memberApi.dashboard.save({
          workspaceId: ws,
          surface: 'home',
          items: [item('core.waiting-on-you')],
          presetId: null,
        }),
      'CONFLICT',
    )
    expect(JSON.stringify(err)).toContain('core.dashboard.locked')
  })

  it('still lets the owner set the workspace layout', async () => {
    await setPolicy('locked')
    const saved = await ownerApi.dashboard.settings.saveWorkspace({
      workspaceId: ws,
      surface: 'home',
      items: [item('core.waiting-on-you'), item('core.activity', 4)],
      presetId: null,
    })
    expect(saved.items).toHaveLength(2)
  })
})

describe('authorisation', () => {
  it('a member cannot read or write the workspace settings', async () => {
    await expectRejection(
      () => memberApi.dashboard.settings.get({ workspaceId: ws, surface: 'home' }),
      'FORBIDDEN',
    )
    await expectRejection(
      () => memberApi.dashboard.settings.set({ workspaceId: ws, surface: 'home', policy: 'open' }),
      'FORBIDDEN',
    )
    await expectRejection(
      () =>
        memberApi.dashboard.settings.saveWorkspace({
          workspaceId: ws,
          surface: 'home',
          items: [],
          presetId: null,
        }),
      'FORBIDDEN',
    )
  })

  it('an outsider cannot read the dashboard at all', async () => {
    const outsider = await core.signUp({ name: 'Outsider' })
    await expectRejection(() => outsider.api.dashboard.get({ workspaceId: ws, surface: 'home' }), 'FORBIDDEN')
  })
})

describe('the stored layout', () => {
  it('drops a duplicate instance id and clamps geometry that is out of range', async () => {
    await setPolicy('default')
    // Written straight past the API, the way an older app version or a hand-edit would.
    const twin = randomUUID()
    await core.kernel.database.db.execute(sql`
      update mod_core.dashboard_layouts
      set items = ${JSON.stringify([
        { i: twin, widget: 'core.waiting-on-you', x: 0, y: 0, w: 4, h: 2, size: 'm', settings: {} },
        { i: twin, widget: 'core.activity', x: 99, y: -4, w: 40, h: 0, size: 'nonsense', settings: {} },
      ])}::jsonb
      where workspace_id = ${ws} and user_id is null and surface = 'home'
    `)

    await clearPersonal(memberApi)
    const view = await memberApi.dashboard.get({ workspaceId: ws, surface: 'home' })
    expect(view.layout.items).toHaveLength(1)
    const [only] = view.layout.items
    expect(only?.x).toBeLessThanOrEqual(11)
    expect(only?.y).toBeGreaterThanOrEqual(0)
    expect(only?.w).toBeLessThanOrEqual(12)
    expect(only?.h).toBeGreaterThanOrEqual(1)
  })

  it('keeps exactly one workspace row however often it is saved', async () => {
    for (const widget of ['core.activity', 'core.waiting-on-you', 'core.activity']) {
      await ownerApi.dashboard.settings.saveWorkspace({
        workspaceId: ws,
        surface: 'home',
        items: [item(widget)],
        presetId: null,
      })
    }
    const rows = await core.kernel.database.db.execute(sql`
      select count(*)::int as n from mod_core.dashboard_layouts
      where workspace_id = ${ws} and user_id is null and surface = 'home'
    `)
    expect((rows.rows[0] as { n: number }).n).toBe(1)
  })
})

describe('tenant isolation', () => {
  it('row-level security hides another workspace’s layouts', async () => {
    const other = await core.signUp({ name: 'Other' })
    const wsB = (
      await other.api.workspaces.create({ name: 'Other', slug: `other-${Date.now().toString(36)}` })
    ).id
    const otherApi = await core.apiOf(other.id)
    await otherApi.dashboard.save({
      workspaceId: wsB,
      surface: 'home',
      items: [item('core.activity')],
      presetId: null,
    })

    const pool = await core.restrictedPool()
    try {
      const seen = await pool.query(
        `select set_config('app.workspace_id', $1, false),
                (select count(*)::int from mod_core.dashboard_layouts) as n`,
        [ws],
      )
      // Standing in workspace A, workspace B's rows do not exist.
      const { rows } = await pool.query(
        `select count(*)::int as n from mod_core.dashboard_layouts where workspace_id = $1`,
        [wsB],
      )
      expect(rows[0].n).toBe(0)
      expect(seen.rowCount).toBe(1)
    } finally {
      await pool.end()
    }
  })
})
