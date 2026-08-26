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
})
