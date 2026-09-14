import { Elysia } from 'elysia'
import { TooManyRequests } from '../common/errors.ts'
import { env } from '../config/env.ts'
import { authPlugin, type AuthUser } from './auth.ts'

/**
 * Rate limit fixed-window. Satu proses = satu store; kalau nanti jalan lebih
 * dari satu instance, ganti `MemoryStore` dengan Redis (INCR + PEXPIRE) —
 * antarmukanya sengaja sekecil itu.
 */
export type RateLimitStore = {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
}

class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor() {
    // bersihkan jendela yang sudah lewat supaya map tidak tumbuh tanpa batas
    setInterval(() => {
      const now = Date.now()
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k)
    }, 60_000).unref()
  }

  async hit(key: string, windowMs: number) {
    const now = Date.now()
    const cur = this.buckets.get(key)
    if (!cur || cur.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs }
      this.buckets.set(key, fresh)
      return fresh
    }
    cur.count++
    return cur
  }
}

export const store: RateLimitStore = new MemoryStore()

/**
 * IP klien. Di belakang nginx, IP asli ada di X-Forwarded-For; header itu hanya
 * dipercaya kalau koneksi datang dari loopback (proxy kita sendiri) — kalau
 * tidak, siapa pun bisa memalsukan IP dan lolos dari limit.
 */
export const clientIp = (request: Request, socketIp: string | undefined): string => {
  const trusted = env.trustProxy && (socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1')
  if (trusted) {
    const xff = request.headers.get('x-forwarded-for')
    const first = xff?.split(',')[0]?.trim()
    if (first) return first
    const real = request.headers.get('x-real-ip')?.trim()
    if (real) return real
  }
  return socketIp ?? 'unknown'
}

export type RateLimitRule = {
  /** jumlah request yang diizinkan per jendela */
  max: number
  windowMs: number
  /**
   * ip      → per alamat IP (default)
   * user    → per user login; jatuh ke IP kalau belum login
   * fungsi  → kunci khusus, mis. gabungan IP + identifier login
   */
  key?: 'ip' | 'user' | ((ctx: { ip: string; user: AuthUser | null; body: unknown }) => string)
  /** nama bucket; default dari path supaya rule di route berbeda tidak saling makan */
  name?: string
}

type Verdict = { limited: boolean; limit: number; remaining: number; resetAt: number }

export const consume = async (bucket: string, rule: RateLimitRule): Promise<Verdict> => {
  const { count, resetAt } = await store.hit(bucket, rule.windowMs)
  return {
    limited: count > rule.max,
    limit: rule.max,
    remaining: Math.max(0, rule.max - count),
    resetAt,
  }
}

type Headers = Record<string, string>
const secondsUntil = (t: number) => String(Math.max(1, Math.ceil((t - Date.now()) / 1000)))

const applyHeaders = (headers: Headers, v: Verdict) => {
  headers['ratelimit-limit'] = String(v.limit)
  headers['ratelimit-remaining'] = String(v.remaining)
  headers['ratelimit-reset'] = secondsUntil(v.resetAt)
}

export const rateLimitPlugin = new Elysia({ name: 'rate-limit' })
  .use(authPlugin)
  .macro({
    /**
     * `{ rateLimit: { max: 5, windowMs: 15 * 60_000, key: 'ip' } }` per route,
     * atau array rule — semuanya harus lolos (mis. per IP dan per akun target).
     */
    rateLimit: (rules: RateLimitRule | RateLimitRule[]) => ({
      async beforeHandle({ request, server, set, currentUser, body, path }) {
        if (!env.rateLimitEnabled) return

        const ip = clientIp(request, server?.requestIP(request)?.address)
        const user = currentUser as AuthUser | null
        const headers = set.headers as Headers

        for (const [i, rule] of (Array.isArray(rules) ? rules : [rules]).entries()) {
          const keyFn = rule.key
          const subject =
            typeof keyFn === 'function'
              ? keyFn({ ip, user, body })
              : keyFn === 'user' && user
                ? `u:${user.id}`
                : `ip:${ip}`

          const verdict = await consume(`${rule.name ?? `${path}#${i}`}|${subject}`, rule)
          // header mencerminkan rule paling ketat yang tersisa
          const prev = Number(headers['ratelimit-remaining'] ?? Number.POSITIVE_INFINITY)
          if (verdict.remaining < prev) applyHeaders(headers, verdict)

          if (verdict.limited) {
            headers['retry-after'] = secondsUntil(verdict.resetAt)
            throw TooManyRequests(
              `Rate limit exceeded: ${rule.max} requests per ${Math.round(rule.windowMs / 1000)}s`,
            )
          }
        }
      },
    }),
  })

/** Batas global per IP untuk semua request, dipasang di onRequest (sebelum routing). */
export const globalRateLimit = async (
  request: Request,
  socketIp: string | undefined,
  headers: Headers,
) => {
  if (!env.rateLimitEnabled) return
  const ip = clientIp(request, socketIp)
  const verdict = await consume(`global|ip:${ip}`, {
    max: env.rateLimitGlobalMax,
    windowMs: 60_000,
  })
  if (verdict.limited) {
    applyHeaders(headers, verdict)
    headers['retry-after'] = secondsUntil(verdict.resetAt)
    throw TooManyRequests('Too many requests from this IP')
  }
}

// Preset yang dipakai lintas modul — angka ada di satu tempat.
const MIN = 60_000
export const limits = {
  /** pendaftaran: mahal (hash argon2) dan sasaran spam akun */
  register: { max: 5, windowMs: 15 * MIN, key: 'ip' } satisfies RateLimitRule,
  /** login: per IP DAN per akun target, supaya brute-force dari banyak IP juga kena */
  login: [
    { max: 20, windowMs: 15 * MIN, key: 'ip' },
    {
      max: 10,
      windowMs: 15 * MIN,
      key: ({ body }) =>
        `id:${(body as { identifier?: string } | null)?.identifier?.toLowerCase().trim() ?? ''}`,
    },
  ] satisfies RateLimitRule[],
  refresh: { max: 30, windowMs: MIN, key: 'ip' } satisfies RateLimitRule,
  privy: { max: 10, windowMs: MIN, key: 'ip' } satisfies RateLimitRule,
  walletChallenge: { max: 10, windowMs: 10 * MIN, key: 'user' } satisfies RateLimitRule,
  walletVerify: { max: 20, windowMs: 10 * MIN, key: 'user' } satisfies RateLimitRule,
  createTask: { max: 30, windowMs: 60 * MIN, key: 'user' } satisfies RateLimitRule,
  submit: { max: 60, windowMs: 60 * MIN, key: 'user' } satisfies RateLimitRule,
  payout: { max: 10, windowMs: 60 * MIN, key: 'user' } satisfies RateLimitRule,
} as const
