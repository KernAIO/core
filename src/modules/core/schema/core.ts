/**
 * Core platform tables in `mod_core`.
 *
 * Global (NOT row-level-secured; keyed by user or instance): workspaces, memberships, invitations, notifications,
 * notification_settings, push_subscriptions, instance_settings, files (looked up by id without a workspace in the
 * contract – membership is checked in the service layer).
 * Tenant tables (RLS via `app.workspace_id`, see migrations): roles, groups, group_members, role_bindings,
 * workspace_modules, integrations, activity_events, search_documents.
 */
import type { core } from '@kernhq/contracts'
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

/** One placed card, as stored. Mirrors `DashboardItem` in `@kernhq/contracts`. */
export interface DashboardItemRow {
  i: string
  widget: string
  x: number
  y: number
  w: number
  h: number
  size: 's' | 'm' | 'l' | 'xl'
  settings: Record<string, string | number | boolean | null>
}

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

// ---------- dashboard (tenant) ----------

/**
 * A dashboard layout: one row per person per surface, plus one row per surface with a null
 * `user_id` holding what the workspace hands out.
 *
 * `items` is jsonb, which the database does not lay out, so every read runs it through the grid's
 * `normalise()` before it reaches a screen — a row written by an older app version, or by hand, must
 * not be able to draw two widgets on top of each other.
 */
export const dashboardLayouts = coreSchema.table(
  'dashboard_layouts',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    /** null = the layout the workspace hands out */
    userId: uuid('user_id'),
    surface: text('surface').notNull().default('home'),
    items: jsonb('items').$type<DashboardItemRow[]>().notNull().default(sql`'[]'::jsonb`),
    /** which preset this layout was seeded from, for "reset" to say what it returns to */
    presetId: text('preset_id'),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  // The two unique indexes are partial and hand-written in the migration: a plain unique index
  // treats every NULL as distinct, so the workspace row could be inserted any number of times.
  (t) => [index('dashboard_layouts_ws_user_idx').on(t.workspaceId, t.userId)],
)

/** One row per workspace per surface: how much of the layout the workspace decides. */
export const dashboardSettings = coreSchema.table(
  'dashboard_settings',
  {
    workspaceId: uuid('workspace_id').notNull(),
    surface: text('surface').notNull().default('home'),
    /** 'locked' | 'default' | 'open' */
    policy: text('policy').notNull().default('default'),
    defaultPresetId: text('default_preset_id').notNull().default('my-work'),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.surface] })],
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
    /**
     * `{ permission, scope }` the caller must clear through `Authz.can` before this hit is shown;
     * null = nothing to prove beyond `acl`. See `SearchDocument.authz` in `@kernhq/contracts`.
     */
    authz: jsonb('authz').$type<core.SearchDocument['authz']>(),
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

// ---------- data export (tenant) ----------

/**
 * One request to take a copy of a workspace's data away.
 *
 * The artifact itself is an object in storage, not a row: an export of a busy workspace is far too
 * large for the database, and putting it in the bucket means the same presigned-URL path every other
 * download already uses. `expiresAt` is what makes an export a copy rather than a second permanent
 * home for the data — a stale one is deleted by the cleanup pass whether or not anybody fetched it.
 */
export const dataExports = coreSchema.table(
  'data_exports',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    /** pending | running | ready | failed | expired */
    status: text('status').notNull().default('pending'),
    /** storage key of the artifact, once there is one */
    key: text('key'),
    sizeBytes: integer('size_bytes'),
    /** modules that own data and could not contribute it — see `services/exports.ts` */
    followUps: jsonb('follow_ups').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('data_exports_ws_created_idx').on(t.workspaceId, t.createdAt)],
)

// ---------- erasure (global: an account deletion belongs to no workspace) ----------

/**
 * A scheduled erasure of a workspace or an account, and the grace period in front of it.
 *
 * Deliberately **not** row-level secured, for the same reason `workspaces` and `memberships` are
 * not: an account deletion has no workspace to scope to, and the purge worker has to be able to find
 * every request that is due without knowing which tenant it belongs to first.
 *
 * `purgeAfter` is the whole point of the row existing. The terms promise a window in which a
 * deletion can be undone, and a delete that happens the moment the button is pressed cannot honour
 * that; the row is the promise, and `status` is how far through it the request is.
 */
export const deletionRequests = coreSchema.table(
  'deletion_requests',
  {
    id: id(),
    /** workspace | account */
    subjectKind: text('subject_kind').notNull(),
    /** workspace id, or user id */
    subjectId: uuid('subject_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    reason: text('reason'),
    /** scheduled | cancelled | running | done | failed */
    status: text('status').notNull().default('scheduled'),
    purgeAfter: ts('purge_after').notNull(),
    /** modules that were told to erase and could not be reached — see `services/deletion.ts` */
    followUps: jsonb('follow_ups').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    // Partial and hand-written in the migration: at most one request may be open for a subject, and
    // a plain unique index would refuse the second deletion of a workspace somebody once cancelled.
    index('deletion_requests_due_idx').on(t.status, t.purgeAfter),
    index('deletion_requests_subject_idx').on(t.subjectKind, t.subjectId),
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
  'dashboard_layouts',
  'dashboard_settings',
  'data_exports',
] as const

/**
 * The complement of `RLS_TABLES`: tables that carry `workspace_id` and deliberately have no policy,
 * each with the reason and the code that isolates them instead.
 *
 * `mod_core` holds the largest group of these in the product, and for a reason the modules do not
 * have: core is where a request stops being anonymous. A policy keyed on `app.workspace_id` can
 * only protect a table read *after* the workspace is known, and each of these is read before — a
 * link, a token or a session that has not yet been resolved to a tenant. The workspace is the
 * lookup's **output**, so it cannot be its input.
 *
 * Adding a name here is a decision somebody records, not a way to make a red test green: a table
 * that belongs here is one whose isolation is enforced somewhere a reader can go and look at.
 * Every line below was traced through its callers on 2026-09-06, not inferred from the table's
 * shape. `src/tests/migrations.test.ts` holds the list to the catalogue in three directions, and
 * `src/tests/isolation.test.ts` reads the same map so the two cannot drift.
 */
export const UNSECURED_BY_DESIGN: Record<string, string> = {
  files:
    'a file URL carries an id and no workspace, so `getFileRow` (services/files.ts:51) selects on ' +
    'the id alone. Every procedure taking a caller-supplied id goes through `requireFile` (:72), ' +
    'which reads the row and then refuses unless the principal is an instance admin, a service, or ' +
    "holds a membership in the row's own `workspaceId`. `getFileRow`'s only other caller is the " +
    '`core.thumbnail` job handler (`generateThumbnail`, :306), whose id is enqueued by `complete` ' +
    '(:230) after `requireFile`. Every other query filters on the workspace: `currentStorageBytes` ' +
    '(:63), deletion.ts:205 and :225, exports.ts:282.',
  invitations:
    'an invitation is redeemed by a stranger holding a link, who has no membership yet and ' +
    'therefore no workspace to bind: `byToken` (services/invitations.ts:191) resolves the token ' +
    'alone and serves `preview` and `accept`, and `hasPendingInvitation` (auth/signup.ts:75) reads ' +
    'it at sign-up for the same reason. The member-facing paths filter on the workspace — `list` ' +
    '(:19) and `revoke` (:175), both behind `scoped` + `requires(core.members.invite)` in ' +
    'router.ts:99-110 — as do deletion.ts:227 and exports.ts:281.',
  memberships:
    'the table that answers *which* workspaces a caller is in, so it is necessarily read before ' +
    'one can be bound: `loadMemberships` (auth/principal.ts:96-103) selects by `userId` with no ' +
    'workspace filter and its result becomes `principal.memberships`, which is what every later ' +
    'membership check consults. Every one of the other reads filters on a workspace id or on a ' +
    'user id.',
  notifications:
    "a notification belongs to one person, and the shell's badge counts them across every " +
    'workspace at once: `counts` (services/notifications.ts:232) groups by `workspaceId` filtered ' +
    'on `userId` alone, so a policy binding one workspace would answer with one workspace of the ' +
    'badge. Every user-facing read and write filters on `notifications.userId` — `list` (:207), ' +
    '`markRead` (:250), `archive` (:269), `sendBadge` (:182) — and `runDigest` (:422) enumerates ' +
    'recipients from a clock, so it has neither a user nor a workspace bound.',
  mcp_codes:
    'the OAuth token endpoint presents an authorization code and nothing else: `exchangeCode` ' +
    '(mcp/oauth.ts:236) selects on `sha256(code)`, and the workspace is what the row returns. The ' +
    'row is written by `oauth.approve` (:189), which `mcp.approve` (services/mcp.ts:60) reaches ' +
    'only after `requireMember` for the workspace being consented to.',
  mcp_tokens:
    'the same shape one step later: `verifyAccessToken` (mcp/oauth.ts:295) and `rotateRefresh` ' +
    '(:269) resolve a bearer by token hash and kind before any workspace is known, and the ' +
    "grant's workspace comes out of the row. `revokeConnection` (services/mcp.ts:199) is the one " +
    "caller-supplied id: it reads the row, then requires `core.integrations.manage` at the row's " +
    "own workspace unless the token is the caller's. `listWorkspaceTokens` (:167) filters on " +
    '`workspaceId`.',
  mcp_consents:
    'read by `userId` + `clientId` on the consent screen (services/mcp.ts:43-47), where the user ' +
    "id is the auth request's and the request has already been refused unless it is the caller's " +
    '(:41). Written only by `oauth.approve`, which `mcp.approve` (:60) reaches after ' +
    '`requireMember(principal, workspaceId)`.',
}
