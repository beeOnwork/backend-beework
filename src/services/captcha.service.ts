import { AppError } from '../common/errors.ts'
import { env } from '../config/env.ts'

/**
 * Verifikasi captcha server-side. Turnstile, hCaptcha, dan reCAPTCHA memakai
 * kontrak siteverify yang sama (POST form `secret`+`response`, balasan
 * `{ success, ... }`), jadi satu implementasi untuk ketiganya.
 */
const ENDPOINTS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
} as const

export type CaptchaProvider = keyof typeof ENDPOINTS | 'none'

type SiteVerifyResponse = {
  success: boolean
  hostname?: string
  action?: string
  score?: number
  'error-codes'?: string[]
}

export const captchaEnabled = () => env.captcha.provider !== 'none' && Boolean(env.captcha.secret)

/** Info publik untuk frontend merender widget. */
export const captchaConfig = () => ({
  enabled: captchaEnabled(),
  provider: captchaEnabled() ? env.captcha.provider : null,
  siteKey: captchaEnabled() ? env.captcha.siteKey || null : null,
})

export const CaptchaRequired = () =>
  new AppError(400, 'CAPTCHA_REQUIRED', 'captchaToken is required', captchaConfig())
export const CaptchaFailed = (codes?: string[]) =>
  new AppError(403, 'CAPTCHA_FAILED', 'Captcha verification failed', codes?.length ? { codes } : undefined)

/**
 * Lempar AppError kalau token kosong/tidak sah. Tanpa konfigurasi → lolos
 * (dengan peringatan saat startup), supaya dev lokal tidak perlu kunci.
 */
export const verifyCaptcha = async (
  token: string | undefined,
  opts: { remoteIp?: string; action?: string } = {},
) => {
  if (!captchaEnabled()) return

  if (!token) throw CaptchaRequired()

  const body = new URLSearchParams({ secret: env.captcha.secret, response: token })
  if (opts.remoteIp) body.set('remoteip', opts.remoteIp)

  let result: SiteVerifyResponse
  try {
    const res = await fetch(ENDPOINTS[env.captcha.provider as keyof typeof ENDPOINTS], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8_000),
    })
    result = (await res.json()) as SiteVerifyResponse
  } catch (error) {
    // Provider tidak bisa dihubungi. Gagal tertutup: pendaftaran tanpa captcha
    // lebih berbahaya daripada pendaftaran tertunda beberapa menit.
    console.error('[captcha] siteverify tidak terjangkau:', (error as Error).message)
    throw new AppError(503, 'CAPTCHA_UNAVAILABLE', 'Captcha service unavailable, try again shortly')
  }

  if (!result.success) throw CaptchaFailed(result['error-codes'])

  // Token dari domain lain (widget disalin ke situs phishing) ditolak.
  if (env.captcha.expectedHostname && result.hostname && result.hostname !== env.captcha.expectedHostname)
    throw CaptchaFailed([`hostname-mismatch:${result.hostname}`])

  if (opts.action && result.action && result.action !== opts.action)
    throw CaptchaFailed([`action-mismatch:${result.action}`])

  // reCAPTCHA v3 memberi skor 0..1; provider lain tidak mengisi field ini.
  if (typeof result.score === 'number' && result.score < env.captcha.minScore)
    throw CaptchaFailed([`low-score:${result.score}`])
}
