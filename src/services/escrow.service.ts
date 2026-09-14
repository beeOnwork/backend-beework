import { and, eq } from 'drizzle-orm'
import { BadRequest, Conflict, NotFound } from '../common/errors.ts'
import { add, bps, sub, toBig } from '../common/money.ts'
import { env } from '../config/env.ts'
import { db, type Executor } from '../db/index.ts'
import { escrows, referralPayouts, referrals, tasks } from '../db/schema/index.ts'
import { PLATFORM, transfer } from './ledger.service.ts'

export const calculateFee = (rewardAmount: string) => {
  const fee = bps(rewardAmount, env.platformFeeBps)
  return { fee, total: add(rewardAmount, fee) }
}

/**
 * Kunci dana task: saldo owner -> akun escrow. Dipanggil saat publish task.
 * Idempoten lewat `escrows.taskId` yang unik.
 */
export const fundEscrow = async (tx: Executor, taskId: string) => {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) throw NotFound('Task')

  const [existing] = await tx.select().from(escrows).where(eq(escrows.taskId, taskId)).limit(1)
  if (existing?.status === 'funded') return existing

  const { fee, total } = calculateFee(task.rewardAmount)

  const [escrow] =
    existing
      ? [existing]
      : await tx
          .insert(escrows)
          .values({
            taskId,
            assetId: task.rewardAssetId,
            totalAmount: total,
            rewardAmount: task.rewardAmount,
            feeAmount: fee,
            expiresAt: task.deadlineAt,
          })
          .returning()

  if (!escrow) throw new Error('Failed to create escrow')

  const transaction = await transfer(tx, {
    type: 'escrow_fund',
    assetId: task.rewardAssetId,
    amount: total,
    from: { ownerType: 'user', ownerId: task.ownerId },
    to: { ownerType: 'escrow', ownerId: escrow.id },
    initiatedById: task.ownerId,
    referenceType: 'task',
    referenceId: taskId,
    idempotencyKey: `escrow_fund:${escrow.id}`,
    memo: `Fund escrow for task ${task.publicId}`,
  })

  const [funded] = await tx
    .update(escrows)
    .set({ status: 'funded', fundedAt: new Date(), fundingTxId: transaction.id })
    .where(eq(escrows.id, escrow.id))
    .returning()

  await tx
    .update(tasks)
    .set({ platformFeeAmount: fee, status: 'open', publishedAt: new Date() })
    .where(eq(tasks.id, taskId))

  return funded ?? escrow
}

/**
 * Lepas sebagian/seluruh reward ke pemenang, tarik fee platform, lalu bagi
 * komisi referral. Semua dalam satu transaksi DB.
 */
export const releaseEscrow = async (
  tx: Executor,
  params: {
    taskId: string
    winnerId: string
    amount: string
    submissionId: string
    actorId: string
  },
) => {
  const [escrow] = await tx
    .select()
    .from(escrows)
    .where(eq(escrows.taskId, params.taskId))
    .for('update')
    .limit(1)

  if (!escrow) throw NotFound('Escrow')
  if (escrow.status !== 'funded' && escrow.status !== 'partially_released')
    throw Conflict(`Escrow is ${escrow.status}, cannot release`)

  const remaining = sub(escrow.rewardAmount, escrow.releasedAmount)
  if (toBig(params.amount) > toBig(remaining))
    throw BadRequest(`Release amount exceeds remaining escrow (${remaining})`)

  // Reward: escrow -> pemenang
  await transfer(tx, {
    type: 'escrow_release',
    assetId: escrow.assetId,
    amount: params.amount,
    from: { ownerType: 'escrow', ownerId: escrow.id },
    to: { ownerType: 'user', ownerId: params.winnerId },
    initiatedById: params.actorId,
    referenceType: 'submission',
    referenceId: params.submissionId,
    idempotencyKey: `escrow_release:${params.submissionId}`,
    memo: 'Task reward',
  })

  // Fee platform ditarik proporsional terhadap porsi reward yang dilepas
  const feeShare = (
    (toBig(escrow.feeAmount) * toBig(params.amount)) /
    toBig(escrow.rewardAmount)
  ).toString()

  if (toBig(feeShare) > 0n) {
    await transfer(tx, {
      type: 'platform_fee',
      assetId: escrow.assetId,
      amount: feeShare,
      from: { ownerType: 'escrow', ownerId: escrow.id },
      to: PLATFORM,
      referenceType: 'task',
      referenceId: params.taskId,
      idempotencyKey: `platform_fee:${params.submissionId}`,
      memo: 'Platform fee',
    })

    await payReferralCommission(tx, {
      taskId: params.taskId,
      assetId: escrow.assetId,
      feeAmount: feeShare,
      participantIds: [params.winnerId],
    })
  }

  const releasedAmount = add(escrow.releasedAmount, params.amount)
  const fullyReleased = toBig(releasedAmount) >= toBig(escrow.rewardAmount)

  await tx
    .update(escrows)
    .set({
      releasedAmount,
      status: fullyReleased ? 'released' : 'partially_released',
      settledAt: fullyReleased ? new Date() : null,
    })
    .where(eq(escrows.id, escrow.id))

  return { releasedAmount, fullyReleased }
}

/** Kembalikan sisa dana escrow ke owner (task dibatalkan / kedaluwarsa). */
export const refundEscrow = async (tx: Executor, taskId: string, actorId?: string) => {
  const [escrow] = await tx
    .select()
    .from(escrows)
    .where(eq(escrows.taskId, taskId))
    .for('update')
    .limit(1)

  if (!escrow) throw NotFound('Escrow')
  if (escrow.status === 'refunded' || escrow.status === 'released') return escrow

  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) throw NotFound('Task')

  const refundable = sub(
    sub(escrow.totalAmount, escrow.releasedAmount),
    escrow.refundedAmount,
  )
  // fee yang sudah ditarik ikut terpotong di atas lewat releasedAmount + platform_fee
  const feeReleased = (
    (toBig(escrow.feeAmount) * toBig(escrow.releasedAmount)) /
    (toBig(escrow.rewardAmount) || 1n)
  ).toString()
  const netRefund = sub(refundable, feeReleased)

  if (toBig(netRefund) > 0n) {
    await transfer(tx, {
      type: 'escrow_refund',
      assetId: escrow.assetId,
      amount: netRefund,
      from: { ownerType: 'escrow', ownerId: escrow.id },
      to: { ownerType: 'user', ownerId: task.ownerId },
      initiatedById: actorId ?? task.ownerId,
      referenceType: 'task',
      referenceId: taskId,
      idempotencyKey: `escrow_refund:${escrow.id}`,
      memo: 'Escrow refund',
    })
  }

  const [updated] = await tx
    .update(escrows)
    .set({
      refundedAmount: add(escrow.refundedAmount, netRefund),
      status: 'refunded',
      settledAt: new Date(),
    })
    .where(eq(escrows.id, escrow.id))
    .returning()

  return updated ?? escrow
}

/**
 * Referrer dapat REFERRAL_SHARE_BPS dari platform fee, dibayar instan.
 * Dihitung untuk pemilik task maupun pekerjanya.
 */
export const payReferralCommission = async (
  tx: Executor,
  params: {
    taskId: string
    assetId: string
    feeAmount: string
    participantIds: string[]
  },
) => {
  const share = bps(params.feeAmount, env.referralShareBps)
  if (toBig(share) <= 0n) return

  const perParticipant = (toBig(share) / BigInt(params.participantIds.length || 1)).toString()
  if (toBig(perParticipant) <= 0n) return

  for (const participantId of params.participantIds) {
    const [referral] = await tx
      .select()
      .from(referrals)
      .where(eq(referrals.refereeId, participantId))
      .limit(1)

    if (!referral) continue

    const transaction = await transfer(tx, {
      type: 'referral_payout',
      assetId: params.assetId,
      amount: perParticipant,
      from: PLATFORM,
      to: { ownerType: 'user', ownerId: referral.referrerId },
      referenceType: 'referral',
      referenceId: referral.id,
      idempotencyKey: `referral:${referral.id}:${params.taskId}:${participantId}`,
      memo: 'Referral commission',
    })

    await tx.insert(referralPayouts).values({
      referralId: referral.id,
      sourceTaskId: params.taskId,
      assetId: params.assetId,
      amount: perParticipant,
      transactionId: transaction.id,
    })

    if (referral.status === 'pending') {
      await tx
        .update(referrals)
        .set({ status: 'qualified', qualifiedAt: new Date() })
        .where(eq(referrals.id, referral.id))
    }
  }
}

export const getEscrowByTask = (taskId: string) =>
  db.select().from(escrows).where(eq(escrows.taskId, taskId)).limit(1)

export const findActiveEscrow = (taskId: string) =>
  db
    .select()
    .from(escrows)
    .where(and(eq(escrows.taskId, taskId), eq(escrows.status, 'funded')))
    .limit(1)

