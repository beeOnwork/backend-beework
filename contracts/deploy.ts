/**
 * Deploy BeeworkEscrow ke chain yang dikonfigurasi lewat env.
 *
 *   EVM_RPC_URL=... EVM_CHAIN_ID=... DEPLOYER_PRIVATE_KEY=0x... bun contracts/deploy.ts
 *
 * Opsional:
 *   ESCROW_ADMIN     alamat owner kontrak (default: deployer)
 *   ESCROW_TREASURY  penerima fee (default: deployer)
 *   ALLOW_TOKENS     daftar alamat ERC-20 yang di-allowlist, dipisah koma
 *
 * Kunci deployer tidak pernah dicetak. Hasilnya: alamat kontrak + blok deploy,
 * yang dimasukkan ke EVM_ESCROW_ADDRESS dan EVM_INDEXER_START_BLOCK.
 */
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import artifact from '../src/contracts/BeeworkEscrow.json' with { type: 'json' }

const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`env ${k} wajib diisi`)
  return v
}

const rpcUrl = need('EVM_RPC_URL')
const chainId = Number(need('EVM_CHAIN_ID'))
/** MetaMask mengekspor tanpa `0x`; terima keduanya, tolak selain 32 byte hex. */
const normalizeKey = (raw: string): `0x${string}` => {
  const hex = raw.trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error(
      `DEPLOYER_PRIVATE_KEY harus 64 karakter hex (dengan/tanpa 0x); diterima ${hex.length} karakter. ` +
        'Pastikan yang ditempel PRIVATE KEY dari "Show private key", bukan alamat wallet.',
    )
  return `0x${hex.toLowerCase()}`
}
const deployer = privateKeyToAccount(normalizeKey(need('DEPLOYER_PRIVATE_KEY')))
const admin = getAddress(process.env.ESCROW_ADMIN ?? deployer.address)
const treasury = getAddress(process.env.ESCROW_TREASURY ?? deployer.address)

const chain = defineChain({
  id: chainId,
  name: process.env.EVM_CHAIN_NAME ?? `chain-${chainId}`,
  nativeCurrency: { name: 'native', symbol: process.env.EVM_NATIVE_SYMBOL ?? 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })

console.log(`deployer : ${deployer.address}`)
console.log(`admin    : ${admin}`)
console.log(`treasury : ${treasury}`)
console.log(`chain    : ${chainId} @ ${rpcUrl}`)

const balance = await publicClient.getBalance({ address: deployer.address })
if (balance === 0n) throw new Error('Saldo deployer 0 — isi gas dulu')

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode as `0x${string}`,
  args: [admin, treasury],
})
console.log(`tx       : ${hash}`)
const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deploy gagal')

console.log(`\n✅ BeeworkEscrow di ${receipt.contractAddress} (blok ${receipt.blockNumber})`)

const tokens = (process.env.ALLOW_TOKENS ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
for (const token of tokens) {
  const h = await wallet.writeContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: 'setTokenAllowed',
    args: [getAddress(token), true],
  })
  await publicClient.waitForTransactionReceipt({ hash: h })
  console.log(`   allowlist ${token}`)
}

console.log(`\nTambahkan ke .env:`)
console.log(`EVM_ESCROW_ADDRESS=${receipt.contractAddress}`)
console.log(`EVM_INDEXER_START_BLOCK=${receipt.blockNumber}`)
