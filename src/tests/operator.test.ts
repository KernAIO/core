/**
 * Four boundaries that were declared and not enforced.
 *
 * - An operator reading a customer's workspace left no trace anywhere, in a product whose docs
 *   promised "an instance-level audit log of admin actions".
 * - `auditRetentionDays` was an entitlement key read by nothing, while the pricing page sold three
 *   different retention periods.
 * - `core.users.getMany` handed out email addresses for arbitrary user ids to any service, with no
 *   shared-workspace check, while its sibling `getPublic` had one.
 * - `files.attachedTo` was taken as given, so an upload could name another tenant's object and a
 *   module the workspace does not have.
 */
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activityEvents, memberships, searchDocuments } from '../modules/core/schema/index.js'
import { ACCESS_CROSSED_ACTION, shouldRecord } from '../modules/core/services/access.js'
import { pruneWorkspaceAudit, runAuditRetention } from '../modules/core/services/retention.js'
import { expectRejection, startCore, type TestCore, type TestUser } from '../testing/harness.js'

let core: TestCore
let owner: TestUser
let operator: TestUser
let workspaceId: string
let n = 0
const slug = (p: string) => `${p}-${(n++).toString(36)}-${Date.now().toString(36)}`

/** The audit row is written off an event handler, so it lands a tick or two after the call. */
async function auditRows(action: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await core.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(activityEvents)
        .where(and(eq(activityEvents.workspaceId, workspaceId), eq(activityEvents.action, action))),
    )
    if (rows.length) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
  return []
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Customer' })
  operator = await core.signUp({ name: 'Operator' })
  workspaceId = (await owner.api.workspaces.create({ name: 'Private', slug: slug('private') })).id
  await core.promoteToInstanceAdmin(operator.id)
  owner.api = await core.apiOf(owner.id)
}, 180_000)
afterAll(async () => core?.stop())

describe('an operator reaching into a workspace', () => {
  it('leaves a row naming who, what and which procedure', async () => {
    const api = await core.apiOf(operator.id)
    // An instance admin resolves as `owner` of every workspace, so this succeeds — that is the
    // design, and the defect was that it succeeded invisibly.
    await api.workspaces.get({ workspaceId })

    const rows = await auditRows(ACCESS_CROSSED_ACTION)
    expect(rows.length, 'support reading a customer’s data must not look like the customer').toBe(1)
    const row = rows[0]!
    expect(row.actorId).toBe(operator.id)
    const data = row.data as { procedure?: string; via?: string; actorEmail?: string }
    expect(data.procedure).toBe('workspaces.get')
    expect(data.via).toBe('instance_admin')
    expect(data.actorEmail).toBe(operator.email)
  })

  it('is visible to the workspace’s own owners, not only to the operator', async () => {
    // The whole point. It goes into `activity_events`, which `workspaces.audit` already serves to
    // anyone holding `core.audit.view` — the workspace's owners and admins.
    const page = await owner.api.workspaces.audit({ workspaceId, limit: 50 })
    const crossed = page.items.filter((e) => e.action === ACCESS_CROSSED_ACTION)
    expect(crossed.length).toBeGreaterThan(0)
    expect(crossed[0]?.actorId).toBe(operator.id)
  })

  it('records nothing when a member reads their own workspace', async () => {
    const before = (await auditRows(ACCESS_CROSSED_ACTION)).length
    await owner.api.workspaces.get({ workspaceId })
    await new Promise((r) => setTimeout(r, 200))
    const after = (await auditRows(ACCESS_CROSSED_ACTION)).length
    expect(after, 'a member has a membership; there is nothing to record').toBe(before)
  })

  it('does not record a machine acting on its own', () => {
    // A service principal crosses on internal plumbing and names nobody. A row for it would be noise
    // in a log a person has to read — but a service credential carrying a *user* is a person.
    const base = {
      workspaceId,
      procedure: 'chat.channels.list',
      requestId: 'r',
      ip: '127.0.0.1',
      at: new Date().toISOString(),
    }
    expect(
      shouldRecord({
        ...base,
        via: 'service',
        principal: { kind: 'service', userId: null, email: null, service: 'chat' },
      }),
    ).toBe(false)
    expect(
      shouldRecord({
        ...base,
        via: 'service',
        principal: { kind: 'service', userId: operator.id, email: null, service: 'chat' },
      }),
    ).toBe(true)
    expect(
      shouldRecord({
        ...base,
        via: 'instance_admin',
        principal: { kind: 'user', userId: operator.id, email: operator.email, service: null },
      }),
    ).toBe(true)
  })
})

describe('audit retention', () => {
  const old = (days: number) => new Date(Date.now() - days * 86_400_000)

  async function seed(days: number[]) {
    await core.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx.insert(activityEvents).values(
        days.map((d) => ({
          workspaceId,
          module: 'core',
          objectModule: 'core',
          objectType: 'workspace',
          objectId: workspaceId,
          action: 'seeded',
          actorId: owner.id,
          occurredAt: old(d),
        })),
      ),
    )
  }
  const seededCount = async () => {
    const [row] = await core.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(activityEvents)
        .where(and(eq(activityEvents.workspaceId, workspaceId), eq(activityEvents.action, 'seeded'))),
    )
    return row?.n ?? 0
  }

  it('keeps everything when nothing is billing, which is every self-hosted instance', async () => {
    await seed([1, 30, 400])
    const pass = await runAuditRetention(core.kernel)
    // `entitlements.of` answers UNLIMITED with no I/O when no billing module responds. This is the
    // default path on every install, so it has to be cheap and it must never throw.
    expect(pass.limited).toBe(0)
    expect(pass.deleted).toBe(0)
    expect(await seededCount()).toBe(3)
  })

  it('removes exactly the rows past the window and leaves the rest', async () => {
    expect(await seededCount()).toBe(3)
    const deleted = await pruneWorkspaceAudit(core.kernel, workspaceId, 90)
    expect(deleted, 'only the 400-day-old row is past a 90-day window').toBe(1)
    expect(await seededCount()).toBe(2)
  })

  it('treats a missing or nonsensical window as no window at all', async () => {
    expect(await pruneWorkspaceAudit(core.kernel, workspaceId, 0)).toBe(0)
    expect(await pruneWorkspaceAudit(core.kernel, workspaceId, -5)).toBe(0)
    expect(await seededCount()).toBe(2)
  })

  it('prunes one workspace without touching another', async () => {
    const other = (await owner.api.workspaces.create({ name: 'Other', slug: slug('other') })).id
    await core.kernel.database.withWorkspace(other, (tx) =>
      tx.insert(activityEvents).values({
        workspaceId: other,
        module: 'core',
        objectModule: 'core',
        objectType: 'workspace',
        objectId: other,
        action: 'seeded',
        actorId: owner.id,
        occurredAt: old(400),
      }),
    )
    await pruneWorkspaceAudit(core.kernel, workspaceId, 1)
    const [row] = await core.kernel.database.withWorkspace(other, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(activityEvents)
        .where(eq(activityEvents.workspaceId, other)),
    )
    expect(row?.n, 'a retention pass must be per workspace, not per instance').toBe(1)
  })
})

describe('core.users.getMany', () => {
  it('hands out no email address when the caller names no workspace', async () => {
    const rows = await core.kernel.call<Array<{ id: string; email?: string; name: string }>>(
      'core.users.getMany',
      { ids: [owner.id, operator.id] },
      core.kernel.system,
    )
    expect(rows.length).toBe(2)
    // The leak: this used to return every address for any list of uuids a module cared to send.
    for (const r of rows) expect(r.email, 'an address needs a workspace to justify it').toBeUndefined()
    // …while still answering what a caller actually renders.
    expect(rows.map((r) => r.name).sort()).toEqual(['Customer', 'Operator'])
  })

  it('hands out an address only for a member of the workspace the caller names', async () => {
    const rows = await core.kernel.call<Array<{ id: string; email?: string }>>(
      'core.users.getMany',
      { ids: [owner.id, operator.id], workspaceId },
      core.kernel.system,
    )
    // The operator is an instance admin, not a member: naming the workspace does not conjure one.
    expect(rows.map((r) => r.id)).toEqual([owner.id])
    expect(rows[0]?.email).toBe(owner.email)
  })

  it('answers nothing for a workspace the ids have nothing to do with', async () => {
    const stranger = await core.signUp({ name: 'Stranger' })
    const rows = await core.kernel.call<unknown[]>(
      'core.users.getMany',
      { ids: [stranger.id], workspaceId },
      core.kernel.system,
    )
    expect(rows).toEqual([])
  })
})

describe('files.attachedTo', () => {
  const upload = (attachedTo: { module: string; type: string; id: string }) =>
    owner.api.files.createUpload({
      workspaceId,
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 12,
      attachedTo: attachedTo as never,
    })

  it('refuses a module this instance does not have', async () => {
    await expectRejection(
      () => upload({ module: 'notamodule', type: 'thing', id: workspaceId }),
      'BAD_REQUEST',
    )
  })

  it('refuses a module the workspace has switched off', async () => {
    await owner.api.workspaces.modules.setEnabled({ workspaceId, moduleId: 'tracker', enabled: false })
    try {
      await expectRejection(() => upload({ module: 'tracker', type: 'issue', id: workspaceId }), 'CONFLICT')
    } finally {
      await owner.api.workspaces.modules.setEnabled({ workspaceId, moduleId: 'tracker', enabled: true })
    }
  })

  it('refuses an object that provably belongs to another workspace', async () => {
    const otherWs = (await owner.api.workspaces.create({ name: 'Theirs', slug: slug('theirs') })).id
    const objectId = crypto.randomUUID()
    // `search_documents` is core's own index of module objects. A row for this ref in another
    // workspace is proof the object is not this one's — the one cross-tenant check core can make
    // without reaching into a module's schema.
    await core.kernel.database.withWorkspace(otherWs, (tx) =>
      tx.insert(searchDocuments).values({
        workspaceId: otherWs,
        module: 'tracker',
        objectType: 'issue',
        objectId,
        title: 'Theirs',
        url: '/x',
      }),
    )
    await expectRejection(() => upload({ module: 'tracker', type: 'issue', id: objectId }), 'NOT_FOUND')
  })

  it('accepts an attachment to an enabled module', async () => {
    const ticket = await upload({ module: 'tracker', type: 'issue', id: crypto.randomUUID() })
    expect(ticket.file.attachedTo?.module).toBe('tracker')
  })

  it('still accepts an upload with no attachment at all', async () => {
    const ticket = await owner.api.files.createUpload({
      workspaceId,
      name: 'loose.txt',
      mimeType: 'text/plain',
      size: 4,
    })
    expect(ticket.file.attachedTo).toBeNull()
  })
})

/** Referenced so the import cannot rot: memberships is used by the harness setup above. */
void memberships
