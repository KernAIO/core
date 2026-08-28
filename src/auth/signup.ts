/**
 * Whether this instance lets a stranger turn an email address into an account.
 *
 * `allowSignup` has been in `InstanceSettings` — and in the administration docs, as "open sign-up vs
 * invite-only" — since the beginning, and until this file nothing read it: a grep for `allowSignup`
 * across the whole service returned the contract and nothing else. So every internet-facing Kern was
 * an open multi-tenant SaaS whose admin switch changed nothing, which is worse than having no switch
 * at all, because an administrator turned it off and believed it.
 *
 * Enforced at exactly one seam, and that is the point of choosing this one: Better Auth's
 * `user.validateUserInfo` runs immediately before `create-user` for **every** authentication method
 * — email+password, social OAuth, magic link, SSO (OIDC and SAML), email OTP, SIWE, phone, and the
 * admin plugin — because every one of them provisions through `internalAdapter.createUser`. Gating
 * the sign-up *routes* instead would have meant a list of paths to keep in step with the plugin set,
 * and passkey/OAuth would have been missed the first time somebody added a provider.
 */
import type { Kernel } from '@kernhq/kernel'
import { and, eq, gt } from 'drizzle-orm'
import type { CoreEnv } from '../env.js'
import { invitations, user } from '../modules/core/schema/index.js'
import {
  getInstanceSettings,
  INSTANCE_KEY,
  instanceSettingsWritten,
  setInstanceSetting,
} from '../modules/core/services/admin.js'

/** Machine-readable code on the 403 a refused sign-up produces. */
export const SIGNUP_CLOSED = 'signup_closed'

export interface SignupVerdict {
  ok: boolean
  /** set when `ok` is false */
  code?: string
  message?: string
}

const ALLOWED: SignupVerdict = { ok: true }

/**
 * May `email` become an account on this instance right now?
 *
 * Open sign-up says yes to everything. Invite-only says yes to three cases, and they are the whole
 * reason "closed" does not mean "bricked":
 *
 * - **an invitation.** A pending, unexpired invitation addressed to this address is a member of the
 *   instance asking for this person by name. Refusing it would make invite-only mean "nobody new,
 *   ever", and would break the invitation flow the product is built around — a new invitee has no
 *   account yet and must create one before they can accept.
 * - **the bootstrap admin**, while no instance admin exists. `bootstrap()` creates the first
 *   administrator through this same Better Auth API, so a closed instance would refuse to create
 *   its own first user and never finish booting into a usable state.
 * - **an administrator creating the account by hand** (`method: 'admin'`). That endpoint has its own
 *   admin check; this gate is about strangers, not about operators.
 */
export async function mayCreateAccount(
  kernel: Kernel,
  env: CoreEnv,
  email: string,
  method: string,
): Promise<SignupVerdict> {
  const address = email.trim().toLowerCase()
  if (method === 'admin') return ALLOWED
  const settings = await getInstanceSettings(kernel)
  if (settings.allowSignup) return ALLOWED
  if (address && (await hasPendingInvitation(kernel, address))) return ALLOWED
  if (address && (await isBootstrapAdmin(kernel, env, address))) return ALLOWED
  return {
    ok: false,
    code: SIGNUP_CLOSED,
    message: 'This Kern instance is invite-only. Ask an administrator for an invitation.',
  }
}

async function hasPendingInvitation(kernel: Kernel, email: string): Promise<boolean> {
  const [row] = await kernel.database.db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return Boolean(row)
}

async function isBootstrapAdmin(kernel: Kernel, env: CoreEnv, email: string): Promise<boolean> {
  if (env.KERN_ADMIN_EMAIL?.toLowerCase() !== email) return false
  const [admin] = await kernel.database.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.instanceAdmin, true))
    .limit(1)
  return !admin
}

/**
 * Write `allowSignup` once, on the boot that finds no settings row at all.
 *
 * The contract's default is `true`, which is right for **Kern Cloud** — an instance whose whole
 * business is strangers signing up — and wrong for **a self-hosted instance**, which is usually one
 * company's and has no reason to accept an account from the internet. A shipped default cannot be
 * both, so the instance decides at first boot and an administrator owns it from then on: this never
 * touches a row that already exists, so changing `KERN_SIGNUP` later does nothing and the admin
 * console is the only thing that moves the switch.
 *
 * - `KERN_SIGNUP=open` — anyone may sign up. **Kern Cloud sets this.**
 * - `KERN_SIGNUP=invite` — invitation or administrator only.
 * - unset — invite-only *when this instance can bootstrap an administrator*
 *   (`KERN_ADMIN_EMAIL` + `KERN_ADMIN_PASSWORD` are set), and open otherwise. Closing an instance
 *   that has no way to create its first account leaves nobody able to sign in at all, which is a
 *   worse failure than an open one and is not recoverable through the product.
 */
export async function seedSignupPolicy(kernel: Kernel, env: CoreEnv): Promise<void> {
  if (await instanceSettingsWritten(kernel)) return
  const canBootstrapAdmin = Boolean(env.KERN_ADMIN_EMAIL && env.KERN_ADMIN_PASSWORD)
  const allowSignup = env.KERN_SIGNUP ? env.KERN_SIGNUP === 'open' : !canBootstrapAdmin
  const settings = await getInstanceSettings(kernel)
  await setInstanceSetting(kernel, INSTANCE_KEY, { ...settings, allowSignup })
  kernel.log.info(
    { allowSignup, source: env.KERN_SIGNUP ? 'KERN_SIGNUP' : 'default' },
    allowSignup ? 'sign-up is open on this instance' : 'sign-up is invite-only on this instance',
  )
}
