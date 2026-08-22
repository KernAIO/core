import type { Kernel } from '@kernhq/kernel'
import type { FastifyInstance } from 'fastify'
import { toHeaders } from './auth/principal.js'
import type { CoreDeps } from './modules/core/deps.js'

/** Extra Fastify surface of the core service: Better Auth + API reference. */
export async function extendHttp(app: FastifyInstance, kernel: Kernel, deps: CoreDeps): Promise<void> {
  await mountBetterAuth(app, deps)
  mountApiDocs(app, kernel)
}

/**
 * Mounts Better Auth at /api/auth/* by translating Fastify requests into web `Request`s.
 * Registered as an encapsulated plugin so the raw-body content parser stays local to auth routes.
 */
async function mountBetterAuth(app: FastifyInstance, deps: CoreDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    scope.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/auth/*',
      handler: async (req, reply) => {
        const base = deps.env.BETTER_AUTH_URL ?? deps.kernel.env.CORE_URL
        const url = new URL(req.url, base)
        const hasBody =
          req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0
        const request = new Request(url, {
          method: req.method,
          headers: toHeaders(req),
          body: hasBody ? new Uint8Array(req.body as Buffer) : undefined,
        })
        const res = await deps.auth.handler(request)
        reply.status(res.status)
        res.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') reply.header(key, value)
        })
        for (const cookie of res.headers.getSetCookie()) reply.header('set-cookie', cookie)
        const body = res.body ? Buffer.from(await res.arrayBuffer()) : ''
        reply.send(body)
      },
    })
  })
}

/** Interactive API reference (Scalar) listing every hosted module's OpenAPI document. */
function mountApiDocs(app: FastifyInstance, kernel: Kernel): void {
  const sources = kernel.registry
    .all()
    .filter((m) => m.router)
    .map((m) => ({
      title: m.definition.name,
      url: `/api/${m.definition.apiPrefix ?? m.definition.id}/openapi.json`,
    }))
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kern API reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', ${JSON.stringify({ sources })})
    </script>
  </body>
</html>`
  app.get('/api/docs', async (_req, reply) => reply.type('text/html').send(html))
}
