import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '../../config/env.ts'

/**
 * Satu chain EVM per instance backend. Definisi diambil dari env supaya
 * pindah Monad testnet → mainnet, atau ke Base, cukup ganti .env.
 */
export const evmChain = defineChain({
  id: env.evm.chainId,
  name: env.evm.chainName,
  nativeCurrency: { name: env.evm.nativeSymbol, symbol: env.evm.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [env.evm.rpcUrl] } },
})

let publicClient: PublicClient | undefined
let walletClient: WalletClient | undefined

export const getPublicClient = (): PublicClient => {
  publicClient ??= createPublicClient({ chain: evmChain, transport: http(env.evm.rpcUrl) })
  return publicClient
}

/** Akun reviewer platform. Throw kalau kunci belum dikonfigurasi. */
export const getReviewerAccount = () => {
  if (!env.evm.reviewerPrivateKey) throw new Error('EVM_REVIEWER_PRIVATE_KEY is not configured')
  return privateKeyToAccount(env.evm.reviewerPrivateKey)
}

export const getWalletClient = (): WalletClient => {
  walletClient ??= createWalletClient({
    account: getReviewerAccount(),
    chain: evmChain,
    transport: http(env.evm.rpcUrl),
  })
  return walletClient
}

/** Dipakai test untuk mengganti RPC/kunci tanpa restart proses. */
export const resetEvmClients = () => {
  publicClient = undefined
  walletClient = undefined
}
