/**
 * Tenant isolation.
 *
 * Two layers have to hold independently:
 *   1. the API refuses a workspace id the caller is not a member of, however it is spelled;
 *   2. the row-level security policies refuse the rows even when a query slips past the API — which is
 *      only observable under a role that cannot bypass RLS, so the suite opens a second connection as
 *      an unprivileged role (the application role in a hardened deployment).
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { expectRejection, startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let alice: TestUser
let bob: TestUser
let aliceApi: CoreApi
let bobApi: CoreApi
let wsA: string
let wsB: string

const objectRef = (id: string) => ({ module: 'core', type: 'note', id })
const noteA = '01920000-0000-7000-8000-00000000a001'
const noteB = '01920000-0000-7000-8000-00000000b001'

beforeAll(async () => {
  core = await startCore()
  alice = await core.signUp({ name: 'Alice' })
  bob = await core.signUp({ name: 'Bob' })
  const stamp = Date.now().toString(36)
  wsA = (await alice.api.workspaces.create({ name: 'Alpha', slug: `alpha-${stamp}` })).id
  wsB = (await bob.api.workspaces.create({ name: 'Beta', slug: `beta-${stamp}` })).id
  aliceApi = await core.apiOf(alice.id)
  bobApi = await core.apiOf(bob.id)

  // one activity row and one search document in each workspace
  for (const [workspaceId, id, title] of [
    [wsA, noteA, 'Alpha private roadmap'],
    [wsB, noteB, 'Beta private roadmap'],
  ] as const) {
    await core.kernel.call('core.activity.record', {
      workspaceId,
      module: 'core',
      object: objectRef(id),
      action: 'created',
      actorId: null,
      changes: [],
      data: { secret: title },
    })
    await core.kernel.call('core.search.index', {
      documents: [
        {
          workspaceId,
          object: objectRef(id),
          title,
          body: `body of ${title}`,
          url: `/notes/${id}`,
          icon: null,
          acl: null,
          updatedAt: new Date().toISOString(),
          attributes: {},
        },
      ],
    })
  }
})
afterAll(async () => {
  await core?.stop()
})

describe('the API refuses a forged workspace id', () => {
  it('refuses the audit log of a workspace the caller does not belong to', async () => {
    expect((await aliceApi.workspaces.audit({ workspaceId: wsA, limit: 20 })).items.length).toBe(1)
    await expectRejection(() => aliceApi.workspaces.audit({ workspaceId: wsB, limit: 20 }), 'FORBIDDEN')
    await expectRejection(() => bobApi.workspaces.audit({ workspaceId: wsA, limit: 20 }), 'FORBIDDEN')
  })

  it('refuses search in another workspace and never leaks its documents', async () => {
    const own = await aliceApi.search({ workspaceId: wsA, q: 'roadmap', limit: 20 })
    expect(own.hits.map((h) => h.title)).toEqual(['Alpha private roadmap'])

    await expectRejection(() => aliceApi.search({ workspaceId: wsB, q: 'roadmap', limit: 20 }), 'FORBIDDEN')
  })

  it('refuses workspace reads, member lists and module state across the boundary', async () => {
    await expectRejection(() => aliceApi.workspaces.get({ workspaceId: wsB }), 'FORBIDDEN')
    await expectRejection(
      () => aliceApi.workspaces.members.list({ workspaceId: wsB, limit: 10 }),
      'FORBIDDEN',
    )
    await expectRejection(() => aliceApi.workspaces.modules.list({ workspaceId: wsB }), 'FORBIDDEN')
    await expectRejection(
      () => aliceApi.workspaces.update({ workspaceId: wsB, patch: { name: 'taken over' } }),
      'FORBIDDEN',
    )
  })

  it('hides files of another workspace even though they are addressed by bare id', async () => {
    const ticket = await bobApi.files.createUpload({
      workspaceId: wsB,
      name: 'secret.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    })
    const fileId = ticket.file.id

    expect((await bobApi.files.get({ id: fileId })).name).toBe('secret.pdf')
    // Alice knows the id but not the workspace: the file must not exist for her
    await expectRejection(() => aliceApi.files.get({ id: fileId }), 'NOT_FOUND')
    await expectRejection(
      () => aliceApi.files.downloadUrl({ id: fileId, disposition: 'inline', thumbnail: false }),
      'NOT_FOUND',
    )
    await expectRejection(() => aliceApi.files.delete({ id: fileId }), 'NOT_FOUND')
  })

  it('hides notifications addressed to somebody else', async () => {
    await core.kernel.call('core.notifications.create', {
      userId: bob.id,
      workspaceId: wsB,
      module: 'core',
      type: 'core.system',
      title: 'For Bob only',
      body: null,
      object: null,
      url: null,
      data: {},
      groupKey: null,
      actorId: null,
    })
    const mine = await aliceApi.notifications.list({ limit: 50, unreadOnly: false })
    expect(mine.items.map((x) => x.title)).not.toContain('For Bob only')

    const theirs = await bobApi.notifications.list({ limit: 50, unreadOnly: false })
    expect(theirs.items.map((x) => x.title)).toContain('For Bob only')
  })
})

describe('row-level security under a role that cannot bypass it', () => {
  it('shows only the rows of the workspace bound to the connection', async () => {
    const pool = await core.restrictedPool()
    const client = await pool.connect()
    try {
      const readAs = async (workspaceId: string | null, table: string) => {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId ?? ''])
        const res = await client.query(`select workspace_id from mod_core.${table}`)
        await client.query('rollback')
        return res.rows.map((r: { workspace_id: string }) => r.workspace_id)
      }

      for (const table of ['activity_events', 'search_documents']) {
        expect(await readAs(wsA, table), `${table} bound to A`).toEqual([wsA])
        expect(await readAs(wsB, table), `${table} bound to B`).toEqual([wsB])
        // no binding at all → nothing is visible
        expect(await readAs(null, table), `${table} unbound`).toEqual([])
        // the '*' sentinel some modules use is not accepted by the core policies
        expect(await readAs('*', table), `${table} wildcard`).toEqual([])
      }
    } finally {
      client.release()
    }
  })

  it('refuses to write a row belonging to another workspace (WITH CHECK)', async () => {
    const pool = await core.restrictedPool()
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('select set_config($1, $2, true)', ['app.workspace_id', wsA])
      await expect(
        client.query(
          `insert into mod_core.activity_events
             (workspace_id, module, object_module, object_type, object_id, action, changes, data)
           values ($1, 'core', 'core', 'note', $2, 'forged', '[]'::jsonb, '{}'::jsonb)`,
          [wsB, noteB],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('rollback')
    } finally {
      client.release()
    }
  })

  it('protects every tenant table in the core schema', async () => {
    // Derived from the schema, not from a list of tables someone remembered to add: a new table
    // with a `workspace_id` and no policy has to fail this, which is the only way the test is worth
    // running. The exceptions are the tables that are deliberately global — the reason for each is
    // in `migrations/0001_rls.sql` — and taking one off this list is a decision, not an oversight.
    const GLOBAL_ON_PURPOSE = new Set([
      'files',
      'invitations',
      'memberships',
      'notifications',
      // MCP: a token or consent belongs to one user and names one workspace, but is looked up by
      // its owner (or the client) rather than through a workspace-scoped query — the same shape as
      // Better Auth's api_keys. Access is decided in code, in `services/mcp.ts`.
      'mcp_codes',
      'mcp_consents',
      'mcp_tokens',
    ])

    const { rows } = await core.kernel.database.db.execute<{
      tablename: string
      rowsecurity: boolean
      forced: boolean
    }>(
      sql`select t.tablename, t.rowsecurity, c.relforcerowsecurity as forced
          from pg_tables t
          join pg_namespace n on n.nspname = t.schemaname
          join pg_class c on c.relnamespace = n.oid and c.relname = t.tablename
          where t.schemaname = 'mod_core'
            and exists (
              select 1 from information_schema.columns col
              where col.table_schema = t.schemaname
                and col.table_name = t.tablename
                and col.column_name = 'workspace_id'
            )
          order by t.tablename`,
    )

    // a query that stopped returning rows would make everything below vacuously true
    expect(rows.length).toBeGreaterThan(8)

    const tenant = rows.filter((r) => !GLOBAL_ON_PURPOSE.has(r.tablename))
    expect(tenant.length).toBeGreaterThan(0)
    for (const row of tenant) {
      expect(row.rowsecurity, `${row.tablename} carries a workspace_id and needs RLS`).toBe(true)
      // FORCE matters: without it the table owner (which the app usually is) silently bypasses RLS
      expect(row.forced, `${row.tablename} should FORCE row level security`).toBe(true)
    }

    // an exception that has since been secured means the list is stale and hiding a real table
    for (const row of rows.filter((r) => GLOBAL_ON_PURPOSE.has(r.tablename)))
      expect(row.rowsecurity, `${row.tablename} is listed as global but is now secured`).toBe(false)

    const names = new Set(rows.map((r) => r.tablename))
    for (const listed of GLOBAL_ON_PURPOSE)
      expect(names.has(listed), `${listed} is listed as an exception but is not a tenant table`).toBe(true)
  })
})

describe('service principals', () => {
  it('may cross workspaces (that is what makes them services)', async () => {
    const audit = await core.system.workspaces.audit({ workspaceId: wsB, limit: 10 })
    expect(audit.items.length).toBe(1)
  })

  it('but a user principal cannot borrow one by claiming the workspace id twice', async () => {
    // `workspaceScoped` reads the workspace id straight from the input, so there is no second place
    // to smuggle one in; the membership check is the only gate and it is not optional.
    await expectRejection(
      () => aliceApi.workspaces.audit({ workspaceId: wsB, module: 'core', limit: 10 }),
      'FORBIDDEN',
    )
  })
})
