import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * The feature modules this service hosts, exercised through the service — not through their own
 * test harness.
 *
 * A module can be complete, fully tested in its own repository and published, and still be
 * unreachable because nothing loads it: the tracker sat like that, with 139 procedures and a
 * finished interface calling an endpoint that answered 404. Its own suite could never have caught
 * that. This one asks the running service what it hosts, and then uses it.
 */

let core: TestCore
let owner: TestUser
let workspaceId: string

/** The tracker's shape, narrowed to what this test uses; core does not depend on its types. */
type TrackerApi = {
  projects: {
    create(input: Record<string, unknown>): Promise<{ id: string; key: string; name: string }>
    list(input: Record<string, unknown>): Promise<{ items: Array<{ id: string }> }>
  }
  issues: {
    create(input: Record<string, unknown>): Promise<{ id: string; key: string; title: string }>
    get(input: Record<string, unknown>): Promise<{ id: string; title: string }>
  }
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Tracker Owner' })
  const workspace = await owner.api.workspaces.create({
    name: 'Hosted',
    slug: `hosted-${Date.now().toString(36)}`,
  })
  workspaceId = workspace.id
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('hosted feature modules', () => {
  it('registers the tracker, so /api/tracker is served by this service', () => {
    const hosted = core.kernel.manifests().map((m) => m.id)
    expect(hosted).toContain('core')
    expect(hosted).toContain('tracker')
    expect(core.kernel.registry.get('tracker')?.router).toBeTypeOf('function')
  })

  it('registers hr, so /api/hr is served by this service', () => {
    const hosted = core.kernel.manifests().map((m) => m.id)
    expect(hosted).toContain('hr')
    expect(core.kernel.registry.get('hr')?.router).toBeTypeOf('function')
  })

  it('applied the hr migrations into its own schema', async () => {
    const { rows } = await core.kernel.database.db.execute<{ count: number }>(
      (await import('drizzle-orm'))
        .sql`select count(*)::int as count from information_schema.tables where table_schema = 'mod_hr'`,
    )
    expect(rows[0]?.count ?? 0).toBeGreaterThan(10)
  })

  /**
   * The manifest is what an administrator's switchboard is built from. A module can declare
   * capabilities perfectly and still have them invisible if the manifest does not carry them
   * across the service boundary — which is a different failure from the module being absent.
   */
  it('carries hr capabilities through to the manifest', () => {
    const hr = core.kernel.manifests().find((m) => m.id === 'hr')
    const ids = (hr?.capabilities ?? []).map((c) => c.id)
    expect(ids).toContain('core')
    expect(ids).toContain('offices')
    expect(ids).toContain('calendars')
    // `core` is the module's foundation and must not be offered as a switch.
    expect(hr?.capabilities.find((c) => c.id === 'core')?.required).toBe(true)
  })

  it('serves a hosted hr procedure, and creates the default office on enable', async () => {
    type HrApi = {
      offices: {
        resolveFor(i: Record<string, unknown>): Promise<{ timezone: string; primaryOfficeId: string | null }>
      }
      people: {
        create(i: Record<string, unknown>): Promise<{ id: string; displayName: string }>
      }
    }
    const hr = core.moduleApi('hr', await owner.principal()) as HrApi

    const person = await hr.people.create({ workspaceId, displayName: 'Ayşe Yılmaz' })
    expect(person.displayName).toBe('Ayşe Yılmaz')

    // Enabling HR built one office from the workspace country, and the new person landed in it —
    // so the resolution ladder has a rung even though nobody has heard the word "office".
    const resolved = await hr.offices.resolveFor({ workspaceId, personId: person.id })
    expect(resolved.primaryOfficeId).not.toBeNull()
    expect(resolved.timezone).not.toBe('UTC')
  })

  it('applied the tracker migrations into its own schema', async () => {
    const { rows } = await core.kernel.database.db.execute<{ count: number }>(
      (await import('drizzle-orm'))
        .sql`select count(*)::int as count from information_schema.tables where table_schema = 'mod_tracker'`,
    )
    expect(rows[0]?.count ?? 0).toBeGreaterThan(10)
  })

  it('creates a project and an issue through the hosted router', async () => {
    const tracker = core.moduleApi('tracker', await owner.principal()) as TrackerApi

    const project = await tracker.projects.create({
      workspaceId,
      key: 'HST',
      name: 'Hosted project',
      template: 'software',
    })
    expect(project.key).toBe('HST')

    const issue = await tracker.issues.create({
      workspaceId,
      projectId: project.id,
      title: 'Served by core',
    })
    expect(issue.key).toMatch(/^HST-\d+$/)

    const read = await tracker.issues.get({ workspaceId, issueId: issue.id })
    expect(read.title).toBe('Served by core')
  })

  it('refuses a caller who is not a member of the workspace', async () => {
    const outsider = await core.signUp({ name: 'Outsider' })
    const tracker = core.moduleApi('tracker', await outsider.principal()) as TrackerApi
    await expect(tracker.projects.list({ workspaceId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('registers inventory, so /api/inventory is served by this service', () => {
    const hosted = core.kernel.manifests().map((m) => m.id)
    expect(hosted).toContain('inventory')
    expect(core.kernel.registry.get('inventory')?.router).toBeTypeOf('function')
  })

  it('applied the inventory migrations into its own schema', async () => {
    const { rows } = await core.kernel.database.db.execute<{ count: number }>(
      (await import('drizzle-orm'))
        .sql`select count(*)::int as count from information_schema.tables where table_schema = 'mod_inventory'`,
    )
    expect(rows[0]?.count ?? 0).toBeGreaterThanOrEqual(7)
  })

  it('creates an asset through the hosted router and assigns its tag', async () => {
    type InventoryApi = {
      assets: {
        create(
          input: Record<string, unknown>,
        ): Promise<{ id: string; code: string; name: string; status: string }>
        get(input: Record<string, unknown>): Promise<{ code: string }>
      }
    }
    const inventory = core.moduleApi('inventory', await owner.principal()) as InventoryApi

    const asset = await inventory.assets.create({ workspaceId, name: 'Hosted laptop' })
    expect(asset.code).toMatch(/^INV-\d{4}$/)
    expect(asset.status).toBe('in_stock')

    const read = await inventory.assets.get({ workspaceId, assetId: asset.id })
    expect(read.code).toBe(asset.code)

    // A second asset gets the next number — the counter is per workspace.
    const second = await inventory.assets.create({ workspaceId, name: 'Hosted phone' })
    expect(second.code).not.toBe(asset.code)
  })

  it('registers meet, so /api/meet is served by this service', () => {
    const hosted = core.kernel.manifests().map((m) => m.id)
    expect(hosted).toContain('meet')
    expect(core.kernel.registry.get('meet')?.router).toBeTypeOf('function')
  })

  it('applied the meet migrations into its own schema', async () => {
    const { rows } = await core.kernel.database.db.execute<{ count: number }>(
      (await import('drizzle-orm'))
        .sql`select count(*)::int as count from information_schema.tables where table_schema = 'mod_meet'`,
    )
    // rooms, meetings, participants, invites, plus the kernel's own __migrations.
    expect(rows[0]?.count ?? 0).toBeGreaterThanOrEqual(4)
  })
})

/**
 * Meetings arrive switched off, proved against the running service rather than argued.
 *
 * This is the reproduction the whole `meet` design rests on. `isEnabled` answers
 * `row?.enabled ?? true`, so adding a sixth module to this image switches it **on** in every
 * workspace on every instance the night it rolls out — including workspaces created long before it
 * existed, whose administrators never saw a decision to make. The only thing standing between that
 * and a Meetings nav item that appears unannounced and fails on click is that both of `meet`'s
 * capabilities default to off and neither is `required`.
 *
 * So the workspace below is created and **nothing is touched on its switchboard**, which is the
 * state every existing workspace on every instance will be in. `module-meet`'s own suite asserts the
 * same three things against a stubbed `core.settings.getModule`; this asserts them against the real
 * settings store, which is the thing that will actually answer in production.
 */
describe('a workspace that has never opened Settings → Modules', () => {
  type MeetApi = {
    config: {
      get(i: Record<string, unknown>): Promise<{
        configured: boolean
        mediaUrl: string | null
        reachable: boolean
        maxParticipants: number
      }>
    }
    meetings: {
      start(i: Record<string, unknown>): Promise<{ token: string }>
      join(i: Record<string, unknown>): Promise<{ token: string }>
    }
  }

  let untouched: string
  let meet: MeetApi
  /**
   * A client re-read **after** the workspace exists.
   *
   * `owner.api` is bound to the principal resolved at sign-up, whose memberships do not include a
   * workspace created afterwards — so `workspaceScoped` refuses it with FORBIDDEN, which looks
   * exactly like the failure these tests are here to detect.
   */
  let admin: Awaited<ReturnType<typeof core.apiOf>>

  beforeAll(async () => {
    const workspace = await owner.api.workspaces.create({
      name: 'Untouched',
      slug: `untouched-${Date.now().toString(36)}`,
    })
    untouched = workspace.id
    admin = await core.apiOf(owner.id)
    meet = core.moduleApi('meet', await owner.principal()) as MeetApi
  }, 60_000)

  it('has meet switched on as a module, which is exactly why the rest of this matters', async () => {
    // Asserted rather than assumed. If this ever answers false the three tests below would pass for
    // an entirely different reason, and the property they exist to prove would go unchecked.
    expect(await core.kernel.isModuleEnabled(untouched, 'meet')).toBe(true)
  })

  it('answers 404 — not 403 — from every meetings procedure', async () => {
    /*
     * 404 is the honest answer and 403 is not: `forbidden` says the surface exists and you may not
     * have it, which is false for a workspace that never asked for meetings, and it contradicts a
     * shell that has already hidden the navigation.
     */
    await expect(meet.meetings.start({ workspaceId: untouched })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      meet.meetings.join({ workspaceId: untouched, meetingId: '00000000-0000-4000-8000-000000000001' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('still answers config.get, which is how an administrator finds out why', async () => {
    // The deliberate exception. This is the question somebody asks *because* meetings do not work,
    // so gating it on `calls` would answer 404 to the only person who needed it. No LiveKit is
    // configured in a test run, and `configured: false` is the true and useful answer.
    const config = await meet.config.get({ workspaceId: untouched })
    expect(config.configured).toBe(false)
    expect(config.reachable).toBe(false)
    expect(config.maxParticipants).toBe(20)
  })

  it('offers calls and rooms as switches, both off, neither forced', async () => {
    // What the administrator is shown. A capability marked `required` is never offered as a switch,
    // which is the one state this module must not be in.
    const listed = await admin.workspaces.modules.list({ workspaceId: untouched })
    const manifest = listed.find((m) => m.manifest.id === 'meet')?.manifest
    expect(manifest?.capabilities.map((c) => c.id)).toEqual(['calls', 'rooms'])
    expect(manifest?.capabilities.filter((c) => c.required || c.defaultEnabled)).toEqual([])
    expect(
      listed.find((m) => m.manifest.id === 'meet')?.state.capabilities,
      'nothing resolved on for a workspace that saved nothing',
    ).toEqual([])
  })

  it('starts answering the moment an administrator switches calls on', async () => {
    /*
     * The other direction, and it is what makes the 404s above mean something: without it they
     * would be equally consistent with a module that is broken, unhosted, or refusing for a reason
     * nobody has established.
     *
     * `meetings.join` still refuses here — with no LiveKit configured there is nothing to mint a
     * token with — but the refusal changes from NOT_FOUND to the module saying so, which is the
     * whole difference between "this workspace has no such feature" and "this instance has no media
     * server".
     */
    await admin.workspaces.modules.updateSettings({
      workspaceId: untouched,
      moduleId: 'meet',
      settings: { $capabilities: { calls: true } },
    })
    core.kernel.settings.invalidate(untouched, 'meet')

    const listed = await admin.workspaces.modules.list({ workspaceId: untouched })
    expect(listed.find((m) => m.manifest.id === 'meet')?.state.capabilities).toEqual(['calls'])
    const refusal = await meet.meetings
      .start({ workspaceId: untouched })
      .then(() => 'no error')
      .catch((e: { code?: string }) => e.code ?? String(e))
    expect(refusal, 'the capability is on; it is LiveKit that is missing').toBe('UNAVAILABLE')
  })
})
