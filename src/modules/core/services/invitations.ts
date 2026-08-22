import { randomBytes } from 'node:crypto'
import type { BuiltinRole, core, UserId, WorkspaceId } from '@kernalo/contracts'
import { coreEvents } from '@kernalo/contracts/core'
import { KernError } from '@kernalo/kernel'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import type { z } from 'zod'
import { renderEmail } from '../../../auth/mail.js'
import type { CoreDeps } from '../deps.js'
import { serInvitation, serWorkspace } from '../lib/ser.js'
import { invitations, memberships, user, workspaces } from '../schema/index.js'
import { type Ctx, callerRole, permissionsChanged, ROLE_RANK, requireUser } from './common.js'
import { createNotification } from './notifications.js'
import { requireWorkspace } from './workspaces.js'

export const INVITATION_TTL_DAYS = 14
export const inviteUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/$/, '')}/invite/${token}`

export async function list(ctx: Ctx, workspaceId: string): Promise<core.Invitation[]> {
  const rows = await ctx.kernel.database.db
    .select()
    .from(invitations)
    .where(and(eq(invitations.workspaceId, workspaceId), eq(invitations.status, 'pending')))
    .orderBy(desc(invitations.createdAt))
  return rows.map(serInvitation)
}

export async function create(
  ctx: Ctx,
  deps: CoreDeps,
  input: { workspaceId: string } & z.infer<typeof core.CreateInvitations>,
): Promise<core.Invitation[]> {
  const { kernel } = ctx
  const db = kernel.database.db
  const inviterId = requireUser(ctx.principal)
  const ws = await requireWorkspace(kernel, input.workspaceId)
  if (ws.archivedAt) throw KernError.conflict('Workspace is archived', 'core.workspace.archived')
  const myRole = callerRole(ctx.principal, input.workspaceId)!
  const [inviter] = await db.select().from(user).where(eq(user.id, inviterId)).limit(1)

  // resolve userId → email
  const userIds = input.invites.map((i) => i.userId).filter((x): x is UserId => Boolean(x))
  const usersById = new Map(
    (userIds.length ? await db.select().from(user).where(inArray(user.id, userIds)) : []).map((u) => [
      u.id,
      u,
    ]),
  )
  const targets: Array<{ email: string; userId: string | null; invite: (typeof input.invites)[number] }> = []
  for (const inv of input.invites) {
    const u = inv.userId ? usersById.get(inv.userId) : null
    const email = (u?.email ?? inv.email ?? '').trim().toLowerCase()
    if (!email) throw KernError.badRequest('Each invite needs an email or userId')
    if (inv.userId && !u) throw KernError.notFound('User')
    if (ROLE_RANK[inv.role] > ROLE_RANK[myRole] || (inv.role === 'owner' && myRole !== 'owner'))
      throw KernError.forbidden('core.members.manage')
    if (inv.role !== 'guest' && inv.guestScopes.length)
      throw KernError.badRequest('guestScopes only apply to guests')
    targets.push({ email, userId: u?.id ?? null, invite: inv })
  }
  // users already members by email
  const emails = targets.map((t) => t.email)
  const existingUsers = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.email, emails))
  const byEmail = new Map(existingUsers.map((u) => [u.email, u.id]))
  const memberIds = new Set(
    (
      await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, input.workspaceId),
            inArray(memberships.userId, [...byEmail.values(), ...userIds]),
          ),
        )
    ).map((m) => m.userId),
  )
  // revoke previous pending invites for the same emails
  await db
    .update(invitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(invitations.workspaceId, input.workspaceId),
        eq(invitations.status, 'pending'),
        inArray(invitations.email, emails),
      ),
    )

  const out: core.Invitation[] = []
  for (const t of targets) {
    const existingUserId = t.userId ?? byEmail.get(t.email) ?? null
    if (existingUserId && memberIds.has(existingUserId))
      throw KernError.conflict(`${t.email} is already a member`, 'core.members.already_member')
    const token = randomBytes(32).toString('base64url')
    const [row] = await db
      .insert(invitations)
      .values({
        workspaceId: input.workspaceId,
        email: t.email,
        userId: existingUserId,
        role: t.invite.role,
        roleIds: t.invite.roleIds,
        groupIds: t.invite.groupIds,
        guestScopes: t.invite.guestScopes,
        invitedBy: inviterId,
        message: input.message ?? null,
        token,
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
      })
      .returning()
    if (!row) continue
    const url = inviteUrl(kernel.env.KERN_BASE_URL, token)
    const { html, text } = renderEmail({
      title: `${inviter?.name ?? 'Someone'} invited you to ${ws.name}`,
      intro: `${inviter?.name ?? 'A Kern user'} (${inviter?.email ?? ''}) invited you to join the "${ws.name}" workspace on Kern as ${t.invite.role}.${input.message ? `\n\n"${input.message}"` : ''}`,
      actionUrl: url,
      actionLabel: 'Accept invitation',
      footer: `This invitation expires in ${INVITATION_TTL_DAYS} days.`,
    })
    deps.mailer
      .send({
        to: t.email,
        subject: `Invitation to join ${ws.name} on Kern`,
        text,
        html,
        workspaceId: input.workspaceId,
      })
      .catch((err) => kernel.log.warn({ err }, 'invitation mail failed'))
    if (existingUserId) {
      await createNotification(ctx, deps, {
        userId: existingUserId as UserId,
        workspaceId: null,
        module: 'core',
        type: 'core.invitation.received',
        title: `You were invited to ${ws.name}`,
        body: input.message ?? null,
        object: null,
        url: `/invite/${token}`,
        data: { workspaceId: input.workspaceId, invitationId: row.id },
        groupKey: `invite:${row.id}`,
        actorId: inviterId as UserId,
      }).catch((err: Error) => kernel.log.warn({ err }, 'invitation notification failed'))
    }
    out.push(serInvitation(row))
  }
  await kernel.realtime.change(input.workspaceId, {
    module: 'core',
    entity: 'invitation',
    id: input.workspaceId,
    op: 'created',
  })
  return out
}

export async function revoke(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  const [row] = await ctx.kernel.database.db
    .update(invitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.status, 'pending'),
      ),
    )
    .returning()
  if (!row) throw KernError.notFound('Invitation')
  await ctx.kernel.realtime.change(workspaceId, { module: 'core', entity: 'invitation', id, op: 'deleted' })
}

async function byToken(ctx: Ctx, token: string) {
  const [row] = await ctx.kernel.database.db
    .select({ i: invitations, w: workspaces })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(eq(invitations.token, token))
    .limit(1)
  if (!row) throw KernError.notFound('Invitation')
  return row
}

export async function preview(ctx: Ctx, token: string) {
  const { i, w } = await byToken(ctx, token)
  const [inviter] = await ctx.kernel.database.db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, i.invitedBy))
    .limit(1)
  const expired = i.status !== 'pending' || i.expiresAt.getTime() < Date.now()
  return {
    workspace: { id: w.id as WorkspaceId, name: w.name, slug: w.slug, logoUrl: w.logoUrl },
    email: i.email,
    inviter: inviter?.name ?? 'Unknown',
    expired,
  }
}

export async function accept(ctx: Ctx, token: string): Promise<core.Workspace> {
  const { kernel } = ctx
  const db = kernel.database.db
  const userId = requireUser(ctx.principal)
  const { i, w } = await byToken(ctx, token)
  if (i.status !== 'pending')
    throw KernError.conflict('Invitation is no longer valid', 'core.invitation.invalid')
  if (i.expiresAt.getTime() < Date.now()) {
    await db.update(invitations).set({ status: 'expired' }).where(eq(invitations.id, i.id))
    throw KernError.conflict('Invitation has expired', 'core.invitation.expired')
  }
  if (w.archivedAt) throw KernError.conflict('Workspace is archived', 'core.workspace.archived')
  const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1)
  if (i.userId !== userId && me?.email.toLowerCase() !== i.email.toLowerCase())
    throw KernError.forbidden('core.invitation.email_mismatch')

  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, w.id), eq(memberships.userId, userId)))
    .limit(1)
  if (existing.length) {
    await db
      .update(memberships)
      .set({
        status: 'active',
        role: i.role,
        roleIds: i.roleIds,
        guestScopes: i.guestScopes,
        updatedAt: new Date(),
      })
      .where(eq(memberships.id, existing[0]!.id))
  } else {
    await db.insert(memberships).values({
      workspaceId: w.id,
      userId,
      role: i.role,
      roleIds: i.roleIds,
      groupIds: [],
      guestScopes: i.guestScopes,
      status: 'active',
    })
  }
  await db
    .update(invitations)
    .set({ status: 'accepted', acceptedAt: new Date(), userId })
    .where(eq(invitations.id, i.id))
  if (i.groupIds.length) {
    const { setMembersForUser } = await import('./groups.js')
    await setMembersForUser(ctx, w.id, userId, i.groupIds)
  }
  await permissionsChanged(kernel, w.id, [userId], userId)
  await kernel.emit(
    coreEvents.memberJoined,
    { workspaceId: w.id as never, userId: userId as never, role: i.role as BuiltinRole },
    { workspaceId: w.id, actorId: userId },
  )
  await kernel.realtime.change(w.id, { module: 'core', entity: 'member', id: userId, op: 'created' })
  return serWorkspace(w)
}

/** cron: mark stale invitations as expired */
export async function expireStale(ctx: Ctx): Promise<number> {
  const rows = await ctx.kernel.database.db
    .update(invitations)
    .set({ status: 'expired' })
    .where(and(eq(invitations.status, 'pending'), lt(invitations.expiresAt, new Date())))
    .returning({ id: invitations.id })
  return rows.length
}
