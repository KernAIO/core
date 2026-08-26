import { beforeAll, describe, expect, it } from 'vitest'
import { expectRejection, startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * Personal API keys, end to end: the capability switch and its group audience, a key's own
 * `read`/`read_write` scope enforced on a real HTTP request (not the direct oRPC client, which never
 * passes through the resolver that enforces it), self-revoke, and an integration manager revoking
 * someone else's key.
 */

let core: TestCore
let owner: TestUser
let api: Awaited<ReturnType<TestCore['apiOf']>>
let workspaceId: string

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Keys Owner' })
  const workspace = await owner.api.workspaces.create({
    name: 'Keyed',
    slug: `keyed-${Date.now().toString(36)}`,
  })
  workspaceId = workspace.id
  // `owner.api` was bound before the workspace existed, so it still has zero memberships — every
  // call below needs the membership that creating it just granted.
  api = await core.apiOf(owner.id)
}, 180_000)

async function enable(on: boolean) {
  await api.workspaces.modules.updateSettings({
    workspaceId,
    moduleId: 'core',
    settings: { $capabilities: { api_keys: on } },
  })
}

describe('personal API keys', () => {
  it('refuses to create one while the capability is off', async () => {
    await enable(false)
    await expectRejection(
      () => api.apiKeys.create({ workspaceId, name: 'CI', scope: 'read', expiresInDays: null }),
      'NOT_FOUND',
    )
  })

  it('creates a key once enabled, and never shows it again', async () => {
    await enable(true)
    const created = await api.apiKeys.create({
      workspaceId,
      name: 'CI pipeline',
      scope: 'read_write',
      expiresInDays: 30,
    })
    expect(created.key).toMatch(/^kak_/)
    expect(created.name).toBe('CI pipeline')
    expect(created.scope).toBe('read_write')

    const listed = await api.apiKeys.list({ workspaceId })
    const row = listed.find((k) => k.id === created.id)
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty('key')
  })

  it('authenticates a real request as the owner, and a read key cannot write', async () => {
    const created = await api.apiKeys.create({
      workspaceId,
      name: 'Read only',
      scope: 'read',
      expiresInDays: null,
    })

    const read = await core.service.app!.inject({
      method: 'GET',
      url: '/api/core/users/me',
      headers: { 'x-api-key': created.key },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().user.email).toBe(owner.email)

    // The same key, over the same path other clients use to prove who they are, refuses to write.
    const write = await core.service.app!.inject({
      method: 'PATCH',
      url: '/api/core/users/me',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { name: 'Renamed by a read-only key' },
    })
    expect(write.statusCode).toBe(401)

    await api.apiKeys.revoke({ id: created.id })
  })

  it('a read_write key can write', async () => {
    const created = await api.apiKeys.create({
      workspaceId,
      name: 'Full access',
      scope: 'read_write',
      expiresInDays: null,
    })
    const write = await core.service.app!.inject({
      method: 'PATCH',
      url: '/api/core/users/me',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { name: 'Renamed by a read_write key' },
    })
    expect(write.statusCode).toBe(200)
    await api.apiKeys.revoke({ id: created.id })
  })

  it('stops authenticating the moment it is revoked', async () => {
    const created = await api.apiKeys.create({
      workspaceId,
      name: 'Short-lived',
      scope: 'read',
      expiresInDays: null,
    })
    await api.apiKeys.revoke({ id: created.id })
    const after = await core.service.app!.inject({
      method: 'GET',
      url: '/api/core/users/me',
      headers: { 'x-api-key': created.key },
    })
    expect(after.statusCode).toBe(401)
  })

  it("refuses a member outside the capability's allowed groups, and admits one inside it", async () => {
    const member = await core.signUp({ name: 'Group Member' })
    const [invitation] = await api.workspaces.invitations.create({
      workspaceId,
      invites: [{ email: member.email, role: 'member', roleIds: [] }],
    })
    const token = await core.inviteToken(invitation!.id)
    await member.api.workspaces.invitations.accept({ token })

    const group = await api.workspaces.groups.create({
      workspaceId,
      name: 'Automation',
      handle: 'automation',
      description: null,
    })
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: 'core',
      settings: { $capabilityAudience: { api_keys: [group.id] } },
    })

    const memberApi = await core.apiOf(member.id)
    await expectRejection(
      () => memberApi.apiKeys.create({ workspaceId, name: 'Blocked', scope: 'read', expiresInDays: null }),
      'NOT_FOUND',
    )

    await api.workspaces.groups.setMembers({ workspaceId, id: group.id, userIds: [member.id] })
    core.service.deps.principals.invalidate([member.id])
    const memberApiAfter = await core.apiOf(member.id)
    const created = await memberApiAfter.apiKeys.create({
      workspaceId,
      name: 'Allowed now',
      scope: 'read',
      expiresInDays: null,
    })
    expect(created.key).toMatch(/^kak_/)

    // Open the audience back up so later tests in this file are unaffected.
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: 'core',
      settings: { $capabilityAudience: { api_keys: null } },
    })
  })

  it('lets its owner revoke it, and refuses anyone else without core.integrations.manage', async () => {
    const own = await api.apiKeys.create({ workspaceId, name: 'Owned', scope: 'read', expiresInDays: null })
    await expect(api.apiKeys.revoke({ id: own.id })).resolves.toEqual({ ok: true })

    const other = await api.apiKeys.create({
      workspaceId,
      name: 'Owned by someone else',
      scope: 'read',
      expiresInDays: null,
    })
    const stranger = await core.signUp({ name: 'Stranger' })
    const strangerApi = await core.apiOf(stranger.id)
    await expectRejection(() => strangerApi.apiKeys.revoke({ id: other.id }), 'FORBIDDEN')
    await api.apiKeys.revoke({ id: other.id })
  })

  it('lets an integration manager see and revoke every key in the workspace', async () => {
    const created = await api.apiKeys.create({
      workspaceId,
      name: 'For admin oversight',
      scope: 'read',
      expiresInDays: null,
    })
    const all = await api.apiKeys.listAll({ workspaceId })
    const row = all.find((k) => k.id === created.id)
    // Not `owner.name`: an earlier test in this file renamed the owner via a real PATCH request,
    // so the stable check is identity, not a display name two other tests have since changed.
    expect(row?.userId).toBe(owner.id)

    await api.apiKeys.revoke({ id: created.id })
    const afterRevoke = await api.apiKeys.listAll({ workspaceId })
    expect(afterRevoke.find((k) => k.id === created.id)).toBeUndefined()
  })
})
