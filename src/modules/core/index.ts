import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coreContract, defineCapabilities, Principal } from '@kernhq/contracts'
import {
  CreateNotification,
  coreEvents,
  corePermissions,
  RecordActivity,
  SearchDocument,
} from '@kernhq/contracts/core'
import {
  type AuthzStore,
  defineModule,
  defineServerModule,
  KernError,
  type Kernel,
  packageVersion,
  type ServerModule,
} from '@kernhq/kernel'
import { z } from 'zod'
import type { CoreDeps } from './deps.js'
import { coreLifecycleEvents } from './events.js'
import { coreHttpRoutes } from './http-routes.js'
import { createCoreRouter } from './router.js'
import { coreSchema, MODULE_ID } from './schema/base.js'
import * as access from './services/access.js'
import * as activity from './services/activity.js'
import type { Ctx } from './services/common.js'
import * as deletion from './services/deletion.js'
import * as exportsSvc from './services/exports.js'
import * as filesSvc from './services/files.js'
import * as invitations from './services/invitations.js'
import * as members from './services/members.js'
import * as modules from './services/modules.js'
import * as notifications from './services/notifications.js'
import * as retention from './services/retention.js'
import * as roles from './services/roles.js'
import * as search from './services/search.js'
import * as updates from './services/updates.js'
import * as users from './services/users.js'
import * as workspaces from './services/workspaces.js'

export const CORE_VERSION = packageVersion(import.meta.url)

/** DB-backed permission store handed to `createKernel({ authzStore })` (other services resolve these over the broker). */
export const createAuthzStore = (kernel: Kernel): AuthzStore => ({
  customRolePermissions: (workspaceId, userId) => roles.customRolePermissions(kernel, workspaceId, userId),
  bindings: (workspaceId, userId, groupIds, role) =>
    roles.bindingsFor(kernel, workspaceId, userId, groupIds, role),
})

/** Broker procedures are for other Kern services (and instance admins) – never for end-user principals. */
function requireService(principal: Principal) {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

const sysCtx = (kernel: Kernel, principal: Principal): Ctx => ({ kernel, principal })

/**
 * The core module: identity, workspaces, membership, permissions, notifications,
 * settings, files, search and activity. Always enabled; hosted by the core service.
 */
export function createCoreModule(deps: CoreDeps): ServerModule {
  return defineServerModule({
    definition: defineModule({
      id: MODULE_ID,
      name: 'Core',
      version: CORE_VERSION,
      description: 'Accounts, workspaces, members, permissions, notifications, settings, files and search',
      icon: 'settings',
      core: true,
      permissions: corePermissions,
      // The erasure lifecycle is core's own rather than the shared contract's: only core can publish
      // it, and a module subscribes by name. See `events.ts`.
      events: { ...coreEvents, ...coreLifecycleEvents },
      capabilities: defineCapabilities([
        {
          id: 'mcp',
          label: 'MCP (AI access)',
          description:
            'Let people connect AI clients — Claude, Cursor, an agent — and use this workspace through them',
          defaultEnabled: false,
          level: 2,
        },
        {
          id: 'api_keys',
          label: 'Personal API keys',
          description: 'Let people generate their own key for calling the API directly, outside MCP',
          defaultEnabled: false,
          level: 2,
        },
      ]),
      notificationTypes: [
        {
          type: 'core.invitation.received',
          label: 'Workspace invitations',
          description: 'Someone invited you to join a workspace',
          defaults: { inapp: true, push: true, email: true },
          urgent: false,
        },
        {
          type: 'core.mention',
          label: 'Mentions',
          description: 'Someone mentioned you',
          defaults: { inapp: true, push: true, email: true },
          urgent: true,
        },
        {
          type: 'core.member.joined',
          label: 'New members',
          description: 'Someone joined a workspace you manage',
          defaults: { inapp: true, push: false, email: false },
          urgent: false,
        },
        {
          type: 'core.system',
          label: 'System announcements',
          description: 'Instance-level announcements from your admins',
          defaults: { inapp: true, push: false, email: true },
          urgent: false,
        },
      ],
    }),
    /** Attached so the developer panel can check the router against what the contract promised. */
    contract: coreContract,
    schema: coreSchema,
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../../migrations'),
    router: (kernel) => createCoreRouter(kernel, deps),
    /**
     * Export and erasure. Plain HTTP rather than oRPC because `coreContract` lives in
     * `@kernhq/contracts` and cannot carry them yet, and `admin.diagnostics` rightly fails a module
     * that implements a procedure it never declared — see the header of `http-routes.ts` for what
     * that costs and what is done about it.
     */
    httpRoutes: coreHttpRoutes(deps),

    subscriptions: {
      // membership/role changes → drop cached principals so new permissions apply on the next request
      'core.permissions.changed': async (e) => {
        const p = e.payload as { userIds: string[] | null }
        deps.principals?.invalidate(p.userIds)
      },
      /**
       * An instance admin reached a workspace they are not a member of — here, or in chat, mail or
       * collab, which is why this arrives as an event rather than as a local sink. Core owns the
       * audit log, so core writes the row. See `services/access.ts`.
       */
      'kernel.access.crossed': async (e, kernel) => {
        await access.recordUnscopedAccess(kernel, e.payload as access.UnscopedAccessEvent)
      },
    },

    jobs: [
      {
        name: 'thumbnail',
        schema: z.object({ fileId: z.uuid() }),
        handler: async (input, { kernel }) => filesSvc.generateThumbnail(kernel, input.fileId),
        options: { retryLimit: 2 },
      },
      {
        name: 'push.send',
        schema: z.object({
          userId: z.uuid(),
          title: z.string(),
          body: z.string().nullable().default(null),
          url: z.string().nullable().default(null),
          tag: z.string().nullable().optional(),
          workspaceId: z.uuid().nullable().optional(),
        }),
        handler: async (input, { kernel }) =>
          notifications.deliverPush(sysCtx(kernel, kernel.system), deps, input),
        options: { retryLimit: 1, expireInSeconds: 120 },
      },
      {
        name: 'notifications.digest',
        cron: '0 * * * *',
        handler: async (_input, { kernel }) => {
          const { sent, failed, abandoned } = await notifications.runDigest(
            sysCtx(kernel, kernel.system),
            deps,
          )
          // Failures are logged at warn even when some digests went out: a relay that has started
          // refusing addresses is only visible as a number that climbs from one run to the next.
          if (failed) kernel.log.warn({ sent, failed, abandoned }, 'notification digests failed')
          else if (sent) kernel.log.info({ sent }, 'notification digests sent')
        },
      },
      {
        // Six-hourly, on a minute nobody else uses: a release is not urgent, and every instance
        // asking on the hour would be a thundering herd against one static file.
        name: 'updates.check',
        cron: '17 */6 * * *',
        handler: async (_input, { kernel }) => {
          const found = await updates.runScheduledCheck(kernel)
          if (!found) return
          kernel.log.info({ version: found.release.version }, 'newer Kern release available')
          for (const userId of found.adminIds)
            await notifications.createNotification(sysCtx(kernel, kernel.system), deps, {
              userId: userId as never,
              workspaceId: null,
              module: MODULE_ID,
              type: 'core.system',
              title: `Kern ${found.release.version} is available`,
              body: 'Open Admin → Updates to see what it changes and how to apply it.',
              url: '/admin/updates',
              object: null,
              actorId: null,
              data: { version: found.release.version },
              groupKey: `updates:${found.release.version}`,
            })
        },
        options: { singletonKey: 'updates.check' },
      },
      {
        /**
         * The `auditRetentionDays` entitlement, once a night and off the hour so it does not race
         * every other instance's cron. Does nothing at all where nothing bills, which is every
         * self-hosted install — see `services/retention.ts`.
         */
        name: 'audit.retention',
        cron: '40 3 * * *',
        handler: async (_input, { kernel }) => {
          const pass = await retention.runAuditRetention(kernel)
          if (pass.deleted) kernel.log.info(pass, 'audit retention pruned expired activity')
        },
        options: { singletonKey: 'audit.retention' },
      },
      {
        name: 'invitations.expire',
        cron: '15 * * * *',
        handler: async (_input, { kernel }) => {
          const n = await invitations.expireStale(sysCtx(kernel, kernel.system))
          if (n) kernel.log.info({ expired: n }, 'invitations expired')
        },
      },
      /**
       * Building an export reads every table a workspace has, so it is a job and never a request:
       * the workspaces most likely to need one are exactly the ones an HTTP timeout would fail on.
       * It does not retry — a half-written artifact must not be replaced by another attempt while
       * the first is still recorded as running; the row is marked failed and the owner asks again.
       */
      {
        name: 'export.build',
        schema: z.object({ exportId: z.uuid(), workspaceId: z.uuid() }),
        handler: async (input, { kernel }) => {
          await exportsSvc.build(kernel, input.exportId, input.workspaceId)
        },
        options: { retryLimit: 0, expireInSeconds: 3600 },
      },
      {
        name: 'export.expire',
        cron: '25 * * * *',
        handler: async (_input, { kernel }) => {
          const n = await exportsSvc.expireStale(kernel)
          if (n) kernel.log.info({ expired: n }, 'stale workspace exports removed')
        },
        options: { singletonKey: 'export.expire' },
      },
      /**
       * Erasure whose grace period has run out. Hourly rather than daily so the window is honoured
       * to about the hour rather than to about the day — a customer told "thirty days" should not
       * wait thirty-one.
       */
      {
        name: 'deletion.run',
        cron: '5 * * * *',
        handler: async (_input, { kernel }) => {
          const { purged } = await deletion.runDueDeletions(kernel)
          if (purged) kernel.log.info({ purged }, 'scheduled erasures completed')
        },
        options: { singletonKey: 'deletion.run' },
      },
      {
        name: 'search.reindex',
        schema: z.object({ workspaceId: z.uuid(), moduleId: z.string().optional() }),
        handler: async (input, { kernel }) => {
          const n = await search.reindexWorkspace(kernel, input.workspaceId, input.moduleId)
          kernel.log.info({ workspaceId: input.workspaceId, indexed: n }, 'search reindex done')
        },
        options: { singletonKey: 'search.reindex' },
      },
    ],

    procedures: {
      'users.principal': {
        input: z.union([z.object({ token: z.string() }), z.object({ userId: z.uuid() })]),
        output: Principal,
        handler: async (input, { principal }) => {
          requireService(principal)
          return 'token' in input
            ? deps.principals.fromToken(input.token)
            : deps.principals.fromUserId(input.userId)
        },
      },
      /**
       * `workspaceId` is optional and it decides one thing: whether the answer carries email
       * addresses. Naming a workspace restricts the result to its active members and includes the
       * address, which is what a member may see anyway; leaving it out returns the profile without
       * one. See `users.getMany` in `services/users.ts`.
       */
      'users.get': {
        input: z.object({ id: z.uuid(), workspaceId: z.uuid().optional() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          const [u] = await users.getMany(sysCtx(kernel, kernel.system), [input.id], {
            workspaceId: input.workspaceId,
          })
          if (!u) throw KernError.notFound('User')
          return u
        },
      },
      'users.getMany': {
        input: z.object({ ids: z.array(z.uuid()).max(500), workspaceId: z.uuid().optional() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return users.getMany(sysCtx(kernel, kernel.system), input.ids, {
            workspaceId: input.workspaceId,
          })
        },
      },
      'authz.customRolePermissions': {
        input: z.object({ workspaceId: z.uuid(), userId: z.uuid() }),
        output: z.array(z.string()),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return roles.customRolePermissions(kernel, input.workspaceId, input.userId)
        },
      },
      'authz.bindings': {
        input: z.object({
          workspaceId: z.uuid(),
          userId: z.uuid(),
          groupIds: z.array(z.uuid()).default([]),
          role: z.enum(['owner', 'admin', 'member', 'guest']),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return roles.bindingsFor(kernel, input.workspaceId, input.userId, input.groupIds, input.role)
        },
      },
      'settings.getModule': {
        input: z.object({ workspaceId: z.uuid(), moduleId: z.string() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return modules.getModuleSettings(kernel, input.workspaceId, input.moduleId)
        },
      },
      'settings.setModule': {
        input: z.object({
          workspaceId: z.uuid(),
          moduleId: z.string(),
          settings: z.record(z.string(), z.unknown()),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return modules.setModuleSettings(
            kernel,
            input.workspaceId,
            input.moduleId,
            input.settings,
            principal.userId,
          )
        },
      },
      'settings.getIntegration': {
        input: z.object({ workspaceId: z.uuid(), kind: z.string() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return modules.getIntegration(kernel, input.workspaceId, input.kind)
        },
      },
      'settings.setIntegration': {
        input: z.object({
          workspaceId: z.uuid(),
          kind: z.string(),
          config: z.record(z.string(), z.unknown()).nullable(),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          await modules.setIntegration(kernel, input.workspaceId, input.kind, input.config, principal.userId)
          return { ok: true }
        },
      },
      'modules.isEnabled': {
        input: z.object({ workspaceId: z.uuid(), moduleId: z.string() }),
        output: z.boolean(),
        handler: async (input, { kernel }) => modules.isEnabled(kernel, input.workspaceId, input.moduleId),
      },
      /**
       * Identity for workspaces another module holds only ids for — a billing module listing every
       * workspace on the instance, for one. Deliberately thin: an id, a name and a slug, never
       * membership or settings.
       */
      'workspaces.list': {
        input: z.object({
          q: z.string().optional(),
          limit: z.number().int().min(1).max(10_000).default(200),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return workspaces.listAll(kernel, input)
        },
      },
      /**
       * How many members a plan is charged for. Split from `workspaces.usage` because it is asked on
       * every membership change, while the byte count behind `usage` is a sum over a whole file table
       * and belongs in a nightly pass.
       */
      'workspaces.seats': {
        input: z.object({ workspaceId: z.uuid() }),
        output: z.object({ seats: z.number().int().nonnegative() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return { seats: await members.billableSeats(kernel, input.workspaceId) }
        },
      },
      /** The authoritative recount, for whatever keeps counters and needs to prove them right. */
      'workspaces.usage': {
        input: z.object({ workspaceId: z.uuid() }),
        output: z.object({
          seats: z.number().int().nonnegative(),
          storageBytes: z.number().int().nonnegative(),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return {
            seats: await members.billableSeats(kernel, input.workspaceId),
            storageBytes: await filesSvc.currentStorageBytes(kernel, input.workspaceId),
          }
        },
      },
      'notifications.create': {
        input: CreateNotification,
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return notifications.createNotification(sysCtx(kernel, kernel.system), deps, input)
        },
      },
      'activity.record': {
        input: RecordActivity,
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return activity.record(kernel, input)
        },
      },
      'search.index': {
        input: z.object({ documents: z.array(SearchDocument).max(1000) }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return { indexed: await search.indexDocuments(kernel, input.documents) }
        },
      },
      'search.remove': {
        input: z.object({
          refs: z.array(z.object({ workspaceId: z.uuid(), object: SearchDocument.shape.object })).max(1000),
        }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return { removed: await search.removeDocuments(kernel, input.refs) }
        },
      },
      'files.get': {
        input: z.object({ id: z.uuid() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return filesSvc.get(sysCtx(kernel, kernel.system), input.id)
        },
      },
      'workspaces.members': {
        input: z.object({ workspaceId: z.uuid() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return members.workspaceMembers(sysCtx(kernel, kernel.system), input.workspaceId)
        },
      },
    },
  })
}
