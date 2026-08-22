import type { core } from '@kernalo/contracts'
import type {
  activityEvents,
  files,
  groups,
  invitations,
  memberships,
  notifications,
  roleBindings,
  roles,
  user,
  workspaces,
} from '../schema/index.js'

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect']
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
const isoReq = (d: Date): string => d.toISOString()

export function serUser(u: Row<typeof user>): core.User {
  return {
    id: u.id as core.User['id'],
    email: u.email,
    name: u.name,
    username: u.username,
    avatarUrl: u.image,
    locale: u.locale as core.User['locale'],
    timezone: u.timezone,
    instanceAdmin: u.instanceAdmin,
    status: u.status as core.User['status'],
    emailVerified: u.emailVerified,
    createdAt: isoReq(u.createdAt),
    updatedAt: isoReq(u.updatedAt),
  }
}
export function serUserPublic(
  u: Pick<Row<typeof user>, 'id' | 'name' | 'username' | 'image' | 'email'>,
  opts: { email?: boolean; title?: string | null } = {},
): core.UserPublic {
  return {
    id: u.id as core.UserPublic['id'],
    name: u.name,
    username: u.username,
    avatarUrl: u.image,
    ...(opts.email === false ? {} : { email: u.email }),
    title: opts.title ?? null,
  }
}

export function serWorkspace(w: Row<typeof workspaces>): core.Workspace {
  return {
    id: w.id as core.Workspace['id'],
    slug: w.slug,
    name: w.name,
    description: w.description,
    logoUrl: w.logoUrl,
    accentColor: w.accentColor,
    autoJoinDomains: w.autoJoinDomains,
    defaultRole: w.defaultRole as core.Workspace['defaultRole'],
    plan: w.plan as core.Workspace['plan'],
    archivedAt: iso(w.archivedAt),
    createdBy: w.createdBy as core.Workspace['createdBy'],
    createdAt: isoReq(w.createdAt),
    updatedAt: isoReq(w.updatedAt),
  }
}

export function serMember(
  m: Row<typeof memberships>,
  u: Pick<Row<typeof user>, 'id' | 'name' | 'email' | 'username' | 'image'>,
): core.Member {
  return {
    id: m.id,
    workspaceId: m.workspaceId as core.Member['workspaceId'],
    userId: m.userId as core.Member['userId'],
    role: m.role as core.Member['role'],
    roleIds: m.roleIds,
    groupIds: m.groupIds,
    title: m.title,
    status: m.status as core.Member['status'],
    joinedAt: isoReq(m.joinedAt),
    user: {
      id: u.id as core.Member['userId'],
      name: u.name,
      email: u.email,
      username: u.username,
      avatarUrl: u.image,
    },
  }
}

export function serInvitation(i: Row<typeof invitations>): core.Invitation {
  return {
    id: i.id,
    workspaceId: i.workspaceId as core.Invitation['workspaceId'],
    email: i.email,
    role: i.role as core.Invitation['role'],
    roleIds: i.roleIds,
    groupIds: i.groupIds,
    guestScopes: i.guestScopes,
    invitedBy: i.invitedBy as core.Invitation['invitedBy'],
    message: i.message,
    status: i.status as core.Invitation['status'],
    expiresAt: isoReq(i.expiresAt),
    createdAt: isoReq(i.createdAt),
  }
}

export function serRole(r: Row<typeof roles>): core.Role {
  return {
    id: r.id,
    workspaceId: r.workspaceId as core.Role['workspaceId'],
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    builtin: r.builtin,
    createdAt: isoReq(r.createdAt),
  }
}
export function serGroup(g: Row<typeof groups>, memberCount = 0): core.Group {
  return {
    id: g.id,
    workspaceId: g.workspaceId as core.Group['workspaceId'],
    name: g.name,
    handle: g.handle,
    description: g.description,
    memberCount,
    createdAt: isoReq(g.createdAt),
  }
}
export function serBinding(b: Row<typeof roleBindings>): core.RoleBinding {
  return {
    id: b.id,
    workspaceId: b.workspaceId as core.RoleBinding['workspaceId'],
    subjectType: b.subjectType as core.RoleBinding['subjectType'],
    subjectId: b.subjectId,
    roleId: b.roleId,
    permissions: b.permissions,
    scopeKind: b.scopeKind as core.RoleBinding['scopeKind'],
    scopeId: b.scopeId,
    deny: b.deny,
  }
}
export function serNotification(
  n: Row<typeof notifications>,
  actor: { id: string; name: string; avatarUrl: string | null } | null,
): core.Notification {
  return {
    id: n.id,
    userId: n.userId as core.Notification['userId'],
    workspaceId: n.workspaceId as core.Notification['workspaceId'],
    module: n.module,
    type: n.type,
    title: n.title,
    body: n.body,
    object: n.object as core.Notification['object'],
    url: n.url,
    actor: actor
      ? { id: actor.id as core.Notification['userId'], name: actor.name, avatarUrl: actor.avatarUrl }
      : null,
    data: n.data,
    groupKey: n.groupKey,
    readAt: iso(n.readAt),
    archivedAt: iso(n.archivedAt),
    createdAt: isoReq(n.createdAt),
  }
}
export function serFile(f: Row<typeof files>): core.FileObject {
  return {
    id: f.id,
    workspaceId: f.workspaceId as core.FileObject['workspaceId'],
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    key: f.key,
    sha256: f.sha256,
    width: f.width,
    height: f.height,
    durationMs: f.durationMs,
    thumbnailKey: f.thumbnailKey,
    attachedTo: f.attachedTo as core.FileObject['attachedTo'],
    uploadedBy: f.uploadedBy as core.FileObject['uploadedBy'],
    status: f.status as core.FileObject['status'],
    createdAt: isoReq(f.createdAt),
  }
}
export function serActivity(a: Row<typeof activityEvents>): core.ActivityEvent {
  return {
    id: a.id,
    workspaceId: a.workspaceId as core.ActivityEvent['workspaceId'],
    module: a.module,
    object: { module: a.objectModule, type: a.objectType, id: a.objectId },
    action: a.action,
    actorId: a.actorId as core.ActivityEvent['actorId'],
    changes: a.changes,
    data: a.data,
    occurredAt: isoReq(a.occurredAt),
  }
}
