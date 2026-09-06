/**
 * Workspace search: ranking and visibility.
 *
 * Documents are indexed by modules through `core.search.index`; the query has to weight a title match
 * above a body match and must never return a document whose ACL does not name the caller (directly, by
 * group, or by builtin role).
 */
import type { core as coreContracts } from '@kernhq/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let owner: TestUser
let member: TestUser
let guest: TestUser
let ownerApi: CoreApi
let memberApi: CoreApi
let guestApi: CoreApi
let workspaceId: string
let groupId: string

let seq = 0
const docId = () => `01920000-0000-7000-8000-${String(seq++).padStart(12, '0')}`

async function index(doc: {
  id?: string
  title: string
  body?: string | null
  acl?: string[] | null
  authz?: coreContracts.SearchDocument['authz']
  module?: string
  type?: string
  updatedAt?: string
}) {
  const id = doc.id ?? docId()
  const document: coreContracts.SearchDocument = {
    workspaceId: workspaceId as coreContracts.SearchDocument['workspaceId'],
    object: { module: doc.module ?? 'core', type: doc.type ?? 'note', id },
    title: doc.title,
    body: doc.body ?? null,
    url: `/notes/${id}`,
    icon: null,
    acl: doc.acl ?? null,
    authz: doc.authz ?? null,
    updatedAt: doc.updatedAt ?? new Date().toISOString(),
    attributes: {},
  }
  await core.kernel.call('core.search.index', { documents: [document] })
  return id
}

async function invite(user: TestUser, role: 'member' | 'guest') {
  const [invitation] = await ownerApi.workspaces.invitations.create({
    workspaceId,
    invites: [{ email: user.email, role, roleIds: [], groupIds: [], guestScopes: [] }],
  })
  await user.api.workspaces.invitations.accept({ token: await core.inviteToken(invitation!.id) })
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Owner' })
  member = await core.signUp({ name: 'Member' })
  guest = await core.signUp({ name: 'Guest' })
  workspaceId = (
    await owner.api.workspaces.create({ name: 'Search', slug: `search-${Date.now().toString(36)}` })
  ).id
  ownerApi = await core.apiOf(owner.id)
  await invite(member, 'member')
  await invite(guest, 'guest')

  const group = await ownerApi.workspaces.groups.create({
    workspaceId,
    name: 'Engineering',
    handle: `eng-${Date.now().toString(36)}`,
    description: null,
  })
  groupId = group.id
  await ownerApi.workspaces.groups.setMembers({ workspaceId, id: groupId, userIds: [member.id] })

  memberApi = await core.apiOf(member.id)
  guestApi = await core.apiOf(guest.id)
})
afterAll(async () => {
  await core?.stop()
})

describe('ranking', () => {
  it('ranks a title match above a body-only match', async () => {
    const inTitle = await index({ title: 'Quarterly kryptonite plan', body: 'nothing else here' })
    const inBody = await index({ title: 'Unrelated memo', body: 'we mention kryptonite once, in passing' })

    const res = await ownerApi.search({ workspaceId, q: 'kryptonite', limit: 10 })
    const ids = res.hits.map((h) => h.object.id)
    expect(ids).toContain(inTitle)
    expect(ids).toContain(inBody)
    expect(ids.indexOf(inTitle)).toBeLessThan(ids.indexOf(inBody))

    const scores = new Map(res.hits.map((h) => [h.object.id, h.score]))
    expect(scores.get(inTitle)!).toBeGreaterThan(scores.get(inBody)!)
    expect(res.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('returns a snippet drawn from the body and the document url', async () => {
    const id = await index({
      title: 'Deployment runbook',
      body: 'Roll the canary first, then promote the beryllium release to every region.',
    })
    const res = await ownerApi.search({ workspaceId, q: 'beryllium', limit: 10 })
    const hit = res.hits.find((h) => h.object.id === id)
    expect(hit).toBeDefined()
    expect(hit!.title).toBe('Deployment runbook')
    expect(hit!.url).toBe(`/notes/${id}`)
    expect(hit!.snippet).toContain('beryllium')
  })

  it('finds documents by a fuzzy title even without a full-text match', async () => {
    const id = await index({ title: 'Persepolis onboarding', body: null })
    const res = await ownerApi.search({ workspaceId, q: 'persepoli', limit: 10 })
    expect(res.hits.map((h) => h.object.id)).toContain(id)
  })

  it('filters by module and object type', async () => {
    const note = await index({ title: 'Zirconium note', type: 'note' })
    const page = await index({ title: 'Zirconium page', type: 'page' })

    const notes = await ownerApi.search({ workspaceId, q: 'zirconium', types: ['note'], limit: 10 })
    expect(notes.hits.map((h) => h.object.id)).toEqual([note])

    const none = await ownerApi.search({ workspaceId, q: 'zirconium', modules: ['tracker'], limit: 10 })
    expect(none.hits).toEqual([])

    const both = await ownerApi.search({ workspaceId, q: 'zirconium', modules: ['core'], limit: 10 })
    expect(both.hits.map((h) => h.object.id).sort()).toEqual([note, page].sort())
  })
})

describe('acl filtering', () => {
  it('shows documents without an acl to every member', async () => {
    const id = await index({ title: 'Open tungsten announcement', acl: null })
    for (const api of [ownerApi, memberApi, guestApi])
      expect(
        (await api.search({ workspaceId, q: 'tungsten', limit: 10 })).hits.map((h) => h.object.id),
      ).toContain(id)
  })

  it('hides a document from everyone the acl does not name', async () => {
    const id = await index({ title: 'Private molybdenum memo', acl: [member.id] })

    expect(
      (await memberApi.search({ workspaceId, q: 'molybdenum', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
    expect((await guestApi.search({ workspaceId, q: 'molybdenum', limit: 10 })).hits).toEqual([])
    // even the workspace owner is not exempt: the acl is the document's own visibility list
    expect((await ownerApi.search({ workspaceId, q: 'molybdenum', limit: 10 })).hits).toEqual([])
  })

  it('accepts a group id in the acl', async () => {
    const id = await index({ title: 'Group scandium notes', acl: [groupId] })
    expect(
      (await memberApi.search({ workspaceId, q: 'scandium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
    expect((await guestApi.search({ workspaceId, q: 'scandium', limit: 10 })).hits).toEqual([])
  })

  it('accepts a builtin role in the acl', async () => {
    const id = await index({ title: 'Members only rubidium', acl: ['role:member'] })
    expect(
      (await memberApi.search({ workspaceId, q: 'rubidium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
    expect((await guestApi.search({ workspaceId, q: 'rubidium', limit: 10 })).hits).toEqual([])
    // the owner's role is `owner`, not `member`
    expect((await ownerApi.search({ workspaceId, q: 'rubidium', limit: 10 })).hits).toEqual([])
  })

  it('lets instance admins and services see through the acl', async () => {
    const id = await index({ title: 'Restricted hafnium file', acl: [member.id] })
    expect(
      (await core.system.search({ workspaceId, q: 'hafnium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])

    await core.promoteToInstanceAdmin(guest.id)
    const promoted = await core.apiOf(guest.id)
    expect(
      (await promoted.search({ workspaceId, q: 'hafnium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
  })
})

/**
 * `acl` is an additive set overlap, so a **deny** binding is invisible to it and search fails open.
 * The document declares `{ permission, scope }` and core resolves it through `Authz.can`, which is
 * the one place that understands a deny.
 *
 * Every assertion here is about what `core.search` hands back to a caller, never about the column:
 * the row is right in both the broken and the fixed version, and only one of them is what the
 * person searching experiences.
 *
 * `tracker.issue.view` is used because it is a real project-scoped key of a module core hosts —
 * an invented key would prove the fail-closed path and not this one.
 */
describe('permission resolution beyond the acl', () => {
  const projectId = '01920000-0000-7000-8000-00000000c001'
  const otherProjectId = '01920000-0000-7000-8000-00000000c002'
  const inProject = (id: string) =>
    ({ permission: 'tracker.issue.view', scope: { kind: 'project' as const, id } }) satisfies NonNullable<
      coreContracts.SearchDocument['authz']
    >

  const setDeny = async (subjectId: string, scopeId: string, deny: boolean) =>
    ownerApi.workspaces.roles.bindings.set({
      workspaceId,
      binding: {
        subjectType: 'user',
        subjectId,
        roleId: null,
        permissions: ['tracker.issue.view'],
        scopeKind: 'project',
        scopeId,
        deny,
      },
    })

  it('withholds a hit the caller is denied at its scope, and shows it once the deny is gone', async () => {
    const id = await index({
      title: 'ENG-1 caesium regression',
      body: 'the caesium build is broken on every runner',
      module: 'tracker',
      type: 'issue',
      acl: ['role:owner', 'role:admin', 'role:member'],
      authz: inProject(projectId),
    })

    // Before the deny: the member is in the acl and holds the key, so the hit is theirs.
    expect(
      (await memberApi.search({ workspaceId, q: 'caesium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])

    const binding = await setDeny(member.id, projectId, true)
    const deniedApi = await core.apiOf(member.id)
    const denied = await deniedApi.search({ workspaceId, q: 'caesium', limit: 10 })
    // Not merely absent from the list: no title and no snippet of the indexed body escaped either.
    expect(denied.hits).toEqual([])

    await ownerApi.workspaces.roles.bindings.delete({ workspaceId, id: binding.id })
    expect(
      (await (await core.apiOf(member.id)).search({ workspaceId, q: 'caesium', limit: 10 })).hits.map(
        (h) => h.object.id,
      ),
    ).toEqual([id])
  })

  it('withholds only the scope that is denied, not every hit the module indexed', async () => {
    const denied = await index({
      title: 'ENG-2 europium crash',
      module: 'tracker',
      type: 'issue',
      acl: ['role:member'],
      authz: inProject(projectId),
    })
    const kept = await index({
      title: 'ENG-3 europium follow-up',
      module: 'tracker',
      type: 'issue',
      acl: ['role:member'],
      authz: inProject(otherProjectId),
    })

    const binding = await setDeny(member.id, projectId, true)
    expect(
      (await (await core.apiOf(member.id)).search({ workspaceId, q: 'europium', limit: 10 })).hits.map(
        (h) => h.object.id,
      ),
    ).toEqual([kept])
    expect(denied).not.toBe(kept)
    await ownerApi.workspaces.roles.bindings.delete({ workspaceId, id: binding.id })
  })

  it('leaves an instance admin and a service principal seeing everything', async () => {
    const id = await index({
      title: 'ENG-4 thulium incident',
      module: 'tracker',
      type: 'issue',
      acl: ['role:member'],
      authz: inProject(projectId),
    })
    const binding = await setDeny(member.id, projectId, true)

    expect(
      (await core.system.search({ workspaceId, q: 'thulium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])

    await core.promoteToInstanceAdmin(member.id)
    expect(
      (await (await core.apiOf(member.id)).search({ workspaceId, q: 'thulium', limit: 10 })).hits.map(
        (h) => h.object.id,
      ),
    ).toEqual([id])

    await ownerApi.workspaces.roles.bindings.delete({ workspaceId, id: binding.id })
  })

  it('withholds a hit whose permission key this process cannot resolve', async () => {
    // A module hosted by another service registers its keys in *that* process, so core cannot
    // answer for it. Withheld rather than shown: an unresolvable document fails closed.
    await index({
      title: 'Unknown lutetium document',
      acl: null,
      authz: { permission: 'nowhere.thing.view', scope: { kind: 'object', id: 'x' } },
    })
    expect((await ownerApi.search({ workspaceId, q: 'lutetium', limit: 10 })).hits).toEqual([])
  })

  it('still applies the acl to a document that declares a permission', async () => {
    // The two filters are not alternatives. `can()` at a narrow scope with no binding falls through
    // to the caller's workspace set and answers true, so it cannot tell a private project's members
    // from everybody else — only the acl knows a readership. A hit clears both or it is withheld.
    const id = await index({
      title: 'Private samarium note',
      module: 'tracker',
      type: 'issue',
      acl: [member.id],
      authz: inProject(otherProjectId),
    })
    expect(
      (await memberApi.search({ workspaceId, q: 'samarium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
    expect((await guestApi.search({ workspaceId, q: 'samarium', limit: 10 })).hits).toEqual([])
  })
})

describe('index maintenance', () => {
  it('upserts a document in place rather than duplicating it', async () => {
    const id = await index({ title: 'Original vanadium title' })
    await index({ id, title: 'Rewritten vanadium title', body: 'now with a body' })

    const res = await ownerApi.search({ workspaceId, q: 'vanadium', limit: 10 })
    expect(res.hits.filter((h) => h.object.id === id)).toHaveLength(1)
    expect(res.hits.find((h) => h.object.id === id)?.title).toBe('Rewritten vanadium title')
  })

  it('removes documents on request', async () => {
    const id = await index({ title: 'Doomed niobium record' })
    expect((await ownerApi.search({ workspaceId, q: 'niobium', limit: 10 })).hits).toHaveLength(1)

    const removed = await core.kernel.call<{ removed: number }>('core.search.remove', {
      refs: [{ workspaceId, object: { module: 'core', type: 'note', id } }],
    })
    expect(removed.removed).toBe(1)
    expect((await ownerApi.search({ workspaceId, q: 'niobium', limit: 10 })).hits).toEqual([])
  })

  it('hides documents belonging to a module that is disabled in the workspace', async () => {
    const id = await index({ title: 'Chat gallium message', module: 'chat', type: 'message' })
    expect(
      (await ownerApi.search({ workspaceId, q: 'gallium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])

    await ownerApi.workspaces.modules.setEnabled({ workspaceId, moduleId: 'chat', enabled: false })
    core.kernel.settings.invalidate(workspaceId)
    expect((await ownerApi.search({ workspaceId, q: 'gallium', limit: 10 })).hits).toEqual([])

    await ownerApi.workspaces.modules.setEnabled({ workspaceId, moduleId: 'chat', enabled: true })
    core.kernel.settings.invalidate(workspaceId)
    expect(
      (await ownerApi.search({ workspaceId, q: 'gallium', limit: 10 })).hits.map((h) => h.object.id),
    ).toEqual([id])
  })
})
