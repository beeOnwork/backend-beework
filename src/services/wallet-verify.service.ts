import { ed25519 } from '@noble/curves/ed25519.js'
import { base58, base64 } from '@scure/base'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getAddress, isAddress, verifyMessage as verifyEvmSignature } from 'viem'
import { BadRequest, Conflict, TooManyRequests, Unauthorized } from '../common/errors.ts'
import { secretToken, sha256 } from '../common/ids.ts'
import { env } from '../config/env.ts'
import { db } from '../db/index.ts'
import { authChallenges, EVM_CHAINS, wallets } from '../db/schema/index.ts'
import { getPublicClient } from './evm/client.ts'

const PURPOSE = 'wallet_verify'
const CHALLENGE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5

export type WalletChain = (typeof wallets.$inferSelect)['chain']

const isEvm = (chain: WalletChain) => (EVM_CHAINS as readonly string[]).includes(chain)

/** Normalisasi alamat: EVM → checksum EIP-55, Solana → validasi base58 32 byte. */
export const normalizeAddress = (chain: WalletChain, address: string): string => {
  if (isEvm(chain)) {
    if (!isAddress(address)) throw BadRequest('Invalid EVM address')
    return getAddress(address)
  }
  if (chain === 'solana') {
    let bytes: Uint8Array
    try {
      bytes = base58.decode(address)
    } catch {
      throw BadRequest('Invalid Solana address (not base58)')
    }
    if (bytes.length !== 32) throw BadRequest('Invalid Solana address (must decode to 32 bytes)')
    return address
  }
  throw BadRequest(`Wallet verification is not supported for chain ${chain}`)
}

/**
 * Pesan yang harus ditandatangani. Deterministik dari (chain, alamat, user, nonce)
 * supaya server bisa membangunnya ulang tanpa menyimpan teksnya, dan terikat ke
 * user + domain supaya tanda tangan tidak bisa dipakai ulang di akun/aplikasi lain.
 */
export const buildMessage = (params: {
  chain: WalletChain
  address: string
  userId: string
  nonce: string
}) =>
  [
    `${env.appName} — verifikasi kepemilikan wallet`,
    '',
    `Dengan menandatangani pesan ini kamu menautkan wallet di bawah ke akunmu.`,
    `Tidak ada transaksi yang dikirim dan tidak ada biaya.`,
    '',
    `Domain: ${new URL(env.appUrl).host}`,
    `Chain: ${params.chain}`,
    `Alamat: ${params.address}`,
    `User: ${params.userId}`,
    `Nonce: ${params.nonce}`,
  ].join('\n')

const identifierFor = (chain: WalletChain, address: string) => `${chain}:${address.toLowerCase()}`

export const createChallenge = async (userId: string, chain: WalletChain, rawAddress: string) => {
  const address = normalizeAddress(chain, rawAddress)

  const [taken] = await db
    .select({ userId: wallets.userId })
    .from(wallets)
    .where(and(eq(wallets.chain, chain), eq(wallets.address, address)))
    .limit(1)
  if (taken && taken.userId !== userId) throw Conflict('This wallet is linked to another account')

  const nonce = secretToken(16)
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)

  // Satu challenge aktif per (user, wallet): yang lama dibuang supaya tidak bisa
  // dipakai bergantian.
  await db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authChallenges.purpose, PURPOSE),
        eq(authChallenges.userId, userId),
        eq(authChallenges.identifier, identifierFor(chain, address)),
        isNull(authChallenges.consumedAt),
      ),
    )

  await db.insert(authChallenges).values({
    userId,
    purpose: PURPOSE,
    identifier: identifierFor(chain, address),
    secretHash: await sha256(nonce),
    expiresAt,
  })

  return {
    chain,
    address,
    nonce,
    message: buildMessage({ chain, address, userId, nonce }),
    expiresAt,
    howToSign: isEvm(chain)
      ? 'EIP-191 personal_sign (wallet.signMessage) → kirim signature hex 0x…'
      : 'wallet.signMessage(new TextEncoder().encode(message)) → kirim signature base58 (atau base64)',
  }
}

/** Solana: tanda tangan 64 byte, diterima dalam base58 (konvensi) atau base64. */
const decodeSolanaSignature = (signature: string): Uint8Array => {
  for (const decode of [base58.decode, base64.decode]) {
    try {
      const bytes = decode(signature)
      if (bytes.length === 64) return bytes
    } catch {
      // coba format berikutnya
    }
  }
  throw BadRequest('Solana signature must be 64 bytes in base58 or base64')
}

const verifySignature = async (
  chain: WalletChain,
  address: string,
  message: string,
  signature: string,
): Promise<boolean> => {
  if (isEvm(chain)) {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw BadRequest('EVM signature must be hex')
    const sig = signature as `0x${string}`
    const addr = address as `0x${string}`
    // Lewat RPC bila tersedia supaya smart-contract wallet (ERC-1271) ikut terverifikasi;
    // tanpa RPC hanya EOA (ecrecover murni) yang bisa dicek.
    if (env.evm.enabled) {
      return getPublicClient().verifyMessage({ address: addr, message, signature: sig })
    }
    return verifyEvmSignature({ address: addr, message, signature: sig })
  }
  if (chain === 'solana') {
    return ed25519.verify(
      decodeSolanaSignature(signature),
      new TextEncoder().encode(message),
      base58.decode(address),
    )
  }
  return false
}

/**
 * Verifikasi tanda tangan atas challenge yang masih hidup, lalu tautkan wallet
 * sebagai terverifikasi. Challenge dikonsumsi baik saat sukses maupun setelah
 * terlalu banyak percobaan gagal.
 */
export const verifyAndLinkWallet = async (params: {
  userId: string
  chain: WalletChain
  address: string
  nonce: string
  signature: string
  label?: string
  isPrimary?: boolean
}) => {
  const address = normalizeAddress(params.chain, params.address)
  const identifier = identifierFor(params.chain, address)

  const [challenge] = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.purpose, PURPOSE),
        eq(authChallenges.userId, params.userId),
        eq(authChallenges.identifier, identifier),
        eq(authChallenges.secretHash, await sha256(params.nonce)),
        isNull(authChallenges.consumedAt),
      ),
    )
    .limit(1)

  if (!challenge) throw Unauthorized('No active challenge for this wallet; request a new one')
  if (challenge.expiresAt < new Date()) throw Unauthorized('Challenge expired; request a new one')
  if (challenge.attempts >= MAX_ATTEMPTS) throw TooManyRequests('Too many failed attempts; request a new challenge')

  const message = buildMessage({ chain: params.chain, address, userId: params.userId, nonce: params.nonce })
  const ok = await verifySignature(params.chain, address, message, params.signature).catch(() => false)

  if (!ok) {
    const [row] = await db
      .update(authChallenges)
      .set({ attempts: sql`${authChallenges.attempts} + 1` })
      .where(eq(authChallenges.id, challenge.id))
      .returning({ attempts: authChallenges.attempts })
    if ((row?.attempts ?? 0) >= MAX_ATTEMPTS)
      await db.update(authChallenges).set({ consumedAt: new Date() }).where(eq(authChallenges.id, challenge.id))
    throw Unauthorized('Signature does not match the wallet address')
  }

  return db.transaction(async (tx) => {
    await tx.update(authChallenges).set({ consumedAt: new Date() }).where(eq(authChallenges.id, challenge.id))

    if (params.isPrimary) {
      await tx
        .update(wallets)
        .set({ isPrimary: false })
        .where(and(eq(wallets.userId, params.userId), eq(wallets.chain, params.chain)))
    }

    const [existingPrimary] = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.userId, params.userId), eq(wallets.chain, params.chain), eq(wallets.isPrimary, true)))
      .limit(1)

    const [wallet] = await tx
      .insert(wallets)
      .values({
        userId: params.userId,
        chain: params.chain,
        address,
        label: params.label ?? null,
        isPrimary: params.isPrimary ?? !existingPrimary,
        verifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [wallets.chain, wallets.address],
        // alamat sudah ada untuk user yang sama → tandai terverifikasi
        set: { verifiedAt: new Date(), label: params.label ?? sql`${wallets.label}` },
        setWhere: eq(wallets.userId, params.userId),
      })
      .returning()

    if (!wallet) throw Conflict('This wallet is linked to another account')
    return wallet
  })
}
