import type { Kernel } from '@kernhq/kernel'
import nodemailer, { type Transporter } from 'nodemailer'
import type { CoreEnv } from '../env.js'
import type { EmailLocale } from './emails.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  /** the recipient's language — decides the copy, and travels as `Content-Language` */
  locale?: EmailLocale
  /** workspace whose outbound provider should be used (mail module) */
  workspaceId?: string | null
}
export interface Mailer {
  send(msg: MailMessage): Promise<void>
}

/**
 * Outbound mail for the core service (verification, magic links, invitations, digests).
 * Production: prefer the mail module (`mail.send` via kernel.call) when it is hosted somewhere; fall back to SMTP_URL.
 * Development: SMTP_URL (Mailpit). No SMTP_URL → log only.
 */
export function createMailer(kernel: Kernel, env: CoreEnv): Mailer {
  let transport: Transporter | null = null
  const smtp = () => {
    if (!env.SMTP_URL) return null
    transport ??= nodemailer.createTransport(env.SMTP_URL)
    return transport
  }
  const viaModule = async (msg: MailMessage) => {
    if (env.NODE_ENV !== 'production') return false
    if (!kernel.broker.has('mail.send') && !kernel.nats) return false
    try {
      // The mail contract's `SendMailInput`: `to` is a list, and instance-level mail *omits*
      // `workspaceId` rather than passing null. Both were wrong here, so every call failed
      // validation and every sign-in link went out through the SMTP fallback below — which on an
      // instance whose mail is configured per workspace in the mail module means it did not go.
      await kernel.call('mail.send', {
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(msg.locale ? { headers: { 'Content-Language': msg.locale } } : {}),
        ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}),
      })
      return true
    } catch (err) {
      kernel.log.warn(
        { err: (err as Error).message },
        'mail.send via mail module failed; falling back to SMTP',
      )
      return false
    }
  }
  return {
    async send(msg) {
      if (await viaModule(msg)) return
      const t = smtp()
      if (!t) {
        kernel.log.info({ to: msg.to, subject: msg.subject }, 'mail (no SMTP_URL configured – not sent)')
        return
      }
      await t.sendMail({
        from: env.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(msg.locale ? { headers: { 'Content-Language': msg.locale } } : {}),
      })
      kernel.log.debug({ to: msg.to, subject: msg.subject }, 'mail sent')
    },
  }
}
