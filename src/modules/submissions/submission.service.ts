import { and, count, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { BadRequest, Conflict, Forbidden, NotFound, UnprocessableEntity } from '../../common/errors.ts'
import { type Pagination, paginated } from '../../common/http.ts'
import { toBig, usdCents } from '../../common/money.ts'
import { db } from '../../db/index.ts'
import {
  assets,
  escrows,
  notifications,
  submissionRevisions,
  submissions,
  tasks,
  transactions,
  users,
  wallets,
} from '../../db/schema/index.ts'
import type { AuthUser } from '../../plugins/auth.ts'
import { refundEscrow, releaseEscrow } from '../../services/escrow.service.ts'
import { awardOnchain, hashId } from '../../services/evm/escrow.contract.ts'
import { assertEvmEnabled } from '../../services/onchain-escrow.service.ts'

const OPEN_STATES = ['open', 'in_progress', 'in_review'] as const

export const createSubmission = async (
  actor: AuthUser,
  taskId: string,
  input: { content?: string; links?: string[]; githubPrUrl?: string },
) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) throw NotFound('Task')
  if (!OPEN_STATES.includes(task.status as (typeof OPEN_STATES)[number]))
    throw Conflict(`Task is ${task.status} and no longer accepts submissions`)
  if (task.ownerId === actor.id) throw Forbidden('You cannot submit to your own task')
  if (task.requiresVerified && !actor.isVerified)
    throw Forbidden('This task is for verified accounts only')
  if (task.deadlineAt && task.deadlineAt < new Date()) throw Conflict('Deadline has passed')
  if (task.winnersCount >= task.maxWinners) throw Conflict('All winner slots are filled')

  if (!task.allowMultipleSubmissions) {
    const [existing] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.taskId, taskId), eq(submissions.userId, actor.id)))
      .limit(1)
    if (existing) throw Conflict('You already submitted to this task')
  }

  return db.transaction(async (tx) => {
    const [submission] = await tx
      .insert(submissions)
      .values({ taskId, userId: actor.id, ...input })
      .returning()

    await tx
      .update(tasks)
      .set({
        submissionCount: sql`${tasks.submissionCount} + 1`,
        status: task.status === 'open' ? 'in_review' : task.status,
      })
      .where(eq(tasks.id, taskId))

    await tx.insert(notifications).values({
      userId: task.ownerId,
      type: 'submission.created',
      title: 'Submission baru',
      body: `Ada submission baru pada task "${task.title}"`,
      actionUrl: `/t/${task.publicId}`,
      data: { taskId, submissionId: submission!.id },
    })

    return submission!
  })
}

export const listTaskSubmissions = async (
  actor: AuthUser,
  taskId: string,
  page: Pagination,
) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) throw NotFound('Task')

  const isOwner = task.ownerId === actor.id
  const isStaff = actor.role !== 'user'
  const scope = isOwner || isStaff ? eq(submissions.taskId, taskId) : and(eq(submissions.taskId, taskId), eq(submissions.userId, actor.id))

  const rows = await db
    .select({
      submission: submissions,
      user: { id: users.id, username: users.username, avatarUrl: users.avatarUrl },
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.userId))
    .where(scope)
    .orderBy(desc(submissions.createdAt))
    .limit(page.limit)
    .offset(page.offset)

  const [totalRow] = await db.select({ value: count() }).from(submissions).where(scope)
  return paginated(rows, totalRow?.value ?? 0, page)
}

/**
 * Public, privacy-safe activity feed for a task's detail page: who submitted /
 * got paid and when, without leaking submission content, links, or review notes.
 */
export const listTaskActivity = async (
  taskId: string,
  viewer: AuthUser | null,
  privateToken: string | undefined,
  page: Pagination,
) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!task) throw NotFound('Task')

  const isOwner = viewer?.id === task.ownerId
  const isStaff = viewer?.role === 'admin' || viewer?.role === 'moderator'
  if (task.visibility === 'private' && !isOwner && !isStaff && task.privateToken !== privateToken)
    throw Forbidden('This task is private')

  const rows = await db
    .select({
      id: submissions.id,
      status: submissions.status,
      payoutAmount: submissions.payoutAmount,
      createdAt: submissions.createdAt,
      reviewedAt: submissions.reviewedAt,
      username: users.username,
      avatarUrl: users.avatarUrl,
      isVerified: users.isVerified,
    })
    .from(submissions)
    .innerJoin(users, eq(users.id, submissions.userId))
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.createdAt))
    .limit(page.limit)
    .offset(page.offset)

  const [totalRow] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.taskId, taskId))

  const items = rows.map((row) => ({
    id: row.id,
    kind: row.status === 'approved' ? ('paid' as const) : ('submission' as const),
    user: { username: row.username, avatarUrl: row.avatarUrl, isVerified: row.isVerified },
    amount: row.status === 'approved' ? row.payoutAmount : null,
    occurredAt: (row.status === 'approved' ? row.reviewedAt : row.createdAt) ?? row.createdAt,
  }))

  return paginated(items, totalRow?.value ?? 0, page)
}

export const listMySubmissions = async (actor: AuthUser, page: Pagination) => {
  const rows = await db
    .select({
      submission: submissions,
      task: { id: tasks.id, publicId: tasks.publicId, title: tasks.title, status: tasks.status },
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(eq(submissions.userId, actor.id))
    .orderBy(desc(submissions.createdAt))
    .limit(page.limit)
    .offset(page.offset)

  const [totalRow] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.userId, actor.id))

  return paginated(rows, totalRow?.value ?? 0, page)
}

/**
 * Approve submission: lepas reward dari escrow ke pekerja + fee ke platform +
 * komisi referral, lalu update counter task & user.
 */
export const approveSubmission = async (
  actor: AuthUser,
  submissionId: string,
  payoutAmount?: string,
) => {
  const [row] = await db
    .select({ submission: submissions, task: tasks })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(eq(submissions.id, submissionId))
    .limit(1)

  if (!row) throw NotFound('Submission')
  const { submission, task } = row

  if (task.ownerId !== actor.id && actor.role === 'user')
    throw Forbidden('Only the task owner can approve')
  if (submission.status === 'approved') throw Conflict('Submission already approved')
  if (task.winnersCount >= task.maxWinners) throw Conflict('All winner slots are filled')

  const remainingSlots = task.maxWinners - task.winnersCount
  const defaultShare = (toBig(task.rewardAmount) / BigInt(task.maxWinners)).toString()
  const amount = payoutAmount ?? defaultShare
  if (toBig(amount) <= 0n) throw BadRequest('Payout amount must be greater than zero')

  if (task.onchainTaskId) return approveOnchain(actor, submission, task, amount, remainingSlots)

  return db.transaction(async (tx) => {
    const { fullyReleased } = await releaseEscrow(tx, {
      taskId: task.id,
      winnerId: submission.userId,
      amount,
      submissionId: submission.id,
      actorId: actor.id,
    })

    await tx
      .update(submissions)
      .set({
        status: 'approved',
        reviewerId: actor.id,
        reviewedAt: new Date(),
        payoutAmount: amount,
        rank: task.winnersCount + 1,
      })
      .where(eq(submissions.id, submission.id))

    const isComplete = fullyReleased || remainingSlots === 1

    await tx
      .update(tasks)
      .set({
        winnersCount: sql`${tasks.winnersCount} + 1`,
        status: isComplete ? 'completed' : task.status,
        completedAt: isComplete ? new Date() : null,
      })
      .where(eq(tasks.id, task.id))

    // All winner slots are filled but the payout(s) didn't use the whole budget
    // (a partial/custom payoutAmount) — return the unallocated remainder to the
    // owner now instead of stranding it in escrow forever.
    if (isComplete && !fullyReleased) {
      await refundEscrow(tx, task.id, actor.id)
    }

    // Agregat pelaporan (sen USD) untuk profil, leaderboard, dan poin season.
    const [asset] = await tx
      .select({ decimals: assets.decimals, priceUsd: assets.priceUsd })
      .from(assets)
      .where(eq(assets.id, task.rewardAssetId))
      .limit(1)
    const earnedCents = usdCents(amount, asset?.decimals ?? 6, asset?.priceUsd ?? null)

    await tx
      .update(users)
      .set({
        tasksCompletedCount: sql`${users.tasksCompletedCount} + 1`,
        reputationScore: sql`${users.reputationScore} + 10`,
        totalEarnedUsd: sql`${users.totalEarnedUsd} + ${earnedCents}`,
      })
      .where(eq(users.id, submission.userId))

    await tx
      .update(users)
      .set({ totalPaidUsd: sql`${users.totalPaidUsd} + ${earnedCents}` })
      .where(eq(users.id, task.ownerId))

    await tx.insert(notifications).values({
      userId: submission.userId,
      type: 'submission.approved',
      title: 'Submission disetujui 🎉',
      body: `Reward untuk "${task.title}" sudah masuk ke saldo kamu`,
      actionUrl: `/t/${task.publicId}`,
      data: { taskId: task.id, submissionId: submission.id, amount },
    })

    return { submissionId: submission.id, payoutAmount: amount, taskCompleted: isComplete }
  })
}

/**
 * Approve untuk task beraset EVM: backend (reviewer) memanggil award() di kontrak.
 * Dana tidak lewat ledger internal — pemenang menariknya sendiri lewat withdraw().
 * Urutan: kirim tx → tunggu receipt → baru tulis DB. Kalau proses mati di antara
 * keduanya, indexer yang menutup celahnya lewat event RewardAllocated.
 */
const approveOnchain = async (
  actor: AuthUser,
  submission: typeof submissions.$inferSelect,
  task: typeof tasks.$inferSelect,
  amount: string,
  remainingSlots: number,
) => {
  assertEvmEnabled()

  const [escrow] = await db.select().from(escrows).where(eq(escrows.taskId, task.id)).limit(1)
  if (!escrow?.onchainBountyId || escrow.status === 'pending')
    throw Conflict('Task escrow has not been funded on-chain')
  if (escrow.refundAt && escrow.refundAt <= new Date())
    throw Conflict('Review period is over; the contract no longer accepts awards for this bounty')

  const [asset] = await db.select().from(assets).where(eq(assets.id, task.rewardAssetId)).limit(1)
  if (!asset) throw NotFound('Asset')

  // Alamat pemenang: wallet miliknya di chain yang sama. Tanpa ini award() tidak
  // punya tujuan, dan kontrak tidak bisa membatalkan award yang salah alamat.
  // Hanya wallet yang kepemilikannya sudah dibuktikan lewat tanda tangan.
  // award() ke alamat yang salah tidak bisa dibatalkan oleh siapa pun.
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, submission.userId),
        eq(wallets.chain, asset.chain),
        isNotNull(wallets.verifiedAt),
      ),
    )
    .orderBy(desc(wallets.isPrimary), desc(wallets.verifiedAt))
    .limit(1)
  if (!wallet)
    throw UnprocessableEntity(
      `Winner has no verified ${asset.chain} wallet; they must link one via /users/me/wallets (signature) before approval`,
    )

  const submissionHash = hashId(submission.id)
  const { txHash, blockNumber } = await awardOnchain({
    bountyId: escrow.onchainBountyId as `0x${string}`,
    submissionId: submissionHash,
    winner: wallet.address as `0x${string}`,
    amount: BigInt(amount),
  })

  return db.transaction(async (tx) => {
    await tx
      .update(submissions)
      .set({
        status: 'approved',
        reviewerId: actor.id,
        reviewedAt: new Date(),
        payoutAmount: amount,
        rank: task.winnersCount + 1,
        onchainSubmissionId: submissionHash,
        winnerAddress: wallet.address,
        awardTxHash: txHash,
      })
      .where(eq(submissions.id, submission.id))

    const released = BigInt(escrow.releasedAmount) + BigInt(amount)
    const fullyReleased = released >= BigInt(escrow.rewardAmount)
    await tx
      .update(escrows)
      .set({
        releasedAmount: released.toString(),
        status: fullyReleased ? 'released' : 'partially_released',
        settledAt: fullyReleased ? new Date() : null,
      })
      .where(eq(escrows.id, escrow.id))

    // Jejak audit; tidak ada ledger_entries karena dananya tidak pernah di sini.
    await tx
      .insert(transactions)
      .values({
        type: 'escrow_release',
        status: 'confirmed',
        assetId: asset.id,
        amount,
        initiatedById: actor.id,
        referenceType: 'submission',
        referenceId: submission.id,
        idempotencyKey: `evm_award:${submission.id}`,
        chain: asset.chain,
        txSignature: txHash,
        confirmedAt: new Date(),
        metadata: { bountyId: escrow.onchainBountyId, winner: wallet.address, blockNumber: blockNumber.toString() },
      })
      .onConflictDoNothing()

    const isComplete = fullyReleased || remainingSlots === 1
    // On-chain, unallocated budget can't be pulled back immediately — the contract's
    // refund() only accepts calls after `refundAt` (deadline + review period). Record
    // the same hint `cancelTask` leaves, so the owner has a path to reclaim it later
    // instead of it silently sitting in escrow with no record anyone should check.
    await tx
      .update(tasks)
      .set({
        winnersCount: sql`${tasks.winnersCount} + 1`,
        status: isComplete ? 'completed' : task.status,
        completedAt: isComplete ? new Date() : null,
        metadata:
          isComplete && !fullyReleased
            ? {
                ...(task.metadata ?? {}),
                refundHint:
                  'Panggil refund(' + escrow.onchainBountyId + ') di kontrak setelah ' + escrow.refundAt?.toISOString(),
              }
            : task.metadata,
      })
      .where(eq(tasks.id, task.id))

    const earnedCents = usdCents(amount, asset.decimals, asset.priceUsd)
    await tx
      .update(users)
      .set({
        tasksCompletedCount: sql`${users.tasksCompletedCount} + 1`,
        reputationScore: sql`${users.reputationScore} + 10`,
        totalEarnedUsd: sql`${users.totalEarnedUsd} + ${earnedCents}`,
      })
      .where(eq(users.id, submission.userId))
    await tx
      .update(users)
      .set({ totalPaidUsd: sql`${users.totalPaidUsd} + ${earnedCents}` })
      .where(eq(users.id, task.ownerId))

    await tx.insert(notifications).values({
      userId: submission.userId,
      type: 'submission.approved',
      title: 'Submission disetujui 🎉',
      body: `Reward untuk "${task.title}" sudah bisa ditarik dari kontrak (withdraw).`,
      actionUrl: `/t/${task.publicId}`,
      data: { taskId: task.id, submissionId: submission.id, amount, txHash },
    })

    return {
      submissionId: submission.id,
      payoutAmount: amount,
      taskCompleted: isComplete,
      onchain: { txHash, winner: wallet.address, bountyId: escrow.onchainBountyId },
    }
  })
}

export const reviewSubmission = async (
  actor: AuthUser,
  submissionId: string,
  input: { status: 'rejected' | 'needs_revision'; note?: string },
) => {
  const [row] = await db
    .select({ submission: submissions, task: tasks })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(eq(submissions.id, submissionId))
    .limit(1)

  if (!row) throw NotFound('Submission')
  if (row.task.ownerId !== actor.id && actor.role === 'user')
    throw Forbidden('Only the task owner can review')
  if (row.submission.status === 'approved') throw Conflict('Submission already approved')

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(submissions)
      .set({
        status: input.status,
        reviewerId: actor.id,
        reviewNote: input.note,
        reviewedAt: new Date(),
      })
      .where(eq(submissions.id, submissionId))
      .returning()

    await tx.insert(notifications).values({
      userId: row.submission.userId,
      type: `submission.${input.status}`,
      title: input.status === 'rejected' ? 'Submission ditolak' : 'Perlu revisi',
      body: input.note ?? undefined,
      actionUrl: `/t/${row.task.publicId}`,
      data: { submissionId },
    })

    return updated!
  })
}

export const reviseSubmission = async (
  actor: AuthUser,
  submissionId: string,
  input: { content?: string; links?: string[]; githubPrUrl?: string; note?: string },
) => {
  const [submission] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)

  if (!submission) throw NotFound('Submission')
  if (submission.userId !== actor.id) throw Forbidden('Not your submission')
  if (submission.status === 'approved') throw Conflict('Approved submission cannot be edited')

  return db.transaction(async (tx) => {
    await tx.insert(submissionRevisions).values({
      submissionId,
      content: submission.content,
      links: submission.links,
      note: input.note,
    })

    const [updated] = await tx
      .update(submissions)
      .set({
        content: input.content ?? submission.content,
        links: input.links ?? submission.links,
        githubPrUrl: input.githubPrUrl ?? submission.githubPrUrl,
        status: 'pending',
        revisionCount: sql`${submissions.revisionCount} + 1`,
      })
      .where(eq(submissions.id, submissionId))
      .returning()

    return updated!
  })
}
