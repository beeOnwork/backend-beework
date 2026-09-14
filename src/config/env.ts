const required = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

const int = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) throw new Error(`Env var ${key} must be an integer`)
  return parsed
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: int('PORT', 3000),
  /** default loopback: yang menghadap publik harus reverse proxy, bukan app */
  host: process.env.HOST ?? '127.0.0.1',
  appName: process.env.APP_NAME ?? 'Beework',
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',

  databaseUrl: required('DATABASE_URL'),
  dbPoolMax: int('DB_POOL_MAX', 10),

  jwtSecret: required('JWT_SECRET'),
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshTtlDays: int('JWT_REFRESH_TTL_DAYS', 30),

  /** job runner (expire task, bersih-bersih) */
  jobsEnabled: (process.env.JOBS_ENABLED ?? 'true') !== 'false',
  jobsPollMs: int('JOBS_POLL_MS', 5000),
  /** setelah deadline, owner masih punya waktu ini untuk review sebelum task kedaluwarsa */
  taskReviewPeriodDays: int('TASK_REVIEW_PERIOD_DAYS', 7),

  /** basis poin: 500 = 5% */
  platformFeeBps: int('PLATFORM_FEE_BPS', 500),
  referralShareBps: int('REFERRAL_SHARE_BPS', 5000),
  defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'USDC',

  /** percaya X-Forwarded-For hanya dari loopback (nginx di mesin yang sama) */
  trustProxy: (process.env.TRUST_PROXY ?? 'true') !== 'false',
  rateLimitEnabled: (process.env.RATE_LIMIT_ENABLED ?? 'true') !== 'false',
  /** batas global per IP per menit, semua route */
  rateLimitGlobalMax: int('RATE_LIMIT_GLOBAL_PER_MIN', 300),

  /** captcha di pendaftaran; provider 'none' atau secret kosong = nonaktif */
  captcha: {
    provider: (process.env.CAPTCHA_PROVIDER ?? 'turnstile') as 'turnstile' | 'hcaptcha' | 'recaptcha' | 'none',
    siteKey: process.env.CAPTCHA_SITE_KEY ?? '',
    secret: process.env.CAPTCHA_SECRET ?? '',
    /** tolak token yang diselesaikan di domain lain (kosong = tidak dicek) */
    expectedHostname: process.env.CAPTCHA_EXPECTED_HOSTNAME ?? '',
    /** hanya reCAPTCHA v3 */
    minScore: Number(process.env.CAPTCHA_MIN_SCORE ?? '0.5'),
  },

  privyAppId: process.env.PRIVY_APP_ID ?? '',
  /** opsional: tanpa ini email & wallet tidak bisa diverifikasi ke Privy */
  privyAppSecret: process.env.PRIVY_APP_SECRET ?? '',

  /** GhostGraph (indexer hosted) sebagai sumber event kedua; kosong = nonaktif */
  ghost: {
    graphqlUrl: process.env.GHOST_GRAPHQL_URL ?? '',
    apiKey: process.env.GHOST_API_KEY ?? '',
    get enabled() {
      return Boolean(this.graphqlUrl)
    },
  },

  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? '',

  /** Kontrak BeeworkEscrow di satu EVM chain. Kosongkan EVM_ESCROW_ADDRESS untuk menonaktifkan. */
  evm: {
    chainId: int('EVM_CHAIN_ID', 10143),
    chainName: process.env.EVM_CHAIN_NAME ?? 'Monad Testnet',
    nativeSymbol: process.env.EVM_NATIVE_SYMBOL ?? 'MON',
    rpcUrl: process.env.EVM_RPC_URL ?? 'https://testnet-rpc.monad.xyz',
    escrowAddress: (process.env.EVM_ESCROW_ADDRESS ?? '') as `0x${string}` | '',
    /** hot wallet platform; alamatnya dipakai sebagai `reviewer` di fund(), kuncinya untuk award() */
    reviewerPrivateKey: (process.env.EVM_REVIEWER_PRIVATE_KEY ?? '') as `0x${string}` | '',
    indexerStartBlock: int('EVM_INDEXER_START_BLOCK', 0),
    /** polling getLogs lewat RPC; matikan kalau sepenuhnya mengandalkan Ghost */
    rpcIndexerEnabled: (process.env.EVM_INDEXER_ENABLED ?? 'true') !== 'false',
    indexerIntervalMs: int('EVM_INDEXER_INTERVAL_MS', 5000),
    /** RPC publik Monad membatasi getLogs ke 100 blok per panggilan */
    logsBlockSpan: int('EVM_LOGS_BLOCK_SPAN', 100),
    /** untuk membangun tautan tx di respons API */
    explorerUrl: (process.env.EVM_EXPLORER_URL ?? 'https://testnet.monadexplorer.com').replace(/\/$/, ''),
    /** berapa blok di belakang head yang dianggap final */
    confirmations: int('EVM_CONFIRMATIONS', 2),
    get enabled() {
      return Boolean(this.escrowAddress && this.reviewerPrivateKey)
    },
  },
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
} as const

if (env.isProd && env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production')
}

if (env.isProd && (env.captcha.provider === 'none' || !env.captcha.secret)) {
  console.warn('⚠️  Captcha pendaftaran nonaktif (CAPTCHA_SECRET kosong) — /auth/register hanya dilindungi rate limit.')
}

if (env.privyAppId && !env.privyAppSecret) {
  console.warn(
    '⚠️  PRIVY_APP_SECRET kosong — login Privy tetap jalan, tapi email dan alamat ' +
      'wallet tidak bisa diambil, jadi akun dibuat tanpa keduanya.',
  )
}
