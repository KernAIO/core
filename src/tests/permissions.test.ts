/**
 * The permission matrix.
 *
 * For a representative slice of the core API, assert exactly which of the four builtin roles may call
 * it. The point is not that every procedure is covered but that the *shape* of the matrix is pinned:
 * a permission accidentally handed to `member`, or a `requires()` dropped from a route, fails here.
 */
import type { BuiltinRole } from '@kernhq/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CoreApi, TestUser } from '../testing/harness.js'
import { allowed, expectRejection, startCore, type TestCore } from '../testing/harness.js'

let core: TestCore

const ROLES: BuiltinRole[] = ['owner', 'admin', 'member', 'guest']
let n = 0
const slug = (prefix: string) => `${prefix}-${(n++).toString(36)}-${Date.now().toString(36)}`

interface Fixture {
  workspaceId: string
  user: Record<BuiltinRole, TestUser>
  api: Record<BuiltinRole, CoreApi>
  /** re-read a role's client after its permissions changed */
  refresh(role: BuiltinRole): Promise<CoreApi>
}

/**
 * A fresh workspace with four brand-new users holding the four builtin roles. Each fixture owns its
 * users so that a test which promotes or demotes somebody cannot leak into the next one.
 */
async function fixture(prefix: string): Promise<Fixture> {
  const user = {
    owner: await core.signUp({ name: 'Owner' }),
    admin: await core.signUp({ name: 'Admin' }),
    member: await core.signUp({ name: 'Member' }),
    guest: await core.signUp({ name: 'Guest' }),
  }
  const ws = await user.owner.api.workspaces.create({ name: prefix, slug: slug(prefix) })
  const ownerApi = await core.apiOf(user.owner.id)
  for (const role of ['admin', 'member', 'guest'] as const) {
    const [invitation] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email: user[role].email, role, roleIds: [], groupIds: [], guestScopes: [] }],
    })
    await (await core.apiOf(user[role].id)).workspaces.invitations.accept({
      token: await core.inviteToken(invitation!.id),
    })
  }
  const api = {
    owner: ownerApi,
    admin: await core.apiOf(user.admin.id),
    member: await core.apiOf(user.member.id),
    guest: await core.apiOf(user.guest.id),
  }
  return {
    workspaceId: ws.id,
    user,
    api,
    async refresh(role) {
      api[role] = await core.apiOf(user[role].id)
      return api[role]
    },
  }
}

/** Run `probe` as each of the four roles and return the roles that were allowed through. */
async function permitted(
  f: Fixture,
  probe: (api: CoreApi, workspaceId: string, role: BuiltinRole) => Promise<unknown>,
): Promise<BuiltinRole[]> {
  const out: BuiltinRole[] = []
  for (const role of ROLES) if (await allowed(() => probe(f.api[role], f.workspaceId, role))) out.push(role)
  return out
}

beforeAll(async () => {
  core = await startCore()
})
afterAll(async () => {
  await core?.stop()
})

describe('effective permission sets', () => {
  it('nests the four builtin roles: guest ⊆ member ⊆ admin ⊆ owner', async () => {
    const f = await fixture('nesting')
    const sets: Record<BuiltinRole, Set<string>> = {} as never
    for (const role of ROLES) {
      const res = await f.api[role].workspaces.myPermissions({ workspaceId: f.workspaceId })
      expect(res.role).toBe(role)
      sets[role] = new Set(res.permissions)
    }
    for (const [narrow, wide] of [
      ['guest', 'member'],
      ['member', 'admin'],
      ['admin', 'owner'],
    ] as const) {
      for (const key of sets[narrow]) expect(sets[wide], `${wide} should include ${key}`).toContain(key)
      expect(sets[wide].size).toBeGreaterThan(sets[narrow].size)
    }
    expect([...sets.guest]).toContain('core.workspace.view')
    expect([...sets.guest]).not.toContain('core.members.view')
    expect([...sets.member]).toContain('core.members.invite')
    expect([...sets.member]).not.toContain('core.roles.manage')
    expect([...sets.admin]).toContain('core.roles.manage')
    expect([...sets.admin]).not.toContain('core.workspace.delete')
    expect([...sets.owner]).toContain('core.workspace.delete')
  })
})

describe('who may call what', () => {
  it('workspaces.get — every member', async () => {
    const f = await fixture('read')
    expect(await permitted(f, (api, workspaceId) => api.workspaces.get({ workspaceId }))).toEqual(ROLES)
  })

  it('search — every member', async () => {
    const f = await fixture('search')
    expect(
      await permitted(f, (api, workspaceId) => api.search({ workspaceId, q: 'anything', limit: 10 })),
    ).toEqual(ROLES)
  })

  it('files.createUpload — every member (core.files.upload)', async () => {
    const f = await fixture('upload')
    expect(
      await permitted(f, (api, workspaceId) =>
        api.files.createUpload({ workspaceId, name: 'a.txt', mimeType: 'text/plain', size: 3 }),
      ),
    ).toEqual(ROLES)
  })

  it('workspaces.members.list — owner, admin, member (core.members.view)', async () => {
    const f = await fixture('memberslist')
    expect(
      await permitted(f, (api, workspaceId) => api.workspaces.members.list({ workspaceId, limit: 10 })),
    ).toEqual(['owner', 'admin', 'member'])
  })

  it('workspaces.invitations.create — owner, admin, member (core.members.invite)', async () => {
    const f = await fixture('invite')
    expect(
      await permitted(f, (api, workspaceId, role) =>
        api.workspaces.invitations.create({
          workspaceId,
          invites: [
            {
              email: `probe_${role}_${n++}@example.test`,
              role: 'guest',
              roleIds: [],
              groupIds: [],
              guestScopes: [],
            },
          ],
        }),
      ),
    ).toEqual(['owner', 'admin', 'member'])
  })

  it('workspaces.update — owner, admin (core.workspace.manage)', async () => {
    const f = await fixture('update')
    expect(
      await permitted(f, (api, workspaceId, role) =>
        api.workspaces.update({ workspaceId, patch: { description: `set by ${role}` } }),
      ),
    ).toEqual(['owner', 'admin'])
  })

  it('workspaces.roles.create — owner, admin (core.roles.manage)', async () => {
    const f = await fixture('roles')
    expect(
      await permitted(f, (api, workspaceId, role) =>
        api.workspaces.roles.create({
          workspaceId,
          name: `role-${role}-${n++}`,
          description: null,
          permissions: ['core.workspace.view'],
        }),
      ),
    ).toEqual(['owner', 'admin'])
  })

  it('workspaces.groups.create — owner, admin (core.members.manage)', async () => {
    const f = await fixture('groups')
    expect(
      await permitted(f, (api, workspaceId, role) =>
        api.workspaces.groups.create({
          workspaceId,
          name: `group-${role}-${n}`,
          handle: `g-${role}-${n++}`,
          description: null,
        }),
      ),
    ).toEqual(['owner', 'admin'])
  })

  it('workspaces.modules.setEnabled — owner, admin (core.modules.manage)', async () => {
    const f = await fixture('modules')
    // `core` itself is always enabled, so probing it must fail on the permission first for
    // member/guest and only then on the conflict for owner/admin.
    expect(
      await permitted(f, (api, workspaceId) =>
        api.workspaces.modules
          .setEnabled({ workspaceId, moduleId: 'sample', enabled: false })
          .then(() => api.workspaces.modules.setEnabled({ workspaceId, moduleId: 'sample', enabled: true })),
      ),
    ).toEqual(['owner', 'admin'])
  })

  it('workspaces.audit — owner, admin (core.audit.view)', async () => {
    const f = await fixture('audit')
    expect(await permitted(f, (api, workspaceId) => api.workspaces.audit({ workspaceId, limit: 5 }))).toEqual(
      ['owner', 'admin'],
    )
  })

  it('workspaces.archive — owner only (core.workspace.delete)', async () => {
    // archiving is terminal for the workspace, so give every role its own
    const results: string[] = []
    for (const role of ROLES) {
      const f = await fixture(`archive${role}`)
      if (await allowed(() => f.api[role].workspaces.archive({ workspaceId: f.workspaceId })))
        results.push(role)
    }
    expect(results).toEqual(['owner'])
  })

  it('admin.settings — nobody without the instance admin flag', async () => {
    const f = await fixture('instanceadmin')
    expect(await permitted(f, (api) => api.admin.settings())).toEqual([])

    await core.promoteToInstanceAdmin(f.user.member.id)
    const promoted = await f.refresh('member')
    expect((await promoted.admin.settings()).baseUrl).toBeTruthy()
    // and an instance admin passes every workspace gate
    expect((await promoted.workspaces.myPermissions({ workspaceId: f.workspaceId })).permissions).toContain(
      'core.workspace.delete',
    )
  })
})

describe('membership is required before permissions are even considered', () => {
  it('refuses a non-member on every workspace-scoped route', async () => {
    const f = await fixture('outsider')
    const outsider = await core.signUp({ name: 'Outsider' })
    const api = outsider.api
    await expectRejection(() => api.workspaces.get({ workspaceId: f.workspaceId }), 'FORBIDDEN')
    await expectRejection(
      () => api.workspaces.members.list({ workspaceId: f.workspaceId, limit: 5 }),
      'FORBIDDEN',
    )
    await expectRejection(() => api.search({ workspaceId: f.workspaceId, q: 'x', limit: 5 }), 'FORBIDDEN')
  })

  it('refuses anonymous callers before looking at membership', async () => {
    const f = await fixture('anon')
    await expectRejection(() => core.anonymous.workspaces.get({ workspaceId: f.workspaceId }), 'UNAUTHORIZED')
  })
})

describe('role changes take effect on the next request', () => {
  it('promotes a member to admin and the new permissions apply immediately', async () => {
    const f = await fixture('promote')
    const before = await f.api.member.workspaces.myPermissions({ workspaceId: f.workspaceId })
    expect(before.permissions).not.toContain('core.roles.manage')

    await f.api.owner.workspaces.members.update({
      workspaceId: f.workspaceId,
      userId: f.user.member.id,
      patch: { role: 'admin' },
    })

    const after = await (await f.refresh('member')).workspaces.myPermissions({
      workspaceId: f.workspaceId,
    })
    expect(after.role).toBe('admin')
    expect(after.permissions).toContain('core.roles.manage')
    expect(after.version).toBeGreaterThan(before.version)
  })

  it('only an owner may grant or revoke ownership, and never the last one', async () => {
    const f = await fixture('ownership')
    await expectRejection(
      () =>
        f.api.admin.workspaces.members.update({
          workspaceId: f.workspaceId,
          userId: f.user.member.id,
          patch: { role: 'owner' },
        }),
      'FORBIDDEN',
    )

    await expectRejection(
      () =>
        f.api.owner.workspaces.members.update({
          workspaceId: f.workspaceId,
          userId: f.user.owner.id,
          patch: { role: 'admin' },
        }),
      'CONFLICT',
    )

    await f.api.owner.workspaces.members.update({
      workspaceId: f.workspaceId,
      userId: f.user.member.id,
      patch: { role: 'owner' },
    })
    // with two owners, stepping down is fine
    await (await f.refresh('owner')).workspaces.members.update({
      workspaceId: f.workspaceId,
      userId: f.user.owner.id,
      patch: { role: 'admin' },
    })
    const members = await (await f.refresh('member')).workspaces.members.list({
      workspaceId: f.workspaceId,
      limit: 10,
    })
    expect(members.items.find((m) => m.userId === f.user.member.id)?.role).toBe('owner')
    expect(members.items.find((m) => m.userId === f.user.owner.id)?.role).toBe('admin')
  })
})

describe('custom roles and scoped bindings', () => {
  it('adds a custom role to a member and grants exactly its permissions', async () => {
    const f = await fixture('customrole')
    const role = await f.api.owner.workspaces.roles.create({
      workspaceId: f.workspaceId,
      name: `auditors-${n++}`,
      description: 'read the audit log',
      permissions: ['core.audit.view'],
    })
    await f.api.owner.workspaces.members.update({
      workspaceId: f.workspaceId,
      userId: f.user.guest.id,
      patch: { roleIds: [role.id] },
    })

    const api = await f.refresh('guest')
    const perms = await api.workspaces.myPermissions({ workspaceId: f.workspaceId })
    expect(perms.role).toBe('guest')
    expect(perms.permissions).toContain('core.audit.view')
    expect(perms.permissions).not.toContain('core.roles.manage')
    await expect(api.workspaces.audit({ workspaceId: f.workspaceId, limit: 5 })).resolves.toBeTruthy()
  })

  it('honours a project-scoped binding without widening the workspace-level set', async () => {
    const f = await fixture('binding')
    const projectId = '01920000-0000-7000-8000-0000000000aa'
    await f.api.owner.workspaces.roles.bindings.set({
      workspaceId: f.workspaceId,
      binding: {
        subjectType: 'user',
        subjectId: f.user.member.id,
        roleId: null,
        permissions: ['core.audit.view'],
        scopeKind: 'project',
        scopeId: projectId,
        deny: false,
      },
    })

    const principal = await core.principalOf(f.user.member.id)
    const scope = {
      kind: 'project' as const,
      id: projectId,
      workspaceId: f.workspaceId,
      parents: [{ kind: 'workspace' as const, id: f.workspaceId }],
    }
    expect(await core.kernel.authz.can(principal, 'core.audit.view', scope)).toBe(true)
    expect(
      await core.kernel.authz.can(principal, 'core.audit.view', {
        kind: 'workspace',
        id: f.workspaceId,
        workspaceId: f.workspaceId,
      }),
    ).toBe(false)
    expect(
      await core.kernel.authz.can(principal, 'core.audit.view', {
        ...scope,
        id: '01920000-0000-7000-8000-0000000000bb',
      }),
    ).toBe(false)

    // the workspace-level route stays closed
    await expectRejection(
      () => f.api.member.workspaces.audit({ workspaceId: f.workspaceId, limit: 5 }),
      'FORBIDDEN',
    )
  })

  it('lets an explicit deny binding beat an allow at the same scope', async () => {
    const f = await fixture('deny')
    const projectId = '01920000-0000-7000-8000-0000000000cc'
    for (const deny of [false, true])
      await f.api.owner.workspaces.roles.bindings.set({
        workspaceId: f.workspaceId,
        binding: {
          subjectType: deny ? 'builtin_role' : 'user',
          subjectId: deny ? 'admin' : f.user.admin.id,
          roleId: null,
          permissions: ['core.audit.view'],
          scopeKind: 'project',
          scopeId: projectId,
          deny,
        },
      })

    const principal = await core.principalOf(f.user.admin.id)
    expect(
      await core.kernel.authz.can(principal, 'core.audit.view', {
        kind: 'project',
        id: projectId,
        workspaceId: f.workspaceId,
        parents: [{ kind: 'workspace', id: f.workspaceId }],
      }),
    ).toBe(false)
  })
})

/**
 * What a guest can reach in a hosted module.
 *
 * `guest` is the role a customer picks for an external contractor, and both surfaces describing it
 * promise scoping. It had none: `invitations.guestScopes` is validated, stored and serialised and
 * nothing reads it, while `tracker` hands `guest` five project-scoped defaults — so a guest read and
 * edited every project in the workspace. This drives the real hosted tracker, because that is where
 * the promise was broken; asserting on `myPermissions` alone would have passed either way.
 */
describe('a guest in a hosted module', () => {
  type TrackerApi = {
    projects: {
      create(i: Record<string, unknown>): Promise<{ id: string; key: string }>
      list(i: Record<string, unknown>): Promise<{ items: Array<{ id: string }> }>
    }
    issues: {
      create(i: Record<string, unknown>): Promise<{ id: string }>
      get(i: Record<string, unknown>): Promise<{ id: string; title: string }>
    }
  }
  const trackerFor = async (userId: string) =>
    core.moduleApi('tracker', await core.principalOf(userId)) as TrackerApi

  it('reads no project it was not given, and the one it was', async () => {
    const f = await fixture('guestscope')
    const owner = await trackerFor(f.user.owner.id)
    const scoped = await owner.projects.create({
      workspaceId: f.workspaceId,
      key: `GA${n}`,
      name: 'Scoped to the contractor',
      template: 'software',
    })
    const other = await owner.projects.create({
      workspaceId: f.workspaceId,
      key: `GB${n}`,
      name: 'Nothing to do with them',
      template: 'software',
    })
    const mine = await owner.issues.create({
      workspaceId: f.workspaceId,
      projectId: scoped.id,
      title: 'the work they were hired for',
    })
    const theirs = await owner.issues.create({
      workspaceId: f.workspaceId,
      projectId: other.id,
      title: 'commercially sensitive',
    })

    // Before anything is granted: a guest holds no project permission at all.
    const guest = await trackerFor(f.user.guest.id)
    expect(await allowed(() => guest.issues.get({ workspaceId: f.workspaceId, issueId: theirs.id }))).toBe(
      false,
    )
    expect(await allowed(() => guest.issues.get({ workspaceId: f.workspaceId, issueId: mine.id }))).toBe(
      false,
    )
    const workspaceSet = await f.api.guest.workspaces.myPermissions({ workspaceId: f.workspaceId })
    expect(workspaceSet.permissions).not.toContain('tracker.issue.view')
    expect(workspaceSet.permissions).not.toContain('tracker.issue.edit')
    // still an ordinary member of the workspace: the floor is about project data, not membership
    expect(workspaceSet.permissions).toContain('core.workspace.view')

    // Given one project explicitly, it reads that project and still nothing else.
    await f.api.owner.workspaces.roles.bindings.set({
      workspaceId: f.workspaceId,
      binding: {
        subjectType: 'user',
        subjectId: f.user.guest.id,
        roleId: null,
        permissions: ['tracker.project.view', 'tracker.issue.view'],
        scopeKind: 'project',
        scopeId: scoped.id,
        deny: false,
      },
    })
    const bound = await trackerFor(f.user.guest.id)
    const read = await bound.issues.get({ workspaceId: f.workspaceId, issueId: mine.id })
    expect(read.title).toBe('the work they were hired for')
    expect(await allowed(() => bound.issues.get({ workspaceId: f.workspaceId, issueId: theirs.id }))).toBe(
      false,
    )
  })

  it('keeps what a custom role gives it', async () => {
    const f = await fixture('guestrole')
    const role = await f.api.owner.workspaces.roles.create({
      workspaceId: f.workspaceId,
      name: `reviewers-${n++}`,
      description: 'read every issue',
      permissions: ['tracker.project.view', 'tracker.issue.view'],
    })
    await f.api.owner.workspaces.members.update({
      workspaceId: f.workspaceId,
      userId: f.user.guest.id,
      patch: { roleIds: [role.id] },
    })
    const perms = await (await f.refresh('guest')).workspaces.myPermissions({ workspaceId: f.workspaceId })
    expect(perms.role).toBe('guest')
    // the floor must not undo an administrator's explicit grant
    expect(perms.permissions).toContain('tracker.issue.view')
  })

  /**
   * The half `guestScopes` was missing: accepting the invitation has to make the choice mean
   * something.
   *
   * Asserted through `tracker.issues.get`, not by reading `core.role_bindings`. A row in that table
   * is what the naive repair produces and it grants nothing on its own — the question is what the
   * contractor can actually open, and that is the only assertion that answers it.
   */
  it('reads the project its invitation named, and no other', async () => {
    const f = await fixture('guestinvite')
    const owner = await trackerFor(f.user.owner.id)
    const scoped = await owner.projects.create({
      workspaceId: f.workspaceId,
      key: `GC${n}`,
      name: 'Scoped by the invitation',
      template: 'software',
    })
    const other = await owner.projects.create({
      workspaceId: f.workspaceId,
      key: `GD${n}`,
      name: 'Nothing to do with them',
      template: 'software',
    })
    const mine = await owner.issues.create({
      workspaceId: f.workspaceId,
      projectId: scoped.id,
      title: 'the work they were hired for',
    })
    const theirs = await owner.issues.create({
      workspaceId: f.workspaceId,
      projectId: other.id,
      title: 'commercially sensitive',
    })

    const contractor = await core.signUp({ name: 'Contractor' })
    const [invitation] = await f.api.owner.workspaces.invitations.create({
      workspaceId: f.workspaceId,
      invites: [
        {
          email: contractor.email,
          role: 'guest',
          roleIds: [],
          groupIds: [],
          guestScopes: [`tracker:project:${scoped.id}`],
        },
      ],
    })
    await (await core.apiOf(contractor.id)).workspaces.invitations.accept({
      token: await core.inviteToken(invitation!.id),
    })

    const guest = await trackerFor(contractor.id)
    const read = await guest.issues.get({ workspaceId: f.workspaceId, issueId: mine.id })
    expect(read.title).toBe('the work they were hired for')
    expect(await allowed(() => guest.issues.get({ workspaceId: f.workspaceId, issueId: theirs.id }))).toBe(
      false,
    )
    // and the invitation grants nothing at workspace level: the floor still holds there
    const workspaceSet = await (await core.apiOf(contractor.id)).workspaces.myPermissions({
      workspaceId: f.workspaceId,
    })
    expect(workspaceSet.permissions).not.toContain('tracker.issue.view')
  })

  /** A guest invited with no scopes is where it was: nothing outside the workspace-level set. */
  it('grants nothing when the invitation named no scope', async () => {
    const f = await fixture('guestnoscope')
    const owner = await trackerFor(f.user.owner.id)
    const project = await owner.projects.create({
      workspaceId: f.workspaceId,
      key: `GE${n}`,
      name: 'Unscoped',
      template: 'software',
    })
    const issue = await owner.issues.create({
      workspaceId: f.workspaceId,
      projectId: project.id,
      title: 'not for them',
    })
    const guest = await trackerFor(f.user.guest.id)
    expect(await allowed(() => guest.issues.get({ workspaceId: f.workspaceId, issueId: issue.id }))).toBe(
      false,
    )
  })
})
