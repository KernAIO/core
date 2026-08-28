import type { Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import { seedSignupPolicy } from './auth/signup.js'
import type { CoreDeps } from './modules/core/deps.js'
import { user } from './modules/core/schema/index.js'

/**
 * One-time instance initialisation, safe to run on every boot: seeds whether sign-up is open, then
 * creates the first instance admin from KERN_ADMIN_EMAIL / KERN_ADMIN_PASSWORD when no admin exists yet.
 */
export async function bootstrap(kernel: Kernel, deps: CoreDeps): Promise<void> {
  const { env } = deps
  const db = kernel.database.db
  // Before the admin is created, because creating it goes through the sign-up gate this seeds.
  await seedSignupPolicy(kernel, env)
  const [admin] = await db.select({ id: user.id }).from(user).where(eq(user.instanceAdmin, true)).limit(1)
  if (admin) return
  if (!env.KERN_ADMIN_EMAIL || !env.KERN_ADMIN_PASSWORD) {
    kernel.log.warn('no instance admin exists and KERN_ADMIN_EMAIL/KERN_ADMIN_PASSWORD are not set')
    return
  }
  const email = env.KERN_ADMIN_EMAIL.toLowerCase()
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
  if (!existing) {
    await deps.auth.api.signUpEmail({
      body: { email, password: env.KERN_ADMIN_PASSWORD, name: env.KERN_ADMIN_NAME },
    })
  }
  await db
    .update(user)
    .set({ instanceAdmin: true, role: 'admin', emailVerified: true, updatedAt: new Date() })
    .where(eq(user.email, email))
  kernel.log.info({ email }, existing ? 'promoted existing user to instance admin' : 'created instance admin')
}
