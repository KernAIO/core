/**
 * Getting your data out, and getting it deleted.
 *
 * `core.export.run` was a permission key with no procedure behind it, and `core.workspace.delete`
 * only set `archived_at`. There was no close-account path at all — `users.status` has had a
 * `'deleted'` value since the first migration that nothing in the API could set. The terms, the
 * privacy policy, the docs site, the billing module's suspension copy and ADR 0003 all promise both,
 * and for an EU customer erasure is an obligation rather than a feature.
 */
import { gunzipSync } from 'node:zlib'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deletionRequests, memberships, user, workspaces } from '../modules/core/schema/index.js'
import {
  cancelWorkspaceDeletion,
  purgeAccount,
  purgeWorkspace,
  scheduleAccountDeletion,
  scheduleWorkspaceDeletion,
} from '../modules/core/services/deletion.js'
import {
  build,
  collect,
  type ExportDocument,
  expireStale,
  get as getExport,
} from '../modules/core/services/exports.js'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

let core: TestCore
let owner: TestUser
let member: TestUser
let workspaceId: string

const stamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/**
 * Call the export/erasure surface the way a client would: a bearer token, a real route.
 *
 * The body is deliberately loose — these routes are plain Fastify handlers rather than oRPC
 * procedures, so there is no generated client type to hold them to, and pretending otherwise here
 * would only be a cast wearing a better name.
 */
async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | null,
  payload?: object,
  // biome-ignore lint/suspicious/noExplicitAny: an untyped JSON body from a raw route
): Promise<{ status: number; body: any }> {
  const res = await core.service.app!.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload } : {}),
  })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Owner' })
  workspaceId = (await owner.api.workspaces.create({ name: 'Exportable', slug: `exp-${stamp()}` })).id
  owner.api = await core.apiOf(owner.id)
  member = await core.signUp({ name: 'Member' })
  await core.kernel.database.db
    .insert(memberships)
    .values({ workspaceId, userId: member.id, role: 'member', status: 'active' })
  core.service.deps.principals.invalidate([member.id])
  member.api = await core.apiOf(member.id)
}, 180_000)

afterAll(async () => core?.stop())

describe('workspace export', () => {
  it('is refused to a member without core.export.run', async () => {
    const res = await call('POST', '/api/core/exports', member.token, { workspaceId })
    expect(res.status, 'a plain member must not be able to export the workspace').toBe(403)
  })

  it('is refused to somebody with no membership at all', async () => {
    const stranger = await core.signUp({ name: 'Stranger' })
    const res = await call('POST', '/api/core/exports', stranger.token, { workspaceId })
    expect(res.status).toBe(403)
  })

  it('is refused to an anonymous caller', async () => {
    const res = await call('POST', '/api/core/exports', null, { workspaceId })
    expect(res.status).toBe(401)
  })

  it('records the request for an owner and hands the work to a job', async () => {
    const res = await call('POST', '/api/core/exports', owner.token, { workspaceId })
    expect(res.status, 'accepted, not completed inline').toBe(202)
    expect(res.body.status).toBe('pending')
    expect(res.body.workspaceId).toBe(workspaceId)
  })

  /**
   * The archive itself. Core's own rows, a *manifest* of the files rather than their bytes, and an
   * explicit list of the modules that hold data this archive does not contain.
   */
  it('builds an archive holding core’s data and a manifest of the files', async () => {
    const started = await call('POST', '/api/core/exports', owner.token, { workspaceId })
    const id = started.body.id as string
    const record = await build(core.kernel, id, workspaceId)
    expect(record.status, record.error ?? 'export failed').toBe('ready')
    expect(record.sizeBytes).toBeGreaterThan(0)

    const link = await call('GET', `/api/core/exports/${id}/download?workspaceId=${workspaceId}`, owner.token)
    expect(link.status).toBe(200)
    expect(link.body.url, 'a ready export must be downloadable').toContain('http')

    const fetched = await fetch(link.body.url as string)
    expect(fetched.ok, `download failed: ${fetched.status}`).toBe(true)
    const doc = JSON.parse(
      gunzipSync(Buffer.from(await fetched.arrayBuffer())).toString('utf8'),
    ) as ExportDocument

    expect(doc.format).toBe('kern.workspace-export/1')
    expect((doc.workspace as { id: string }).id).toBe(workspaceId)
    expect(doc.core.members?.length, 'the members belong in the export').toBe(2)
    expect(Array.isArray(doc.files), 'files are a manifest, not bytes').toBe(true)
  })

  /**
   * Core owns `mod_core` and must never read another module's schema, so an export asks each module
   * for its share. No module answers `<module>.export` yet — recording that is the honest outcome,
   * because an archive labelled "export" containing only core's rows would let a customer believe
   * they had their data.
   */
  it('names every module whose data it could not collect', async () => {
    const { document, followUps } = await collect(core.kernel, workspaceId)
    expect(followUps.length, 'core hosts five feature modules; none can export yet').toBeGreaterThan(0)
    for (const note of followUps) expect(note).toMatch(/no export procedure/)
    expect(document.followUps).toEqual(followUps)
  })

  it('refuses to list the exports of a workspace the caller is not in', async () => {
    const other = await core.signUp({ name: 'Other' })
    const otherWs = (await other.api.workspaces.create({ name: 'Theirs', slug: `oth-${stamp()}` })).id
    const res = await call('GET', `/api/core/exports?workspaceId=${otherWs}`, owner.token)
    expect(res.status).toBe(403)
  })

  /**
   * A second click must not build a second copy of the whole workspace.
   *
   * The route answers 202 and then appears to do nothing for a while, which is exactly the shape
   * that gets clicked twice — and each build reads every table the workspace has and writes another
   * archive into the bucket. A finished export is not in the way: asking again once one is `ready`
   * starts a fresh one.
   */
  it('hands back the build already running instead of starting a second', async () => {
    const first = await call('POST', '/api/core/exports', owner.token, { workspaceId })
    const second = await call('POST', '/api/core/exports', owner.token, { workspaceId })
    expect(second.body.id, 'two clicks must not put two copies of the workspace in the bucket').toBe(
      first.body.id,
    )
    await build(core.kernel, first.body.id as string, workspaceId)
  })

  /**
   * An export is a complete copy of a workspace sitting behind a presigned URL. One that is never
   * cleaned up is a second, permanent, unmanaged home for the customer's data — the opposite of what
   * an export is for.
   */
  it('deletes the archive once its window closes, and keeps the record of it', async () => {
    const started = await call('POST', '/api/core/exports', owner.token, { workspaceId })
    const id = started.body.id as string
    await build(core.kernel, id, workspaceId)
    await core.kernel.database.db.execute(
      sql`update mod_core.data_exports set expires_at = now() - interval '1 day' where id = ${id}`,
    )
    expect(await expireStale(core.kernel)).toBeGreaterThan(0)
    // The row survives on purpose: that an export was taken, and by whom, is itself a fact about the
    // data leaving, and deleting the evidence along with the file would keep the wrong half.
    expect((await getExport(core.kernel, workspaceId, id)).status).toBe('expired')
  })
})

/**
 * ADR 0003 §6: a customer who has stopped paying "can always still read and export what is theirs",
 * and the billing module promises exactly that to users in five locales.
 *
 * The kernel makes a suspended workspace read-only in `workspaceScoped`, keyed on the *declared*
 * method, so a job somebody starts is a write and would be refused there. This is the assertion that
 * keeps the promise true: the same suspension that stops an ordinary write must not stop an export.
 */
describe('while the subscription is suspended', () => {
  let suspendedWs: string
  let biller: TestUser

  beforeAll(async () => {
    biller = await core.signUp({ name: 'Biller' })
    suspendedWs = (await biller.api.workspaces.create({ name: 'Unpaid', slug: `susp-${stamp()}` })).id
    await core.promoteToInstanceAdmin(biller.id)
    biller.api = await core.apiOf(biller.id)

    const billing = core.moduleApi('billing', await core.principalOf(biller.id)) as {
      plans: { upsert(i: Record<string, unknown>): Promise<{ id: string }> }
      admin: {
        setPlan(i: Record<string, unknown>): Promise<unknown>
        setStatus(i: Record<string, unknown>): Promise<unknown>
      }
    }
    const plan = await billing.plans.upsert({
      slug: `suspendable-${stamp()}`,
      name: 'Suspendable',
      description: '',
      priceMinor: 100,
      currency: 'usd',
      interval: 'month',
      perSeat: false,
      trialDays: 0,
      limits: {
        seats: null,
        storageBytes: null,
        modules: null,
        sso: true,
        auditRetentionDays: null,
        apiRateLimit: null,
      },
      stripePriceId: null,
      highlights: [],
      published: true,
      order: 1,
    })
    await billing.admin.setPlan({ workspaceId: suspendedWs, planId: plan.id })
    await billing.admin.setStatus({ workspaceId: suspendedWs, status: 'suspended' })
  }, 120_000)

  it('is genuinely read-only, or the next assertions prove nothing', async () => {
    const err = await biller.api.workspaces
      .update({ workspaceId: suspendedWs, patch: { name: 'Renamed' } })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err, 'an ordinary write should be refused while suspended').toBeTruthy()
  })

  it('still lets the customer export what is theirs', async () => {
    const started = await call('POST', '/api/core/exports', biller.token, { workspaceId: suspendedWs })
    expect(started.status, 'a suspended customer must still be able to export').toBe(202)
    const record = await build(core.kernel, started.body.id as string, suspendedWs)
    expect(record.status, record.error ?? 'export failed while suspended').toBe('ready')
  })

  /**
   * Deliberately exempt too, and for a different reason: the right to have your data deleted does
   * not pause because an invoice failed. A customer who can neither use nor leave is the worst
   * possible reading of "read-only".
   */
  it('still lets the customer delete the workspace', async () => {
    const res = await call('POST', `/api/core/workspaces/${suspendedWs}/deletion`, biller.token, {})
    expect(res.status, 'erasure must not be gated by a payment problem').toBe(202)
    await cancelWorkspaceDeletion(core.kernel, { workspaceId: suspendedWs, actorId: biller.id })
  })
})

describe('workspace deletion', () => {
  it('is refused to a member without core.workspace.delete', async () => {
    const res = await call('POST', `/api/core/workspaces/${workspaceId}/deletion`, member.token, {})
    expect(res.status).toBe(403)
  })

  it('schedules a grace period, archives immediately, and can be called off', async () => {
    const res = await call('POST', `/api/core/workspaces/${workspaceId}/deletion`, owner.token, {})
    expect(res.status).toBe(202)
    expect(res.body.status).toBe('scheduled')
    expect(new Date(res.body.purgeAfter).getTime(), 'the terms describe a window').toBeGreaterThan(
      Date.now() + 20 * 86_400_000,
    )

    const [archived] = await core.kernel.database.db
      .select({ archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    expect(archived?.archivedAt, 'the workspace stops being usable at once').toBeTruthy()

    const cancelled = await call('DELETE', `/api/core/workspaces/${workspaceId}/deletion`, owner.token)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.status).toBe('cancelled')

    const [restored] = await core.kernel.database.db
      .select({ archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    expect(restored?.archivedAt, 'cancelling puts the workspace back').toBeNull()
  })

  it('actually removes the rows when the grace period is over', async () => {
    const doomed = await core.signUp({ name: 'Leaving' })
    const wsId = (await doomed.api.workspaces.create({ name: 'Gone', slug: `gone-${stamp()}` })).id
    const api = await core.apiOf(doomed.id)
    await api.workspaces.invitations.create({
      workspaceId: wsId,
      invites: [{ email: `x-${stamp()}@example.test`, role: 'member' }],
    })

    const req = await scheduleWorkspaceDeletion(core.kernel, {
      workspaceId: wsId,
      requestedBy: doomed.id,
    })
    const done = await purgeWorkspace(core.kernel, req.id)
    expect(done.status, done.error ?? 'purge failed').toBe('done')

    const left = await core.kernel.database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
    expect(left.length, 'the workspace row must be gone, not archived').toBe(0)
    const stillMembers = await core.kernel.database.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.workspaceId, wsId))
    expect(stillMembers.length).toBe(0)

    /*
     * Every module core hosts owns its own schema, so erasure asks rather than reaches in. Nothing
     * answers `<module>.erase` yet, and the request records that instead of reporting an erasure
     * that did not happen.
     */
    expect(done.followUps.length, 'modules that still hold data must be named').toBeGreaterThan(0)
    for (const note of done.followUps) expect(note).toMatch(/no erase procedure/)
  })
})

describe('closing an account', () => {
  it('is refused while you are the only owner of a workspace others are still in', async () => {
    const err = await scheduleAccountDeletion(core.kernel, { userId: owner.id, requestedBy: owner.id })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err, 'deleting the last owner would strand the other member').toBeTruthy()
    expect(String((err as Error).message)).toMatch(/only owner/i)
  })

  it('schedules, suspends the account at once, and can be called off', async () => {
    const leaver = await core.signUp({ name: 'Leaver' })
    const res = await call('POST', '/api/core/account/deletion', leaver.token, {})
    expect(res.status).toBe(202)
    expect(res.body.subjectKind).toBe('account')

    const [suspended] = await core.kernel.database.db
      .select({ status: user.status })
      .from(user)
      .where(eq(user.id, leaver.id))
    expect(suspended?.status, 'closed means closed on every device now').toBe('suspended')

    const [open] = await core.kernel.database.db
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(eq(deletionRequests.subjectId, leaver.id))
    expect(open).toBeTruthy()
  })

  /**
   * A workspace purge deletes rows; an account purge anonymises the one row. `activity_events`,
   * `files.uploaded_by` and every module's audit trail point at this id, so hard-deleting it would
   * either cascade through other tenants' history or leave references that read as corruption.
   * Nothing about the person survives, and the workspaces they acted in stay coherent.
   */
  it('anonymises the person rather than orphaning every record they touched', async () => {
    const leaver = await core.signUp({ name: 'Erasable' })
    const before = leaver.email
    const req = await scheduleAccountDeletion(core.kernel, {
      userId: leaver.id,
      requestedBy: leaver.id,
    })
    const done = await purgeAccount(core.kernel, req.id)
    expect(done.status, done.error ?? 'purge failed').toBe('done')

    const [row] = await core.kernel.database.db.select().from(user).where(eq(user.id, leaver.id))
    expect(row!.status).toBe('deleted')
    expect(row!.email).not.toBe(before)
    expect(row!.name).toBe('Deleted user')
    expect(row!.emailVerified).toBe(false)

    // The address is free again, so a later account can take it.
    const reused = await core.signUp({ email: before, name: 'Someone else' })
    expect(reused.id).not.toBe(leaver.id)
  })
})
