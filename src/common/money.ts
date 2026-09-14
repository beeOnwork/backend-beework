/**
 * Aritmetika nominal memakai BigInt di atas string base-unit.
 * Tidak pernah pakai Number untuk uang.
 */
export const toBig = (v: string | bigint | number): bigint => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('Amount must be an integer in base units')
    return BigInt(v)
  }
  return BigInt(v)
}

export const add = (a: string | bigint, b: string | bigint) => (toBig(a) + toBig(b)).toString()
export const sub = (a: string | bigint, b: string | bigint) => (toBig(a) - toBig(b)).toString()

/** Ambil `bps` basis poin dari `amount`, dibulatkan ke bawah. */
export const bps = (amount: string | bigint, basisPoints: number) =>
  ((toBig(amount) * BigInt(basisPoints)) / 10_000n).toString()

export const isPositive = (v: string | bigint) => toBig(v) > 0n
export const gte = (a: string | bigint, b: string | bigint) => toBig(a) >= toBig(b)

/** Format ke tampilan manusia: ('1500000', 6) -> '1.5' */
export const format = (amount: string | bigint, decimals: number): string => {
  const value = toBig(amount)
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** Parse input manusia ke base unit: ('1.5', 6) -> '1500000' */
export const parse = (input: string, decimals: number): string => {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: ${input}`)
  const [whole = '0', frac = ''] = trimmed.split('.')
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`)
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString()
}

/**
 * Konversi nominal token ke sen USD untuk statistik (leaderboard, poin season).
 * Tetap integer — tidak dipakai untuk memindahkan dana, hanya untuk pelaporan.
 */
export const usdCents = (
  amount: string | bigint,
  decimals: number,
  priceUsd: string | null,
): string => {
  if (!priceUsd) return '0'
  const priceScaled = BigInt(Math.round(Number(priceUsd) * 1e6))
  const denominator = 10n ** BigInt(decimals) * 10_000n
  return ((toBig(amount) * priceScaled) / denominator).toString()
}
