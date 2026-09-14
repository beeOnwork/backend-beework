import { and, isNotNull, lt, or } from 'drizzle-orm'
import { db } from '../../db/index.ts'
import { authChallenges, sessions } from '../../db/schema/index.ts'
import type { JobContext } from '../runner.ts'

/** Bersih-bersih baris yang sudah tidak berguna: challenge & sesi kedaluwarsa. */
export const maintenanceHandler = async (_: Record<string, unknown>, ctx: JobContext) => {
  const dayAgo = new Date(Date.now() - 864e5)

  const challenges = await db
    .delete(authChallenges)
    .where(or(lt(authChallenges.expiresAt, dayAgo), and(isNotNull(authChallenges.consumedAt), lt(authChallenges.createdAt, dayAgo))))
    .returning({ id: authChallenges.id })

  const expiredSessions = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, dayAgo), and(isNotNull(sessions.revokedAt), lt(sessions.revokedAt, dayAgo))))
    .returning({ id: sessions.id })

  if (challenges.length || expiredSessions.length)
    ctx.log(`hapus ${challenges.length} challenge, ${expiredSessions.length} sesi`)
  return { challenges: challenges.length, sessions: expiredSessions.length }
}
