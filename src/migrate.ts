import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, createLogger } from '@kernaio/kernel'
import './env.js'

// Standalone migration runner (`pnpm db:migrate`). The service also migrates at boot;
// this exists for CI/CD pipelines that migrate before rolling out.
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const log = createLogger('core-migrate')
const database = createDatabase({ url, log })
await database.migrateModule('core', join(dirname(fileURLToPath(import.meta.url)), '../migrations'))
await database.close()
log.info('migrations complete')
