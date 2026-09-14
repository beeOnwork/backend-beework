import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { env } from '../../config/env.ts'
import { beeworkEscrowAbi } from '../../contracts/BeeworkEscrow.abi.ts'
import { getPublicClient, getReviewerAccount, getWalletClient } from './client.ts'

export const escrowAbi = beeworkEscrowAbi
export const NATIVE_ASSET: Address = zeroAddress
/** Sama dengan FEE_BPS di kontrak; dicek saat startup lewat assertContractMatches(). */
export const CONTRACT_FEE_BPS = 500n
export const REVIEW_PERIOD_SECONDS = 7n * 24n * 60n * 60n

const contractAddress = (): Address => {
  if (!env.evm.escrowAddress) throw new Error('EVM_ESCROW_ADDRESS is not configured')
  return getAddress(env.evm.escrowAddress)
}

/** @param uuid task/submission id dari backend; kontrak mensyaratkan lowercase kanonik */
export const hashId = (uuid: string): Hex => keccak256(stringToBytes(uuid.toLowerCase()))

/** Replika `bountyIdFor` di kontrak supaya backend bisa menghitung tanpa RPC. */
export const bountyIdFor = (creator: Address, taskIdHash: Hex): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, address, address, bytes32'), [
      BigInt(env.evm.chainId),
      contractAddress(),
      getAddress(creator),
      taskIdHash,
    ]),
  )

/** Replika `quoteFee`: mulDiv(budget, 500, 10000) — pembulatan ke bawah. */
export const quoteFee = (budget: bigint): bigint => (budget * CONTRACT_FEE_BPS) / 10_000n

export type OnchainBounty = {
  creator: Address
  reviewer: Address
  asset: Address
  refundAt: bigint
  maxWinners: number
  winners: number
  closed: boolean
  budget: bigint
  awarded: bigint
  feeCharged: bigint
}

export const readBounty = async (bountyId: Hex): Promise<OnchainBounty | null> => {
  const result = await getPublicClient().readContract({
    address: contractAddress(),
    abi: escrowAbi,
    functionName: 'bounties',
    args: [bountyId],
  })

  const [creator, reviewer, asset, refundAt, maxWinners, winners, closed, budget, awarded, feeCharged] =
    result
  if (creator === zeroAddress) return null
  return { creator, reviewer, asset, refundAt, maxWinners, winners, closed, budget, awarded, feeCharged }
}

export const readClaimable = (asset: Address, account: Address) =>
  getPublicClient().readContract({
    address: contractAddress(),
    abi: escrowAbi,
    functionName: 'claimable',
    args: [asset, account],
  })

export type FundedEvent = {
  bountyId: Hex
  taskId: Hex
  creator: Address
  reviewer: Address
  asset: Address
  budget: bigint
  fee: bigint
  deadline: bigint
  refundAt: bigint
  maxWinners: number
  txHash: Hex
  blockNumber: bigint
  logIndex: number
}

/**
 * Ambil event BountyFunded dari sebuah tx. Hanya log yang dipancarkan oleh
 * kontrak kita yang dihitung — log dari kontrak lain dengan signature sama diabaikan.
 */
export const getFundedEventFromTx = async (txHash: Hex): Promise<FundedEvent | null> => {
  const client = getPublicClient()
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') return null

  const logs = parseEventLogs({ abi: escrowAbi, eventName: 'BountyFunded', logs: receipt.logs })
  const log = logs.find((l) => isAddressEqual(l.address, contractAddress()))
  if (!log) return null

  const a = log.args
  return {
    bountyId: a.bountyId,
    taskId: a.taskId,
    creator: a.creator,
    reviewer: a.reviewer,
    asset: a.asset,
    budget: a.budget,
    fee: a.fee,
    deadline: a.deadline,
    refundAt: a.refundAt,
    maxWinners: Number(a.maxWinners),
    txHash,
    blockNumber: receipt.blockNumber,
    logIndex: log.logIndex,
  }
}

/**
 * Backend (reviewer) melepas reward ke pemenang. Menunggu receipt supaya
 * pemanggil tahu pasti dana sudah claimable sebelum DB ditandai approved.
 */
export const awardOnchain = async (params: {
  bountyId: Hex
  submissionId: Hex
  winner: Address
  amount: bigint
}) => {
  const wallet = getWalletClient()
  const account = getReviewerAccount()
  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: contractAddress(),
    abi: escrowAbi,
    functionName: 'award',
    args: [params.bountyId, params.submissionId, getAddress(params.winner), params.amount],
  })
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`award() reverted in tx ${hash}`)
  return { txHash: hash, blockNumber: receipt.blockNumber }
}

/** Info publik untuk frontend membangun call fund(). */
export const publicConfig = () => ({
  chainId: env.evm.chainId,
  chainName: env.evm.chainName,
  nativeSymbol: env.evm.nativeSymbol,
  contractAddress: env.evm.escrowAddress || null,
  reviewerAddress: env.evm.reviewerPrivateKey ? getReviewerAccount().address : null,
  feeBps: Number(CONTRACT_FEE_BPS),
  reviewPeriodSeconds: Number(REVIEW_PERIOD_SECONDS),
  nativeAsset: NATIVE_ASSET,
})

/**
 * Cek saat startup bahwa kontrak di alamat itu memang BeeworkEscrow dengan
 * FEE_BPS yang sama — salah alamat berarti salah hitung fee dan bountyId.
 */
export const assertContractMatches = async () => {
  const client = getPublicClient()
  const [feeBps, code] = await Promise.all([
    client.readContract({ address: contractAddress(), abi: escrowAbi, functionName: 'FEE_BPS' }),
    client.getCode({ address: contractAddress() }),
  ])
  if (!code || code === '0x') throw new Error(`No contract at ${contractAddress()}`)
  if (feeBps !== CONTRACT_FEE_BPS)
    throw new Error(`Contract FEE_BPS=${feeBps} differs from expected ${CONTRACT_FEE_BPS}`)
}
