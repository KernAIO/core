/**
 * The tool catalog: every module's OpenAPI document becomes MCP tools, with no MCP code in any
 * module.
 *
 * This is the piece that makes "all of our APIs are tools" automatic. The kernel already turns each
 * hosted module's oRPC contract into an OpenAPI document; this file reads those documents and
 * derives one tool per operation — name, description and a JSON-Schema input built from the
 * operation's parameters and body. A module that ships a procedure has shipped its tool before it
 * knows anything about MCP.
 *
 * Modules hosted by other services count too: their service's `/api/health` names its modules, and
 * each module serves `/api/<id>/openapi.json`. Both local and remote operations execute through the
 * ordinary REST surface with the caller's token, so permissions, workspace scoping and capability
 * gating all run exactly as they do for every other client.
 */

import type { Kernel } from '@kernhq/kernel'
import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { FastifyRequest } from 'fastify'

/**
 * Services whose modules live outside core's process, mapped to how core reaches them. Locally
 * hosted modules carry an empty-string base URL meaning "dispatch in-process".
 */
const REMOTE_SERVICES: Array<{ urlKey: 'CHAT_URL' | 'MAIL_URL' | 'COLLAB_URL'; label: string }> = [
  { urlKey: 'CHAT_URL', label: 'chat' },
  { urlKey: 'MAIL_URL', label: 'mail' },
  { urlKey: 'COLLAB_URL', label: 'collab' },
]

export interface McpToolDef {
  /** `<module>_<operation>` — unique across the whole catalog */
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  module: string
  write: boolean
  method: string
  /** path template with `{param}` placeholders, e.g. `/workspaces/{workspaceId}/items` */
  template: string
  /** where to send it */
  baseUrl: string | null
}

interface SpecSource {
  moduleId: string
  /** '' → dispatch in-process; a URL → the service hosting the module */
  baseUrl: string | null
  /** where each operation path hangs off this service, e.g. `/api/tracker` */
  basePath: string
  spec: Record<string, unknown>
}

export class ToolCatalog {
  private cache: { tools: McpToolDef[]; exp: number } | null = null
  private readonly ttlMs: number

  constructor(
    private readonly kernel: Kernel,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000
  }

  /** All tools from all reachable modules; failures of a remote service shrink the catalog, not break it. */
  async tools(): Promise<McpToolDef[]> {
    if (this.cache && this.cache.exp > Date.now()) return this.cache.tools
    const sources: SpecSource[] = []
    // hosted here: generate from the router exactly as /openapi.json does
    const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
    for (const mod of this.kernel.registry.all()) {
      if (!mod.router) continue
      try {
        const spec = (await generator.generate(mod.router(this.kernel), {
          info: { title: mod.definition.name, version: mod.definition.version },
        })) as Record<string, unknown>
        sources.push({
          moduleId: mod.definition.id,
          baseUrl: '',
          basePath: `/api/${mod.definition.apiPrefix ?? mod.definition.id}`,
          spec,
        })
      } catch (err) {
        this.kernel.log.warn({ err, module: mod.definition.id }, 'mcp: failed to generate module spec')
      }
    }
    // hosted elsewhere: ask the service what it hosts, then read its documents
    await Promise.all(
      REMOTE_SERVICES.map(async (svc) => {
        const root = this.kernel.env[svc.urlKey]
        if (!root) return
        try {
          const res = await fetch(`${root}/api/health`, { signal: AbortSignal.timeout(3000) })
          if (!res.ok) return
          const health = (await res.json()) as { modules?: Array<{ id: string }> }
          for (const m of health.modules ?? []) {
            if (this.kernel.registry.has(m.id)) continue // generated locally above
            try {
              const specRes = await fetch(`${root}/api/${m.id}/openapi.json`, {
                signal: AbortSignal.timeout(3000),
              })
              if (!specRes.ok) continue
              const spec = (await specRes.json()) as {
                servers?: Array<{ url?: string }>
              } & Record<string, unknown>
              sources.push({
                moduleId: m.id,
                baseUrl: root,
                basePath: spec.servers?.[0]?.url ?? `/api/${m.id}`,
                spec,
              })
            } catch {
              // service briefly down → its tools vanish until the next refresh
            }
          }
        } catch {
          // same: an unreachable service contributes nothing rather than failing the request
        }
      }),
    )
    const tools = sources.flatMap((s) => toolsFromSpec(s))
    this.cache = { tools, exp: Date.now() + this.ttlMs }
    return tools
  }

  invalidate(): void {
    this.cache = null
  }
}

const slug = (s: string) =>
  s
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .toLowerCase()

function toolsFromSpec(source: SpecSource): McpToolDef[] {
  const paths = source.spec.paths as Record<string, Record<string, SpecOperation>> | undefined
  if (!paths) return []
  const out: McpToolDef[] = []
  const seen = new Set<string>()
  for (const [path, methods] of Object.entries(paths)) {
    for (const [methodRaw, op] of Object.entries(methods)) {
      const method = methodRaw.toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue
      const write = method !== 'GET'
      const opId = op.operationId || `${method}_${slug(path)}`
      let name = `${source.moduleId}_${slug(opId)}`
      while (seen.has(name)) name = `${name}_2`
      seen.add(name)

      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const p of op.parameters ?? []) {
        if (p.in !== 'path' && p.in !== 'query') continue
        properties[p.name] = { ...(p.schema ?? { type: 'string' }), description: p.description ?? undefined }
        if (p.required) required.push(p.name)
      }
      const body = op.requestBody?.content?.['application/json']?.schema
      if (body && typeof body === 'object') {
        const t = (body as { type?: string }).type
        // binary uploads have no place in a chat-completion tool call; skip the operation
        if (t !== 'object' && t) continue
        properties.data = { ...body, description: 'The JSON request body.' }
      }

      out.push({
        name,
        title: op.summary ?? `${method} ${path}`,
        description: [op.summary, op.description].filter(Boolean).join('\n\n') || `${method} ${path}`,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
        module: source.moduleId,
        write,
        method,
        template: `${source.basePath}${path}`,
        baseUrl: source.baseUrl,
      })
    }
  }
  return out
}

interface SpecOperation {
  operationId?: string
  summary?: string
  description?: string
  parameters?: Array<{
    name: string
    in: string
    description?: string
    required?: boolean
    schema?: Record<string, unknown>
  }>
  requestBody?: {
    content?: Record<string, { schema?: unknown }>
  }
}

/** True when the request carries an Authorization header at all (used to shape the 401 response). */
export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1]!.trim() : null
}
