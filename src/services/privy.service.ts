import { createRemoteJWKSet, jwtVerify } from 'jose'
import { Unauthorized } from '../common/errors.ts'
import { env } from '../config/env.ts'

/**
 * Privy menerbitkan dua token berbeda:
 *  - `token`              → aud = app id kita. Ini bukti identitas untuk backend kita.
 *  - `privy_access_token` → aud = https://auth.privy.io. Itu untuk API Privy, bukan kita.
 * Hanya yang pertama yang diterima di sini.
 */
const PRIVY_ISSUER = 'privy.io'
const PRIVY_API = 'https://auth.privy.io/api/v1'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

const getJwks = () => {
  if (!env.privyAppId) throw new Error('PRIVY_APP_ID is not configured')
  // createRemoteJWKSet meng-cache kunci dan menarik ulang saat kid tidak dikenal.
  jwks ??= createRemoteJWKSet(new URL(`${PRIVY_API}/apps/${env.privyAppId}/jwks.json`))
  return jwks
}

export type PrivyClaims = {
  /** did:privy:... — identitas kanonik user di Privy */
  did: string
  sessionId?: string
  expiresAt: Date
}

export const verifyPrivyToken = async (token: string): Promise<PrivyClaims> => {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: PRIVY_ISSUER,
      audience: env.privyAppId,
      algorithms: ['ES256'],
    })

    if (!payload.sub?.startsWith('did:privy:')) throw new Error('Unexpected subject')

    return {
      did: payload.sub,
      sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    }
  } catch (error) {
    throw Unauthorized(`Invalid Privy token: ${describe(token, error as Error)}`)
  }
}

/**
 * Kesalahan paling sering: mengirim `privy_access_token` (aud = auth.privy.io)
 * padahal yang diminta `token` (aud = app id). Sebutkan langsung, jangan biarkan
 * pemanggil menebak dari pesan "unexpected aud claim value".
 */
const describe = (token: string, error: Error): string => {
  try {
    const [, rawPayload] = token.split('.')
    if (rawPayload) {
      const claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString()) as {
        aud?: string
        att?: string
      }
      if (claims.aud === 'https://auth.privy.io' || claims.att === 'pat')
        return 'kamu mengirim `privy_access_token`. Yang dibutuhkan adalah field `token` dari respons login Privy (aud = app id), atau hasil getAccessToken() dari SDK Privy.'
    }
  } catch {
    // token tidak bisa dibaca sama sekali — pakai pesan aslinya
  }
  return error.message
}

export type PrivyLinkedAccount = {
  type: string
  address?: string
  chain_type?: string
  wallet_client_type?: string
  wallet_index?: number
  verified_at?: number
}

export type PrivyProfile = {
  id: string
  linkedAccounts: PrivyLinkedAccount[]
  email?: string
  solanaWallets: { address: string; embedded: boolean }[]
}

/**
 * Ambil profil lengkap dari Privy. Email dan alamat wallet TIDAK boleh diambil
 * dari payload yang dikirim klien — hanya dari sini, karena inilah satu-satunya
 * sumber yang tidak bisa dipalsukan pemilik token.
 *
 * Mengembalikan null kalau app secret belum dikonfigurasi.
 */
export const fetchPrivyProfile = async (did: string): Promise<PrivyProfile | null> => {
  if (!env.privyAppId || !env.privyAppSecret) return null

  const res = await fetch(`${PRIVY_API}/users/${encodeURIComponent(did)}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${env.privyAppId}:${env.privyAppSecret}`).toString('base64')}`,
      'privy-app-id': env.privyAppId,
    },
  })

  if (!res.ok) {
    console.error(`[privy] gagal mengambil profil ${did}: ${res.status} ${await res.text()}`)
    return null
  }

  const data = (await res.json()) as { id: string; linked_accounts?: PrivyLinkedAccount[] }
  const accounts = data.linked_accounts ?? []

  return {
    id: data.id,
    linkedAccounts: accounts,
    email: accounts.find((a) => a.type === 'email' && a.address)?.address,
    solanaWallets: accounts
      .filter((a) => a.type === 'wallet' && a.chain_type === 'solana' && a.address)
      .map((a) => ({ address: a.address!, embedded: a.wallet_client_type === 'privy' })),
  }
}
