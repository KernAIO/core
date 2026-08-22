import { createCoreService } from './service.js'

const svc = await createCoreService({ role: 'worker' })
const { kernel } = svc
kernel.log.info('core worker running (pg-boss)')

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
