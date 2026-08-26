import type { Kernel } from '@kernhq/kernel'
import type { Auth } from '../../auth/auth.js'
import type { Mailer } from '../../auth/mail.js'
import type { PrincipalResolver } from '../../auth/principal.js'
import type { CoreEnv } from '../../env.js'
import type { McpRuntime } from '../../mcp/server.js'

/** Runtime dependencies of the core module that live outside the kernel (filled in by the service host before start). */
export interface CoreDeps {
  env: CoreEnv
  mailer: Mailer
  auth: Auth
  principals: PrincipalResolver
  kernel: Kernel
  /** present on API roles, where the MCP surface is mounted */
  mcp?: McpRuntime
}
export const createDepsRef = (): CoreDeps => ({}) as CoreDeps
