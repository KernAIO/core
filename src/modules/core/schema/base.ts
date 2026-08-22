import { pgSchema } from 'drizzle-orm/pg-core'

export const MODULE_ID = 'core'
export const SCHEMA_NAME = 'mod_core'
// equivalent to `moduleSchema('core')` from @kernaio/kernel – defined here so drizzle-kit (CJS) can load this file
export const coreSchema = pgSchema(SCHEMA_NAME)
