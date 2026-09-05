/**
 * Kern ships five languages and a right-to-left interface, and every email it sent was English.
 *
 * These hold the three things that are easy to get wrong once and never notice: that a locale we
 * do not have copy for falls back rather than throwing, that Arabic and Persian mail is marked
 * right to left in the markup a mail client actually reads, and that a count is formatted by the
 * locale rather than by JavaScript's default.
 */
import { describe, expect, it } from 'vitest'
import {
  composeEmail,
  EMAIL_LOCALES,
  type EmailLocale,
  emailCopy,
  emailLocale,
  isRtlLocale,
  renderEmail,
} from './emails.js'

describe('email locales', () => {
  it('narrows anything a user row can hold', () => {
    expect(emailLocale('fa')).toBe('fa')
    expect(emailLocale('fa-IR')).toBe('fa')
    expect(emailLocale('DE_de')).toBe('de')
    expect(emailLocale('pt-BR')).toBe('en')
    expect(emailLocale(null)).toBe('en')
    expect(emailLocale(undefined)).toBe('en')
    expect(emailLocale('')).toBe('en')
    // an instance whose default is Turkish writes to strangers in Turkish
    expect(emailLocale(null, 'tr')).toBe('tr')
  })

  it('has copy for every locale the shell ships, in that locale', () => {
    for (const locale of EMAIL_LOCALES) {
      const bundle = emailCopy(locale)
      const messages = [
        bundle.verifyEmail({ name: 'Sara' }),
        bundle.magicLink({ minutes: 5 }),
        bundle.resetPassword({ name: 'Sara' }),
        bundle.invitation({
          inviterName: 'Ali',
          inviterEmail: 'ali@example.test',
          workspace: 'Acme',
          role: 'member',
          message: null,
          expiresInDays: 14,
        }),
        bundle.digest({ name: 'Sara', items: ['One thing happened'] }),
      ]
      for (const copy of messages) {
        expect(copy.subject.trim().length, `${locale} subject`).toBeGreaterThan(0)
        expect(copy.title.trim().length, `${locale} title`).toBeGreaterThan(0)
        expect(copy.intro.trim().length, `${locale} intro`).toBeGreaterThan(0)
        expect(copy.actionLabel.trim().length, `${locale} action`).toBeGreaterThan(0)
      }
      // Only English may read as English: a bundle copied and left untranslated is the failure
      // this catches, and it is the one nobody sees until a customer writes in.
      if (locale !== 'en')
        expect(messages.map((m) => m.subject).join(' '), `${locale} is still English`).not.toContain(
          'Verify your Kern email',
        )
    }
  })

  it('marks Arabic and Persian right to left, in the document and on the body', () => {
    for (const locale of ['ar', 'fa'] as EmailLocale[]) {
      expect(isRtlLocale(locale)).toBe(true)
      const { html } = renderEmail({ locale, title: 'ت', intro: 'ت', actionUrl: 'https://k.test/a' })
      expect(html).toContain(`<html lang="${locale}" dir="rtl">`)
      expect(html).toContain('<body dir="rtl"')
      expect(html).toContain('direction:rtl')
    }
    const { html } = renderEmail({ locale: 'de', title: 'T', intro: 'T' })
    expect(html).toContain('<html lang="de" dir="ltr">')
    expect(isRtlLocale('de')).toBe(false)
  })

  it('counts in the locale’s own digits and plural forms', () => {
    // Persian and Arabic-Indic digits, not 1234
    expect(emailCopy('fa').digest({ name: 'س', items: ['a', 'b', 'c'] }).subject).toContain('۳')
    expect(emailCopy('ar').digest({ name: 'س', items: ['a', 'b'] }).subject).toContain('إشعاران')
    // English keeps its one/other split, which the digest test in `notifications.test.ts` pins
    expect(emailCopy('en').digest({ name: 'S', items: ['a'] }).subject).toContain('1 unread notification')
    expect(emailCopy('en').digest({ name: 'S', items: ['a', 'b'] }).subject).toContain(
      '2 unread notifications',
    )
    expect(emailCopy('de').digest({ name: 'S', items: ['a', 'b'] }).subject).toContain(
      'ungelesene Benachrichtigungen',
    )
  })

  it('escapes what a person typed, in the body and in the link', () => {
    const { html } = renderEmail({
      locale: 'en',
      title: 'A <script>alert(1)</script> workspace',
      intro: 'Hi "you" & others',
      lines: ['<b>not bold</b>'],
      actionUrl: 'https://k.test/invite?a=1&b=2',
      actionLabel: 'Accept',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;')
    expect(html).toContain('https://k.test/invite?a=1&amp;b=2')
  })

  it('hands the mailer a subject, both bodies and the locale', () => {
    const copy = emailCopy('tr').verifyEmail({ name: 'Ayşe' })
    const msg = composeEmail('tr', copy, 'https://k.test/verify')
    expect(msg.locale).toBe('tr')
    expect(msg.subject).toBe(copy.subject)
    expect(msg.text).toContain('https://k.test/verify')
    expect(msg.html).toContain('lang="tr"')
  })
})
