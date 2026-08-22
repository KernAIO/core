/**
 * Loads `.env` files (repo-local first, then the umbrella dev workspace `../../.env`) outside production and
 * validates core-specific environment variables. Kernel-level variables are validated by `@kernalo/kernel`.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

if (process.env.NODE_ENV !== 'production') {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/env.ts → ../.env ; dist/env.js → ../.env (repo root). Umbrella workspace root is two levels up.
  loadDotenv({ path: resolve(here, '../.env'), quiet: true })
  loadDotenv({ path: resolve(here, '../../../.env'), quiet: true })
}

export const CoreEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Better Auth secret (falls back to KERN_SECRET) */
  BETTER_AUTH_SECRET: z.string().min(16).optional(),
  /** public URL of this service as seen by browsers (cookies, OAuth callbacks). Defaults to CORE_URL. */
  BETTER_AUTH_URL: z.string().url().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Kern <no-reply@localhost>'),
  KERN_ADMIN_EMAIL: z.string().email().optional(),
  KERN_ADMIN_PASSWORD: z.string().min(8).optional(),
  KERN_ADMIN_NAME: z.string().default('Admin'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  /** passkey relying party id (defaults to the hostname of KERN_BASE_URL) */
  PASSKEY_RP_ID: z.string().optional(),
  /** max single-PUT upload size before clients should use tus (bytes) */
  UPLOAD_MAX_PUT_BYTES: z.coerce
    .number()
    .int()
    .default(500 * 1024 * 1024),
})
export type CoreEnv = z.infer<typeof CoreEnv>

export function loadCoreEnv(extra: Record<string, string | undefined> = {}): CoreEnv {
  const parsed = CoreEnv.safeParse({ ...process.env, ...extra })
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid core environment:\n${issues}`)
  }
  return parsed.data
}
