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
import { createCoreRouter } from './router.js'
import { coreSchema, MODULE_ID } from './schema/base.js'
import * as activity from './services/activity.js'
import type { Ctx } from './services/common.js'
import * as filesSvc from './services/files.js'
import * as invitations from './services/invitations.js'
import * as members from './services/members.js'
import * as modules from './services/modules.js'
import * as notifications from './services/notifications.js'
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
      events: coreEvents,
      capabilities: defineCapabilities([
        {
          id: 'mcp',
          label: 'MCP (AI access)',
          description:
            'Let people connect AI clients — Claude, Cursor, an agent — and use this workspace through them',
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

    subscriptions: {
      // membership/role changes → drop cached principals so new permissions apply on the next request
      'core.permissions.changed': async (e) => {
        const p = e.payload as { userIds: string[] | null }
        deps.principals?.invalidate(p.userIds)
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
          const sent = await notifications.runDigest(sysCtx(kernel, kernel.system), deps)
          if (sent) kernel.log.info({ sent }, 'notification digests sent')
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
        name: 'invitations.expire',
        cron: '15 * * * *',
        handler: async (_input, { kernel }) => {
          const n = await invitations.expireStale(sysCtx(kernel, kernel.system))
          if (n) kernel.log.info({ expired: n }, 'invitations expired')
        },
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
      'users.get': {
        input: z.object({ id: z.uuid() }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          const [u] = await users.getMany(sysCtx(kernel, kernel.system), [input.id])
          if (!u) throw KernError.notFound('User')
          return u
        },
      },
      'users.getMany': {
        input: z.object({ ids: z.array(z.uuid()).max(500) }),
        handler: async (input, { kernel, principal }) => {
          requireService(principal)
          return users.getMany(sysCtx(kernel, kernel.system), input.ids)
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
