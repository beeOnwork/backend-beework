const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford-ish, tanpa i/l/o/u

/** ID pendek untuk URL publik & kode referral. */
export const shortId = (length = 10): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

/** Token rahasia (private task link, claim tip, reset password). */
export const secretToken = (bytes = 32): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

export const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Buffer.from(digest).toString('hex')
}

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 64)
