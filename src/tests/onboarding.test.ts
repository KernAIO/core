/**
 * The path every Kern instance starts with: someone signs up, creates a workspace, invites a
 * colleague by email, and that colleague accepts and shows up in the member list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectRejection, startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
let n = 0
const slug = (prefix: string) => `${prefix}-${(n++).toString(36)}-${Date.now().toString(36)}`
const address = (prefix: string) => `${prefix}_${n++}_${Date.now().toString(36)}@example.test`

beforeAll(async () => {
  core = await startCore()
})
afterAll(async () => {
  await core?.stop()
})

describe('sign-up', () => {
  it('creates a user that can read its own profile and has no workspaces yet', async () => {
    const alice = await core.signUp({ name: 'Alice' })
    const me = await alice.api.users.me()

    expect(me.user.id).toBe(alice.id)
    expect(me.user.email).toBe(alice.email)
    expect(me.user.name).toBe('Alice')
    expect(me.workspaces).toEqual([])
  })

  it('refuses anonymous callers', async () => {
    await expectRejection(() => core.anonymous.users.me(), 'UNAUTHORIZED')
  })
})

describe('workspace creation', () => {
  it('makes the creator an owner with the full owner permission set', async () => {
    const alice = await core.signUp()
    const ws = await alice.api.workspaces.create({ name: 'Acme', slug: slug('acme') })

    expect(ws.name).toBe('Acme')

    // the principal was minted before the workspace existed, so re-read it
    const api = await core.apiOf(alice.id)
    const summaries = await api.workspaces.list()
    expect(summaries.map((w) => w.id)).toContain(ws.id)
    expect(summaries.find((w) => w.id === ws.id)?.role).toBe('owner')

    const perms = await api.workspaces.myPermissions({ workspaceId: ws.id })
    expect(perms.role).toBe('owner')
    expect(perms.permissions).toContain('core.workspace.manage')
    expect(perms.permissions).toContain('core.members.invite')
    expect(perms.permissions).toContain('core.workspace.delete')

    // builtin roles are mirrored into the workspace so the UI can list them
    const roles = await api.workspaces.roles.list({ workspaceId: ws.id })
    expect(
      roles
        .filter((r) => r.builtin)
        .map((r) => r.name.toLowerCase())
        .sort(),
    ).toEqual(['admin', 'guest', 'member', 'owner'])
  })

  it('rejects reserved and duplicate slugs', async () => {
    const alice = await core.signUp()
    await expectRejection(() => alice.api.workspaces.create({ name: 'Admin', slug: 'admin' }), 'CONFLICT')

    const taken = slug('dup')
    await alice.api.workspaces.create({ name: 'First', slug: taken })
    const api = await core.apiOf(alice.id)
    await expectRejection(() => api.workspaces.create({ name: 'Second', slug: taken }), 'CONFLICT')
  })
})

describe('invitation by email', () => {
  it('invites an address, mails a token, and adds the member on accept', async () => {
    const owner = await core.signUp({ name: 'Owner' })
    const ws = await owner.api.workspaces.create({ name: 'Invites', slug: slug('invites') })
    const ownerApi = await core.apiOf(owner.id)

    const invitee = address('invitee')
    const before = core.mailbox.length
    const [invitation] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email: invitee, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
      message: 'join us',
    })
    expect(invitation).toBeDefined()
    expect(invitation!.email).toBe(invitee)
    expect(invitation!.status).toBe('pending')

    const token = await core.inviteToken(invitation!.id)
    // the token travels by email only: it must never be part of the API response
    expect(JSON.stringify(invitation)).not.toContain(token)

    const mail = core.mailbox.slice(before).find((m) => m.to === invitee)
    expect(mail, 'an invitation email should have been sent').toBeDefined()
    expect(mail!.text).toContain(`/invite/${token}`)
    expect(mail!.text).toContain('join us')

    // the invitation list only shows pending invitations
    const pending = await ownerApi.workspaces.invitations.list({ workspaceId: ws.id })
    expect(pending.map((i) => i.id)).toEqual([invitation!.id])

    // preview is public: an invited person can see what they were invited to before signing in
    const preview = await core.anonymous.workspaces.invitations.preview({ token })
    expect(preview.workspace.id).toBe(ws.id)
    expect(preview.email).toBe(invitee)
    expect(preview.inviter).toBe('Owner')
    expect(preview.expired).toBe(false)

    // the invited person signs up with that address and accepts
    const bob = await core.signUp({ email: invitee, name: 'Bob' })
    const accepted = await bob.api.workspaces.invitations.accept({ token })
    expect(accepted.id).toBe(ws.id)

    const members = await ownerApi.workspaces.members.list({ workspaceId: ws.id, limit: 50 })
    const bobRow = members.items.find((m) => m.userId === bob.id)
    expect(bobRow).toBeDefined()
    expect(bobRow!.role).toBe('member')
    expect(bobRow!.status).toBe('active')
    expect(bobRow!.user.email).toBe(invitee)

    // and the workspace now shows up for the new member
    const bobWorkspaces = await (await core.apiOf(bob.id)).workspaces.list()
    expect(bobWorkspaces.map((w) => w.id)).toContain(ws.id)

    // the invitation is consumed
    expect(await ownerApi.workspaces.invitations.list({ workspaceId: ws.id })).toEqual([])
  })

  it('refuses to accept an invitation addressed to somebody else', async () => {
    const owner = await core.signUp()
    const ws = await owner.api.workspaces.create({ name: 'Closed', slug: slug('closed') })
    const [invitation] = await (await core.apiOf(owner.id)).workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email: address('wanted'), role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })
    const token = await core.inviteToken(invitation!.id)

    const stranger = await core.signUp()
    await expectRejection(() => stranger.api.workspaces.invitations.accept({ token }), 'FORBIDDEN')
  })

  it('refuses a revoked invitation', async () => {
    const owner = await core.signUp()
    const ws = await owner.api.workspaces.create({ name: 'Revoked', slug: slug('revoked') })
    const ownerApi = await core.apiOf(owner.id)
    const email = address('revoked')
    const [invitation] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })
    const token = await core.inviteToken(invitation!.id)
    await ownerApi.workspaces.invitations.revoke({ workspaceId: ws.id, id: invitation!.id })

    const bob = await core.signUp({ email })
    await expectRejection(() => bob.api.workspaces.invitations.accept({ token }), 'CONFLICT')
  })

  it('will not invite somebody who is already a member', async () => {
    const owner = await core.signUp()
    const ws = await owner.api.workspaces.create({ name: 'Twice', slug: slug('twice') })
    const ownerApi = await core.apiOf(owner.id)
    const email = address('already')
    const bob = await core.signUp({ email })
    const [invitation] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })
    await bob.api.workspaces.invitations.accept({ token: await core.inviteToken(invitation!.id) })

    await expectRejection(
      () =>
        ownerApi.workspaces.invitations.create({
          workspaceId: ws.id,
          invites: [{ email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
        }),
      'CONFLICT',
    )
  })

  it('notifies an invited user who already has an account', async () => {
    const owner = await core.signUp()
    const ws = await owner.api.workspaces.create({ name: 'Known', slug: slug('known') })
    const bob = await core.signUp()

    await (await core.apiOf(owner.id)).workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email: bob.email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })

    const inbox = await bob.api.notifications.list({ limit: 20, unreadOnly: false })
    const invite = inbox.items.find((x) => x.type === 'core.invitation.received')
    expect(invite, 'an existing user should get an in-app invitation notification').toBeDefined()
    expect(invite!.url).toMatch(/^\/invite\//)
  })
})

describe('leaving and removal', () => {
  it('lets a member leave and refuses to strand a workspace without an owner', async () => {
    const owner = await core.signUp()
    const ws = await owner.api.workspaces.create({ name: 'Leave', slug: slug('leave') })
    const ownerApi = await core.apiOf(owner.id)
    const email = address('leaver')
    const [invitation] = await ownerApi.workspaces.invitations.create({
      workspaceId: ws.id,
      invites: [{ email, role: 'member', roleIds: [], groupIds: [], guestScopes: [] }],
    })
    const bob = await core.signUp({ email })
    await bob.api.workspaces.invitations.accept({ token: await core.inviteToken(invitation!.id) })

    await (await core.apiOf(bob.id)).workspaces.members.leave({ workspaceId: ws.id })
    const members = await ownerApi.workspaces.members.list({ workspaceId: ws.id, limit: 50 })
    expect(members.items.map((m) => m.userId)).toEqual([owner.id])

    // the last owner cannot leave
    await expectRejection(() => ownerApi.workspaces.members.leave({ workspaceId: ws.id }), 'CONFLICT')
  })
})
