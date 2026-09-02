import { createServer } from 'node:http'
import { createCoreService } from './service.js'

const svc = await createCoreService({ role: 'worker' })
const { kernel } = svc
kernel.log.info('core worker running (pg-boss)')

// The image's HEALTHCHECK probes /api/health on PORT, whichever entrypoint runs — so a worker that
// served nothing was "unhealthy" for as long as it lived (1262 failed probes on the cloud before
// anyone read the count), and a `depends_on: service_healthy` on it would never be satisfied.
// This answers the probe honestly: the process is up and its queue connection is the one the
// health reflects. It is not an API; nothing else is routed here.
const health = createServer((req, res) => {
  if (req.url === '/api/health' || req.url === '/api/ready') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'core-worker', version: kernel.version }))
    return
  }
  res.writeHead(404).end()
})
health.listen(kernel.env.PORT, kernel.env.HOST)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  kernel.log.info({ signal }, 'shutting down')
  const timer = setTimeout(() => process.exit(1), 15_000)
  timer.unref()
  try {
    await svc.stop()
    process.exit(0)
  } catch (err) {
    kernel.log.error({ err }, 'shutdown failed')
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
