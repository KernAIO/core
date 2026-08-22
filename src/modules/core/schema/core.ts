/**
 * Core platform tables in `mod_core`.
 *
 * Global (NOT row-level-secured; keyed by user or instance): workspaces, memberships, invitations, notifications,
 * notification_settings, push_subscriptions, instance_settings, files (looked up by id without a workspace in the
 * contract – membership is checked in the service layer).
 * Tenant tables (RLS via `app.workspace_id`, see migrations): roles, groups, group_members, role_bindings,
 * workspace_modules, integrations, activity_events, search_documents.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth.js'
import { coreSchema } from './base.js'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// ---------- workspaces & membership (global) ----------
export const workspaces = coreSchema.table(
  'workspaces',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    logoUrl: text('logo_url'),
    accentColor: text('accent_color'),
    autoJoinDomains: text('auto_join_domains').array().notNull().default(sql`'{}'::text[]`),
    defaultRole: text('default_role').notNull().default('member'),
    plan: text('plan').notNull().default('self_hosted'),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('workspaces_archived_idx').on(t.archivedAt)],
)

export const memberships = coreSchema.table(
  'memberships',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    roleIds: uuid('role_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** denormalised from group_members so principal loading touches one global table */
    groupIds: uuid('group_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** guests: object refs (projects/channels) they may access */
    guestScopes: text('guest_scopes').array().notNull().default(sql`'{}'::text[]`),
    title: text('title'),
    status: text('status').notNull().default('active'),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_ws_user_uq').on(t.workspaceId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
)

export const invitations = coreSchema.table(
  'invitations',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** set when an existing user was invited directly */
    userId: uuid('user_id'),
    role: text('role').notNull().default('member'),
    roleIds: uuid('role_ids').array().notNull().default(sql`'{}'::uuid[]`),
    groupIds: uuid('group_ids').array().notNull().default(sql`'{}'::uuid[]`),
    guestScopes: text('guest_scopes').array().notNull().default(sql`'{}'::text[]`),
    invitedBy: uuid('invited_by').notNull(),
    message: text('message'),
    token: text('token').notNull().unique(),
    status: text('status').notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('invitations_ws_idx').on(t.workspaceId, t.status),
    index('invitations_email_idx').on(t.email),
  ],
)

// ---------- roles / groups / bindings (tenant) ----------
export const roles = coreSchema.table(
  'roles',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    builtin: boolean('builtin').notNull().default(false),
    /** for builtin rows: owner|admin|member|guest */
    builtinKey: text('builtin_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_ws_name_uq').on(t.workspaceId, t.name)],
)

export const groups = coreSchema.table(
  'groups',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    handle: text('handle').notNull(),
    description: text('description'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_ws_handle_uq').on(t.workspaceId, t.handle)],
)

export const groupMembers = coreSchema.table(
  'group_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_ws_user_idx').on(t.workspaceId, t.userId),
  ],
)

export const roleBindings = coreSchema.table(
  'role_bindings',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'cascade' }),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id').notNull(),
    deny: boolean('deny').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('role_bindings_ws_scope_idx').on(t.workspaceId, t.scopeKind, t.scopeId),
    index('role_bindings_ws_subject_idx').on(t.workspaceId, t.subjectType, t.subjectId),
  ],
)

// ---------- modules, settings, integrations ----------
export const workspaceModules = coreSchema.table(
  'workspace_modules',
  {
    workspaceId: uuid('workspace_id').notNull(),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    installedVersion: text('installed_version'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.moduleId] })],
)

/** instance-level key/value settings (global) */
export const instanceSettings = coreSchema.table('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const integrations = coreSchema.table(
  'integrations',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    /** secret-valued leaves encrypted with kernel.secrets */
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integrations_ws_kind_uq').on(t.workspaceId, t.kind)],
)

// ---------- notifications (global, per user) ----------
export const notifications = coreSchema.table(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id'),
    module: text('module').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    object: jsonb('object').$type<{ module: string; type: string; id: string } | null>(),
    url: text('url'),
    actorId: uuid('actor_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    groupKey: text('group_key'),
    urgent: boolean('urgent').notNull().default(false),
    emailQueued: boolean('email_queued').notNull().default(false),
    emailedAt: ts('emailed_at'),
    readAt: ts('read_at'),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_unread_idx')
      .on(t.userId, t.workspaceId)
      .where(sql`read_at is null and archived_at is null`),
    index('notifications_digest_idx').on(t.userId).where(sql`email_queued and emailed_at is null`),
  ],
)

export const notificationSettings = coreSchema.table('notification_settings', {
  userId: uuid('user_id').primaryKey(),
  emailDigest: text('email_digest').notNull().default('daily'),
  quietHours: jsonb('quiet_hours').$type<{ start: string; end: string; timezone: string } | null>(),
  preferences: jsonb('preferences')
    .$type<
      Array<{ type: string; workspaceId: string | null; inapp: boolean; push: boolean; email: boolean }>
    >()
    .notNull()
    .default(sql`'[]'::jsonb`),
  lastDigestAt: ts('last_digest_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const pushSubscriptions = coreSchema.table(
  'push_subscriptions',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
)

// ---------- files (looked up by id; membership checked in service) ----------
export const files = coreSchema.table(
  'files',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull().default(0),
    key: text('key').notNull(),
    sha256: text('sha256'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    thumbnailKey: text('thumbnail_key'),
    attachedTo: jsonb('attached_to').$type<{ module: string; type: string; id: string } | null>(),
    uploadedBy: uuid('uploaded_by').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('files_ws_idx').on(t.workspaceId, t.createdAt),
    index('files_attached_idx').on(t.workspaceId, t.attachedTo),
  ],
)

// ---------- activity (tenant; append-only) ----------
export const activityEvents = coreSchema.table(
  'activity_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    module: text('module').notNull(),
    objectModule: text('object_module').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    changes: jsonb('changes')
      .$type<Array<{ field: string; from: unknown; to: unknown }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    index('activity_ws_time_idx').on(t.workspaceId, t.occurredAt),
    index('activity_ws_object_idx').on(t.workspaceId, t.objectModule, t.objectType, t.objectId, t.occurredAt),
    index('activity_ws_actor_idx').on(t.workspaceId, t.actorId, t.occurredAt),
  ],
)

// ---------- search (tenant) ----------
export const searchDocuments = coreSchema.table(
  'search_documents',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    module: text('module').notNull(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    url: text('url').notNull(),
    icon: text('icon'),
    /** null = visible to every member; else user ids / group ids / `role:<role>` */
    acl: text('acl').array(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('search_documents_object_uq').on(t.workspaceId, t.module, t.objectType, t.objectId),
    index('search_documents_tsv_idx').using('gin', t.tsv),
    index('search_documents_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
    index('search_documents_ws_updated_idx').on(t.workspaceId, t.updatedAt),
  ],
)

/** tables that get RLS policies in migrations */
export const RLS_TABLES = [
  'roles',
  'groups',
  'group_members',
  'role_bindings',
  'workspace_modules',
  'integrations',
  'activity_events',
  'search_documents',
] as const
