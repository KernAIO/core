/**
 * Every email the core service sends, in every language Kern speaks.
 *
 * Kern ships five locales and a full right-to-left interface, and until this file existed every
 * message that left the building was English and left-to-right: an Arabic or Persian customer used
 * the product in their own language and was then told "Verify your Kern email" in a Latin-script
 * body laid out the wrong way round.
 *
 * Three rules hold the bundles together:
 *
 * - **The recipient's locale decides, never the sender's.** Better Auth hands the user row to its
 *   mail callbacks, an invitation falls back to the inviter and then to `KERN_DEFAULT_LOCALE`, and
 *   the digest reads the row it is mailing.
 * - **Numbers and plurals go through `Intl`**, so Persian and Arabic get their own digits and
 *   Arabic gets its six plural categories rather than an English one/other guess.
 * - **Direction is part of the message.** `ar` and `fa` set `dir="rtl"` on the document *and* the
 *   body, because a mail client renders raw HTML with no stylesheet of ours.
 *
 * `tr` is here even though `@kernhq/contracts`' `Locale` enum still stops at `de`: the shell speaks
 * Turkish, so a Turkish speaker exists and the bundle has to. `emailLocale()` accepts anything and
 * falls back, so widening the contract later needs no change here.
 */

/** Locales the shell ships message catalogues for — the set a recipient can actually be reading. */
export const EMAIL_LOCALES = ['en', 'ar', 'de', 'fa', 'tr'] as const
export type EmailLocale = (typeof EMAIL_LOCALES)[number]

export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en'

/** Scripts written right to left. The HTML has to say so; no mail client will work it out. */
export const isRtlLocale = (locale: EmailLocale): boolean => locale === 'ar' || locale === 'fa'

/**
 * Narrows anything a user row, a JWT or an environment variable can hold to a locale we have copy
 * for. `fa-IR` is Persian, `pt-BR` is not a language Kern speaks and becomes the fallback.
 */
export function emailLocale(
  raw: string | null | undefined,
  fallback: EmailLocale = DEFAULT_EMAIL_LOCALE,
): EmailLocale {
  const tag =
    String(raw ?? '')
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0] ?? ''
  return (EMAIL_LOCALES as readonly string[]).includes(tag) ? (tag as EmailLocale) : fallback
}

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type PluralForms = Partial<Record<PluralCategory, string>> & { other: string }

/** A count in the locale's own digits. */
const num = (locale: EmailLocale, n: number): string => new Intl.NumberFormat(locale).format(n)

/** Picks the plural form the locale actually uses, then substitutes `{n}` in the locale's digits. */
function plural(locale: EmailLocale, n: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(locale).select(n) as PluralCategory
  return (forms[category] ?? forms.other).replaceAll('{n}', num(locale, n))
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'guest'

/** One rendered message: what goes in the subject line and what goes in the body. */
export interface EmailCopy {
  subject: string
  title: string
  intro: string
  /** bullet list under the intro (the digest); each item is escaped, never HTML */
  lines?: string[]
  actionLabel: string
  footer?: string
}

export interface InvitationCopy {
  inviterName: string
  inviterEmail: string
  workspace: string
  role: MemberRole
  message: string | null
  expiresInDays: number
}

export interface DigestCopy {
  name: string
  items: string[]
}

interface Bundle {
  /** the line at the foot of every message */
  signature: string
  role: Record<MemberRole, string>
  verifyEmail(p: { name: string }): EmailCopy
  magicLink(p: { minutes: number }): EmailCopy
  resetPassword(p: { name: string }): EmailCopy
  invitation(p: InvitationCopy): EmailCopy
  digest(p: DigestCopy): EmailCopy
}

/** The quoted personal note an inviter may add, in the locale's own quotation marks. */
const quoted = (open: string, close: string, message: string | null): string =>
  message ? `\n\n${open}${message}${close}` : ''

const en: Bundle = {
  signature: 'Sent by Kern',
  role: { owner: 'an owner', admin: 'an admin', member: 'a member', guest: 'a guest' },
  verifyEmail: ({ name }) => ({
    subject: 'Verify your Kern email',
    title: 'Verify your email',
    intro: `Hi ${name}, please confirm your email address to finish setting up your Kern account.`,
    actionLabel: 'Verify email',
  }),
  magicLink: ({ minutes }) => ({
    subject: 'Your Kern sign-in link',
    title: 'Sign in to Kern',
    intro: plural('en', minutes, {
      one: 'Click the button below to sign in. This link expires in {n} minute and can only be used once.',
      other: 'Click the button below to sign in. This link expires in {n} minutes and can only be used once.',
    }),
    actionLabel: 'Sign in',
  }),
  resetPassword: ({ name }) => ({
    subject: 'Reset your Kern password',
    title: 'Reset your Kern password',
    intro: `Hi ${name}, click the button below to choose a new password. This link expires in one hour.`,
    actionLabel: 'Reset password',
  }),
  invitation: (p) => ({
    subject: `Invitation to join ${p.workspace} on Kern`,
    title: `${p.inviterName} invited you to ${p.workspace}`,
    intro: `${p.inviterName} (${p.inviterEmail}) invited you to join the “${p.workspace}” workspace on Kern as ${en.role[p.role]}.${quoted('“', '”', p.message)}`,
    actionLabel: 'Accept invitation',
    footer: plural('en', p.expiresInDays, {
      one: 'This invitation expires in {n} day.',
      other: 'This invitation expires in {n} days.',
    }),
  }),
  digest: ({ name, items }) => ({
    subject: `Kern: ${plural('en', items.length, { one: '{n} unread notification', other: '{n} unread notifications' })}`,
    title: 'While you were away',
    intro: `Hi ${name}, here is what happened while you were away.`,
    lines: items,
    actionLabel: 'Open your inbox',
  }),
}

const de: Bundle = {
  signature: 'Gesendet von Kern',
  role: { owner: 'Eigentümer', admin: 'Administrator', member: 'Mitglied', guest: 'Gast' },
  verifyEmail: ({ name }) => ({
    subject: 'Bestätige deine E-Mail-Adresse für Kern',
    title: 'E-Mail-Adresse bestätigen',
    intro: `Hallo ${name}, bestätige bitte deine E-Mail-Adresse, um dein Kern-Konto fertig einzurichten.`,
    actionLabel: 'E-Mail bestätigen',
  }),
  magicLink: ({ minutes }) => ({
    subject: 'Dein Anmeldelink für Kern',
    title: 'Bei Kern anmelden',
    intro: plural('de', minutes, {
      one: 'Klicke auf die Schaltfläche unten, um dich anzumelden. Der Link läuft in {n} Minute ab und funktioniert nur einmal.',
      other:
        'Klicke auf die Schaltfläche unten, um dich anzumelden. Der Link läuft in {n} Minuten ab und funktioniert nur einmal.',
    }),
    actionLabel: 'Anmelden',
  }),
  resetPassword: ({ name }) => ({
    subject: 'Setze dein Kern-Passwort zurück',
    title: 'Passwort zurücksetzen',
    intro: `Hallo ${name}, klicke auf die Schaltfläche unten, um ein neues Passwort zu wählen. Der Link läuft in einer Stunde ab.`,
    actionLabel: 'Passwort zurücksetzen',
  }),
  invitation: (p) => ({
    subject: `Einladung zu ${p.workspace} auf Kern`,
    title: `${p.inviterName} hat dich zu ${p.workspace} eingeladen`,
    intro: `${p.inviterName} (${p.inviterEmail}) hat dich eingeladen, dem Workspace „${p.workspace}“ auf Kern als ${de.role[p.role]} beizutreten.${quoted('„', '“', p.message)}`,
    actionLabel: 'Einladung annehmen',
    footer: plural('de', p.expiresInDays, {
      one: 'Diese Einladung läuft in {n} Tag ab.',
      other: 'Diese Einladung läuft in {n} Tagen ab.',
    }),
  }),
  digest: ({ name, items }) => ({
    subject: `Kern: ${plural('de', items.length, { one: '{n} ungelesene Benachrichtigung', other: '{n} ungelesene Benachrichtigungen' })}`,
    title: 'Während du weg warst',
    intro: `Hallo ${name}, das ist passiert, während du weg warst.`,
    lines: items,
    actionLabel: 'Posteingang öffnen',
  }),
}

const tr: Bundle = {
  signature: 'Kern tarafından gönderildi',
  role: { owner: 'sahip', admin: 'yönetici', member: 'üye', guest: 'misafir' },
  verifyEmail: ({ name }) => ({
    subject: 'Kern e-posta adresinizi doğrulayın',
    title: 'E-posta adresinizi doğrulayın',
    intro: `Merhaba ${name}, Kern hesabınızın kurulumunu tamamlamak için e-posta adresinizi doğrulayın.`,
    actionLabel: 'E-postayı doğrula',
  }),
  magicLink: ({ minutes }) => ({
    subject: 'Kern giriş bağlantınız',
    title: "Kern'e giriş yapın",
    intro: plural('tr', minutes, {
      other:
        'Giriş yapmak için aşağıdaki düğmeye tıklayın. Bu bağlantı {n} dakika sonra geçersiz olur ve yalnızca bir kez kullanılabilir.',
    }),
    actionLabel: 'Giriş yap',
  }),
  resetPassword: ({ name }) => ({
    subject: 'Kern parolanızı sıfırlayın',
    title: 'Parolanızı sıfırlayın',
    intro: `Merhaba ${name}, yeni bir parola seçmek için aşağıdaki düğmeye tıklayın. Bu bağlantı bir saat sonra geçersiz olur.`,
    actionLabel: 'Parolayı sıfırla',
  }),
  invitation: (p) => ({
    subject: `Kern'de ${p.workspace} çalışma alanına davet`,
    title: `${p.inviterName} sizi ${p.workspace} çalışma alanına davet etti`,
    intro: `${p.inviterName} (${p.inviterEmail}) sizi Kern'deki “${p.workspace}” çalışma alanına ${tr.role[p.role]} olarak katılmaya davet etti.${quoted('“', '”', p.message)}`,
    actionLabel: 'Daveti kabul et',
    footer: plural('tr', p.expiresInDays, { other: 'Bu davet {n} gün sonra geçersiz olur.' }),
  }),
  digest: ({ name, items }) => ({
    subject: `Kern: ${plural('tr', items.length, { other: '{n} okunmamış bildirim' })}`,
    title: 'Siz yokken',
    intro: `Merhaba ${name}, siz yokken olanlar.`,
    lines: items,
    actionLabel: 'Gelen kutusunu aç',
  }),
}

const fa: Bundle = {
  signature: 'ارسال‌شده از کرن',
  role: { owner: 'مالک', admin: 'مدیر', member: 'عضو', guest: 'مهمان' },
  verifyEmail: ({ name }) => ({
    subject: 'ایمیل خود را در کرن تأیید کنید',
    title: 'تأیید نشانی ایمیل',
    intro: `سلام ${name}، برای کامل‌کردن حساب خود در کرن، نشانی ایمیلتان را تأیید کنید.`,
    actionLabel: 'تأیید ایمیل',
  }),
  magicLink: ({ minutes }) => ({
    subject: 'پیوند ورود شما به کرن',
    title: 'ورود به کرن',
    intro: plural('fa', minutes, {
      other: 'برای ورود روی دکمهٔ زیر بزنید. این پیوند تا {n} دقیقه اعتبار دارد و فقط یک بار کار می‌کند.',
    }),
    actionLabel: 'ورود',
  }),
  resetPassword: ({ name }) => ({
    subject: 'بازنشانی گذرواژهٔ کرن',
    title: 'بازنشانی گذرواژه',
    intro: `سلام ${name}، برای انتخاب گذرواژهٔ جدید روی دکمهٔ زیر بزنید. این پیوند تا یک ساعت اعتبار دارد.`,
    actionLabel: 'بازنشانی گذرواژه',
  }),
  invitation: (p) => ({
    subject: `دعوت به ${p.workspace} در کرن`,
    title: `${p.inviterName} شما را به ${p.workspace} دعوت کرد`,
    intro: `${p.inviterName} (${p.inviterEmail}) شما را دعوت کرد تا با نقش ${fa.role[p.role]} به فضای کاری «${p.workspace}» در کرن بپیوندید.${quoted('«', '»', p.message)}`,
    actionLabel: 'پذیرش دعوت',
    footer: plural('fa', p.expiresInDays, { other: 'این دعوت تا {n} روز دیگر منقضی می‌شود.' }),
  }),
  digest: ({ name, items }) => ({
    subject: `کرن: ${plural('fa', items.length, { other: '{n} اعلان خوانده‌نشده' })}`,
    title: 'در نبود شما',
    intro: `سلام ${name}، آنچه در نبود شما رخ داد.`,
    lines: items,
    actionLabel: 'بازکردن صندوق پیام',
  }),
}

const ar: Bundle = {
  signature: 'أُرسلت من كيرن',
  role: { owner: 'مالك', admin: 'مدير', member: 'عضو', guest: 'ضيف' },
  verifyEmail: ({ name }) => ({
    subject: 'أكِّد بريدك الإلكتروني في كيرن',
    title: 'تأكيد البريد الإلكتروني',
    intro: `مرحباً ${name}، أكِّد بريدك الإلكتروني لإكمال إعداد حسابك في كيرن.`,
    actionLabel: 'تأكيد البريد',
  }),
  magicLink: ({ minutes }) => ({
    subject: 'رابط الدخول إلى كيرن',
    title: 'تسجيل الدخول إلى كيرن',
    intro: plural('ar', minutes, {
      one: 'اضغط الزر أدناه لتسجيل الدخول. ينتهي هذا الرابط خلال دقيقة واحدة ويعمل مرة واحدة فقط.',
      two: 'اضغط الزر أدناه لتسجيل الدخول. ينتهي هذا الرابط خلال دقيقتين ويعمل مرة واحدة فقط.',
      few: 'اضغط الزر أدناه لتسجيل الدخول. ينتهي هذا الرابط خلال {n} دقائق ويعمل مرة واحدة فقط.',
      many: 'اضغط الزر أدناه لتسجيل الدخول. ينتهي هذا الرابط خلال {n} دقيقة ويعمل مرة واحدة فقط.',
      other: 'اضغط الزر أدناه لتسجيل الدخول. ينتهي هذا الرابط خلال {n} دقيقة ويعمل مرة واحدة فقط.',
    }),
    actionLabel: 'تسجيل الدخول',
  }),
  resetPassword: ({ name }) => ({
    subject: 'إعادة تعيين كلمة مرورك في كيرن',
    title: 'إعادة تعيين كلمة المرور',
    intro: `مرحباً ${name}، اضغط الزر أدناه لاختيار كلمة مرور جديدة. ينتهي هذا الرابط خلال ساعة واحدة.`,
    actionLabel: 'إعادة تعيين كلمة المرور',
  }),
  invitation: (p) => ({
    subject: `دعوة للانضمام إلى ${p.workspace} في كيرن`,
    title: `دعاك ${p.inviterName} إلى ${p.workspace}`,
    intro: `دعاك ${p.inviterName} (${p.inviterEmail}) للانضمام إلى مساحة العمل «${p.workspace}» في كيرن بصفة ${ar.role[p.role]}.${quoted('«', '»', p.message)}`,
    actionLabel: 'قبول الدعوة',
    footer: plural('ar', p.expiresInDays, {
      one: 'تنتهي هذه الدعوة خلال يوم واحد.',
      two: 'تنتهي هذه الدعوة خلال يومين.',
      few: 'تنتهي هذه الدعوة خلال {n} أيام.',
      many: 'تنتهي هذه الدعوة خلال {n} يوماً.',
      other: 'تنتهي هذه الدعوة خلال {n} يوم.',
    }),
  }),
  digest: ({ name, items }) => ({
    subject: `كيرن: ${plural('ar', items.length, {
      zero: '{n} إشعار غير مقروء',
      one: 'إشعار واحد غير مقروء',
      two: 'إشعاران غير مقروءين',
      few: '{n} إشعارات غير مقروءة',
      many: '{n} إشعاراً غير مقروء',
      other: '{n} إشعار غير مقروء',
    })}`,
    title: 'في أثناء غيابك',
    intro: `مرحباً ${name}، هذا ما حدث في أثناء غيابك.`,
    lines: items,
    actionLabel: 'فتح صندوق الوارد',
  }),
}

const BUNDLES: Record<EmailLocale, Bundle> = { en, ar, de, fa, tr }

/** The copy for one locale. Anything outside `EMAIL_LOCALES` has already become the fallback. */
export const emailCopy = (locale: EmailLocale): Bundle => BUNDLES[locale]

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * The transactional template: one heading, one paragraph, an optional list, one button.
 *
 * `dir` is set on the `<html>` element **and** on the body: a mail client strips the document
 * around our markup often enough that only one of the two survives, and a Persian message laid out
 * left to right reads as broken software rather than as a styling detail.
 */
export function renderEmail(opts: {
  locale?: EmailLocale
  title: string
  intro: string
  lines?: string[]
  actionUrl?: string
  actionLabel?: string
  footer?: string
}): { html: string; text: string } {
  const locale = opts.locale ?? DEFAULT_EMAIL_LOCALE
  const dir = isRtlLocale(locale) ? 'rtl' : 'ltr'
  const align = dir === 'rtl' ? 'right' : 'left'
  const footer = opts.footer ?? emailCopy(locale).signature
  const list = opts.lines?.length
    ? `<ul style="padding-inline-start:20px;margin:16px 0">${opts.lines
        .map((line) => `<li style="margin:4px 0">${escapeHtml(line)}</li>`)
        .join('')}</ul>`
    : ''
  const btn = opts.actionUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.actionUrl)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(opts.actionLabel ?? 'Open')}</a></p><p style="color:#71717a;font-size:12px;direction:ltr;text-align:${align}">${escapeHtml(opts.actionUrl)}</p>`
    : ''
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body dir="${dir}" style="font-family:Inter,system-ui,sans-serif;color:#18181b;max-width:560px;margin:0 auto;padding:24px;direction:${dir};text-align:${align}"><h2 style="margin:0 0 12px">${escapeHtml(opts.title)}</h2><p style="white-space:pre-line">${escapeHtml(opts.intro)}</p>${list}${btn}<p style="color:#71717a;font-size:12px">${escapeHtml(footer)}</p></body></html>`
  const bullets = opts.lines?.length ? `\n${opts.lines.map((line) => `• ${line}`).join('\n')}\n` : ''
  const text = `${opts.title}\n\n${opts.intro}\n${bullets}${opts.actionUrl ? `\n${opts.actionUrl}\n` : ''}\n${footer}`
  return { html, text }
}

/** One `EmailCopy` turned into the fields `Mailer.send` wants. */
export function composeEmail(
  locale: EmailLocale,
  copy: EmailCopy,
  actionUrl?: string,
): { locale: EmailLocale; subject: string; text: string; html: string } {
  const { html, text } = renderEmail({
    locale,
    title: copy.title,
    intro: copy.intro,
    lines: copy.lines,
    actionUrl,
    actionLabel: copy.actionLabel,
    footer: copy.footer,
  })
  return { locale, subject: copy.subject, text, html }
}
