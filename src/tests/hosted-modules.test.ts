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

  it('applied the tracker migrations into its own schema', async () => {
    const { rows } = await core.kernel.database.db.execute<{ count: number }>(
      // biome-ignore lint/style/noUnusedTemplateLiteral: drizzle needs a tagged template
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
})
