import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { env } from '../../config/env.ts'
import { db } from '../../db/index.ts'
import { escrows, notifications, submissions, tasks } from '../../db/schema/index.ts'
import { refundEscrow } from '../../services/escrow.service.ts'
import type { JobContext } from '../runner.ts'

const ACTIVE = ['open', 'in_progress', 'in_review'] as const
const UNRESOLVED = ['pending', 'in_review', 'needs_revision'] as const

/** Batas kedaluwarsa: refundAt kontrak kalau on-chain, selain itu deadline + masa review. */
const expiryOf = (task: { deadlineAt: Date | null }, escrow: { refundAt: Date | null } | undefined) =>
  escrow?.refundAt ??
  (task.deadlineAt ? new Date(task.deadlineAt.getTime() + env.taskReviewPeriodDays * 864e5) : null)

/**
 * Kedaluwarsakan satu task. Idempoten: task dikunci, statusnya dicek ulang di
 * dalam transaksi, jadi dua worker yang menyapu bersamaan tidak saling menimpa.
 */
export const expireTask = async (taskId: string, log: (m: string) => void) =>
  db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update').limit(1)
    if (!task || !(ACTIVE as readonly string[]).includes(task.status)) return { skipped: true }

    const [escrow] = await tx.select().from(escrows).where(eq(escrows.taskId, task.id)).limit(1)
    const expiry = expiryOf(task, escrow)
    if (!expiry || expiry > new Date()) return { skipped: true }

    // 1. submission yang belum diputuskan → rejected, supaya tidak menggantung
    const rejected = await tx
      .update(submissions)
      .set({
        status: 'rejected',
        reviewNote: 'Task kedaluwarsa sebelum submission ini ditinjau.',
        reviewedAt: new Date(),
      })
      .where(and(eq(submissions.taskId, task.id), inArray(submissions.status, [...UNRESOLVED])))
      .returning({ userId: submissions.userId })

    // 2. sisa dana. Ledger: kembalikan ke owner sekarang. On-chain: kontrak yang
    //    memegang; owner harus memanggil refund() sendiri (indexer nanti mencatatnya).
    const onchain = Boolean(task.onchainTaskId)
    let refunded: string | null = null
    if (!onchain && escrow && (escrow.status === 'funded' || escrow.status === 'partially_released')) {
      const result = await refundEscrow(tx, task.id)
      refunded = result.refundedAmount
    }

    // 3. status akhir: ada pemenang → completed, tidak ada → expired
    const finalStatus = task.winnersCount > 0 ? 'completed' : 'expired'
    await tx
      .update(tasks)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        metadata: {
          ...(task.metadata ?? {}),
          expiredBy: 'job:tasks.expire',
          ...(onchain && escrow?.onchainBountyId
            ? { refundHint: `Panggil refund(${escrow.onchainBountyId}) di kontrak untuk menarik sisa dana` }
            : {}),
        },
      })
      .where(eq(tasks.id, task.id))

    // 4. beri tahu
    await tx.insert(notifications).values([
      {
        userId: task.ownerId,
        type: finalStatus === 'expired' ? 'task.expired' : 'task.closed',
        title: finalStatus === 'expired' ? 'Task kedaluwarsa' : 'Task ditutup',
        body: onchain
          ? `Masa review "${task.title}" berakhir. Tarik sisa dana lewat refund() di kontrak.`
          : `Masa review "${task.title}" berakhir. Sisa dana sudah dikembalikan ke saldo kamu.`,
        actionUrl: `/t/${task.publicId}`,
        data: { taskId: task.id, refunded, rejectedSubmissions: rejected.length },
      },
      ...rejected.map((r) => ({
        userId: r.userId,
        type: 'submission.rejected',
        title: 'Task kedaluwarsa',
        body: `"${task.title}" berakhir sebelum submission kamu ditinjau.`,
        actionUrl: `/t/${task.publicId}`,
        data: { taskId: task.id },
      })),
    ])

    log(`${task.publicId} → ${finalStatus}; ${rejected.length} submission ditolak${refunded ? `, refund ${refunded}` : ''}`)
    return { skipped: false, status: finalStatus, rejected: rejected.length, refunded }
  })

/** Job berulang: sapu task aktif yang sudah lewat batas kedaluwarsanya. */
export const expireTasksHandler = async (_: Record<string, unknown>, ctx: JobContext) => {
  const reviewMs = env.taskReviewPeriodDays * 864e5
  // kandidat: deadline + review sudah lewat, ATAU refundAt escrow sudah lewat
  const candidates = await db
    .select({ id: tasks.id })
    .from(tasks)
    .leftJoin(escrows, eq(escrows.taskId, tasks.id))
    .where(
      and(
        inArray(tasks.status, [...ACTIVE]),
        isNotNull(tasks.deadlineAt),
        sql`coalesce(${escrows.refundAt}, ${tasks.deadlineAt} + (${reviewMs / 1000}::double precision * interval '1 second')) <= now()`,
      ),
    )
    .limit(200)

  let expired = 0
  for (const { id } of candidates) {
    const r = await expireTask(id, ctx.log)
    if (!r.skipped) expired++
  }
  if (candidates.length) ctx.log(`${candidates.length} kandidat, ${expired} dikedaluwarsakan`)
  return { candidates: candidates.length, expired }
}

