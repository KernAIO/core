import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations for the core module's own Postgres schema. Run: pnpm db:generate
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/core/schema/index.ts',
  out: './migrations',
  schemaFilter: ['mod_core'],
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern' },
})
