import { createHttpServer, createKernel, type Kernel } from '@kernhq/kernel'
import { billingModule } from '@kernhq/module-billing/server'
import { hrModule } from '@kernhq/module-hr/server'
import { quireModule } from '@kernhq/module-quire/server'
import { trackerModule } from '@kernhq/module-tracker/server'
import type { FastifyInstance } from 'fastify'
import { createAuth } from './auth/auth.js'
import { createMailer } from './auth/mail.js'
import { createPrincipalResolver } from './auth/principal.js'
import { bootstrap } from './bootstrap.js'
import { type CoreEnv, loadCoreEnv } from './env.js'
import { extendHttp } from './http.js'
import { type CoreDeps, createDepsRef } from './modules/core/deps.js'
import { createAuthzStore, createCoreModule } from './modules/core/index.js'

export interface CoreServiceOptions {
  role?: 'api' | 'worker' | 'both'
  /** environment overrides (tests) – merged over process.env */
  env?: Record<string, string | undefined>
}

export interface CoreService {
  kernel: Kernel
  env: CoreEnv
  deps: CoreDeps
  /** present when role includes the API */
  app: FastifyInstance | null
  stop(): Promise<void>
}

/**
 * The modules this service hosts. `core` is always here; the rest are feature modules that have no
 * runtime reason to be their own process (chat, mail and collab do, and are separate services).
 * Each brings its own Postgres schema, migrations, router at `/api/<id>`, jobs and permissions, and
 * a workspace can switch it off — so hosting one here is not the same as forcing it on anyone.
 */
export const featureModules = [trackerModule, quireModule, hrModule, billingModule]

/**
 * Boots the core service: kernel (DB, events, jobs, authz) + Better Auth + the core module,
 * then the Fastify server for API roles. `main.ts` / `worker.ts` are thin wrappers around this,
 * and tests boot it against a scratch database.
 */
export async function createCoreService(opts: CoreServiceOptions = {}): Promise<CoreService> {
  const role = opts.role ?? 'api'
  const env = loadCoreEnv(opts.env ?? {})
  const deps = createDepsRef()
  const coreModule = createCoreModule(deps)
  const kernel = await createKernel({
    // no `version` here on purpose: the kernel reads KERN_VERSION, the release the image was built
    // as, so every service in an instance answers the same thing
    service: 'core',
    modules: [coreModule, ...featureModules],
    role,
    env: opts.env ?? {},
    authzStore: createAuthzStore,
  })
  deps.kernel = kernel
  deps.env = env
  deps.mailer = createMailer(kernel, env)
  deps.auth = createAuth({ kernel, env, mailer: deps.mailer })
  deps.principals = createPrincipalResolver({ kernel, auth: deps.auth })

  await kernel.start()
  await bootstrap(kernel, deps)

  let app: FastifyInstance | null = null
  if (role !== 'worker') {
    const corsOrigins = [
      ...new Set([
        kernel.env.KERN_BASE_URL,
        ...(kernel.env.CORS_ORIGINS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ]),
    ]
    app = await createHttpServer({
      kernel,
      resolvePrincipal: (req) => deps.principals.resolve(req),
      corsOrigins,
      extend: (fastify) => extendHttp(fastify, kernel, deps),
      openapi: { title: 'Kern', version: kernel.version },
    })
  }

  return {
    kernel,
    env,
    deps,
    app,
    async stop() {
      await app?.close()
      await kernel.stop()
    },
  }
}
