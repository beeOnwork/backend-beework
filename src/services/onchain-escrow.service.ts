import { and, eq, sql } from 'drizzle-orm'
import { type Address, getAddress, type Hex, isAddressEqual } from 'viem'
import { Conflict, NotFound, UnprocessableEntity } from '../common/errors.ts'
import { env } from '../config/env.ts'
import { type Executor } from '../db/index.ts'
import {
  assets,
  escrows,
  EVM_CHAINS,
  type EvmChain,
  notifications,
  submissions,
  tasks,
  transactions,
  users,
} from '../db/schema/index.ts'
import { getReviewerAccount } from './evm/client.ts'
import { type FundedEvent, NATIVE_ASSET } from './evm/escrow.contract.ts'

export const isEvmChain = (chain: string): chain is EvmChain =>
  (EVM_CHAINS as readonly string[]).includes(chain)

/** Alamat on-chain sebuah aset: mintAddress untuk ERC-20, address(0) untuk native. */
export const assetAddress = (asset: { mintAddress: string | null }): Address =>
  asset.mintAddress ? getAddress(asset.mintAddress) : NATIVE_ASSET

/**
 * Catat BountyFunded ke DB. Dipanggil dari endpoint publish (owner menyerahkan
 * txHash) maupun dari indexer — keduanya bisa datang lebih dulu, jadi harus
 * idempoten dan memverifikasi event terhadap task, bukan sebaliknya.
 */
export const recordFunded = async (tx: Executor, event: FundedEvent) => {
  const [task] = await tx
    .select({ task: tasks, asset: assets })
    .from(tasks)
    .innerJoin(assets, eq(assets.id, tasks.rewardAssetId))
    .where(eq(tasks.onchainTaskId, event.taskId))
    .limit(1)

  if (!task) throw NotFound(`Task for on-chain taskId ${event.taskId}`)

  // Sudah dicatat sebelumnya — oleh endpoint publish, indexer RPC, atau Ghost.
  // Dicek dari fundingTxHash, BUKAN status: kalau event ini datang terlambat
  // (setelah award/refund), status sudah bergerak dan tidak boleh ditimpa.
  const [existing] = await tx
    .select()
    .from(escrows)
    .where(eq(escrows.taskId, task.task.id))
    .limit(1)
  if (existing?.fundingTxHash) return { task: task.task, escrow: existing, alreadyRecorded: true }

  // --- verifikasi event terhadap apa yang backend janjikan ke frontend ---
  const problems: string[] = []
  if (event.budget !== BigInt(task.task.rewardAmount))
    problems.push(`budget ${event.budget} != reward ${task.task.rewardAmount}`)
  if (!isAddressEqual(event.asset, assetAddress(task.asset)))
    problems.push(`asset ${event.asset} != ${assetAddress(task.asset)}`)
  if (event.maxWinners !== task.task.maxWinners)
    problems.push(`maxWinners ${event.maxWinners} != ${task.task.maxWinners}`)
  if (!isAddressEqual(event.reviewer, getReviewerAccount().address))
    problems.push(`reviewer ${event.reviewer} is not the platform reviewer`)
  if (problems.length)
    throw UnprocessableEntity('On-chain funding does not match the task', problems)

  const [escrow] = await tx
    .insert(escrows)
    .values({
      taskId: task.task.id,
      assetId: task.asset.id,
      totalAmount: (event.budget + event.fee).toString(),
      rewardAmount: event.budget.toString(),
      feeAmount: event.fee.toString(),
      status: 'funded',
      chain: task.asset.chain,
      chainId: env.evm.chainId,
      contractAddress: env.evm.escrowAddress || null,
      onchainAddress: env.evm.escrowAddress || null,
      onchainBountyId: event.bountyId,
      creatorAddress: event.creator,
      reviewerAddress: event.reviewer,
      fundingTxHash: event.txHash,
      refundAt: new Date(Number(event.refundAt) * 1000),
      fundedAt: new Date(),
      expiresAt: new Date(Number(event.deadline) * 1000),
    })
    .onConflictDoUpdate({
      target: escrows.taskId,
      set: {
        status: 'funded',
        onchainBountyId: event.bountyId,
        creatorAddress: event.creator,
        fundingTxHash: event.txHash,
        fundedAt: new Date(),
      },
    })
    .returning()

  await tx.insert(transactions).values({
    type: 'escrow_fund',
    status: 'confirmed',
    assetId: task.asset.id,
    amount: (event.budget + event.fee).toString(),
    initiatedById: task.task.ownerId,
    referenceType: 'task',
    referenceId: task.task.id,
    idempotencyKey: `evm_fund:${event.txHash}:${event.logIndex}`,
    chain: task.asset.chain,
    txSignature: event.txHash,
    confirmedAt: new Date(),
    metadata: { bountyId: event.bountyId, blockNumber: event.blockNumber.toString() },
  }).onConflictDoNothing()

  const [updated] = await tx
    .update(tasks)
    .set({
      status: 'open',
      publishedAt: new Date(),
      platformFeeAmount: event.fee.toString(),
      deadlineAt: new Date(Number(event.deadline) * 1000),
    })
    .where(and(eq(tasks.id, task.task.id), eq(tasks.status, 'pending_deposit')))
    .returning()

  // Counter dinaikkan di sini, bukan di endpoint publish, supaya siapa pun yang
  // mencatat lebih dulu (endpoint atau indexer) hasilnya tetap satu kali.
  if (updated) {
    await tx
      .update(users)
      .set({ tasksCreatedCount: sql`${users.tasksCreatedCount} + 1` })
      .where(eq(users.id, task.task.ownerId))
  }

  return { task: updated ?? task.task, escrow: escrow!, alreadyRecorded: false }
}

/**
 * RewardAllocated dari indexer. Biasanya DB sudah ditandai oleh approveSubmission;
 * ini jaring pengaman kalau proses mati di antara tx terkirim dan DB ditulis.
 */
export const recordAwarded = async (
  tx: Executor,
  event: { bountyId: Hex; submissionId: Hex; winner: Address; reward: bigint; txHash: Hex },
) => {
  const [submission] = await tx
    .select()
    .from(submissions)
    .where(eq(submissions.onchainSubmissionId, event.submissionId))
    .limit(1)
  if (!submission) return { matched: false }

  // Jalur normal: approveSubmission sudah menulis semuanya (termasuk releasedAmount).
  // Kalau escrow ikut ditambah lagi di sini, jumlah yang dilepas tercatat dua kali.
  if (submission.status === 'approved' && submission.awardTxHash) return { matched: true }

  await tx
    .update(submissions)
    .set({
      status: 'approved',
      awardTxHash: event.txHash,
      winnerAddress: event.winner,
      payoutAmount: event.reward.toString(),
      reviewedAt: submission.reviewedAt ?? new Date(),
    })
    .where(eq(submissions.id, submission.id))

  const [escrow] = await tx
    .select()
    .from(escrows)
    .where(eq(escrows.onchainBountyId, event.bountyId))
    .limit(1)
  if (escrow && !escrow.settledAt) {
    // releasedAmount dihitung ulang dari on-chain oleh indexer saat sync penuh;
    // di sini cukup pastikan tidak lebih kecil dari yang sudah dilepas.
    const released = BigInt(escrow.releasedAmount)
    const next = released + event.reward
    await tx
      .update(escrows)
      .set({
        releasedAmount: next.toString(),
        status: next >= BigInt(escrow.rewardAmount) ? 'released' : 'partially_released',
      })
      .where(and(eq(escrows.id, escrow.id), eq(escrows.releasedAmount, escrow.releasedAmount)))
  }
  return { matched: true }
}

/** BountyRefunded: owner sudah menarik sisa dana setelah refundAt. */
export const recordRefunded = async (
  tx: Executor,
  event: { bountyId: Hex; amount: bigint; txHash: Hex },
) => {
  const [escrow] = await tx
    .select()
    .from(escrows)
    .where(eq(escrows.onchainBountyId, event.bountyId))
    .limit(1)
  if (!escrow) return { matched: false }
  if (escrow.status === 'refunded') return { matched: true }

  await tx
    .update(escrows)
    .set({ status: 'refunded', refundedAmount: event.amount.toString(), settledAt: new Date() })
    .where(eq(escrows.id, escrow.id))

  const [task] = await tx.select().from(tasks).where(eq(tasks.id, escrow.taskId)).limit(1)
  if (task && task.status !== 'completed' && task.status !== 'cancelled') {
    await tx
      .update(tasks)
      .set({ status: task.winnersCount > 0 ? 'completed' : 'expired', completedAt: new Date() })
      .where(eq(tasks.id, task.id))
  }

  await tx.insert(transactions).values({
    type: 'escrow_refund',
    status: 'confirmed',
    assetId: escrow.assetId,
    amount: event.amount.toString(),
    initiatedById: task?.ownerId ?? null,
    referenceType: 'task',
    referenceId: escrow.taskId,
    idempotencyKey: `evm_refund:${event.txHash}`,
    chain: escrow.chain,
    txSignature: event.txHash,
    confirmedAt: new Date(),
    metadata: { bountyId: event.bountyId },
  }).onConflictDoNothing()

  if (task) {
    await tx.insert(notifications).values({
      userId: task.ownerId,
      type: 'escrow.refunded',
      title: 'Dana task dikembalikan',
      body: `Sisa dana "${task.title}" sudah bisa ditarik dari kontrak (withdraw).`,
      actionUrl: `/t/${task.publicId}`,
      data: { taskId: task.id, txHash: event.txHash },
    })
  }
  return { matched: true }
}

/** Tolak task EVM kalau kontrak belum dikonfigurasi — jangan buat janji yang tidak bisa didanai. */
export const assertEvmEnabled = () => {
  if (!env.evm.enabled)
    throw Conflict('On-chain escrow is not configured on this server (EVM_ESCROW_ADDRESS / EVM_REVIEWER_PRIVATE_KEY)')
}
