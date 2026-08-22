import { createHttpServer, createKernel, type Kernel } from '@kernaio/kernel'
import type { FastifyInstance } from 'fastify'
import { createAuth } from './auth/auth.js'
import { createMailer } from './auth/mail.js'
import { createPrincipalResolver } from './auth/principal.js'
import { bootstrap } from './bootstrap.js'
import { type CoreEnv, loadCoreEnv } from './env.js'
import { extendHttp } from './http.js'
import { type CoreDeps, createDepsRef } from './modules/core/deps.js'
import { CORE_VERSION, createAuthzStore, createCoreModule } from './modules/core/index.js'

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
    service: 'core',
    version: CORE_VERSION,
    modules: [coreModule],
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
      openapi: { title: 'Kern', version: CORE_VERSION },
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
