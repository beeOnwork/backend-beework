import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { Conflict, NotFound, Unauthorized } from '../../common/errors.ts'
import { secretToken, sha256, shortId } from '../../common/ids.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/index.ts'
import { referrals, sessions, users } from '../../db/schema/index.ts'

const REFRESH_TTL_MS = () => env.refreshTtlDays * 24 * 60 * 60 * 1000

export type SessionContext = { userAgent?: string; ip?: string }

export const register = async (input: {
  username: string
  email: string
  password: string
  displayName?: string
  referralCode?: string
}) => {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.username, input.username), eq(users.email, input.email)))
    .limit(1)

  if (existing) throw Conflict('Username or email is already taken')

  const referrer = input.referralCode
    ? (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.referralCode, input.referralCode))
          .limit(1)
      )[0]
    : undefined

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: input.username,
        email: input.email,
        displayName: input.displayName ?? input.username,
        passwordHash: await Bun.password.hash(input.password),
        referralCode: shortId(8),
        referredById: referrer?.id ?? null,
      })
      .returning()

    if (!user) throw new Error('Failed to create user')

    if (referrer) {
      await tx.insert(referrals).values({
        referrerId: referrer.id,
        refereeId: user.id,
        code: input.referralCode!,
      })
    }

    return user
  })
}

export const verifyCredentials = async (identifier: string, password: string) => {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        or(eq(users.username, identifier), eq(users.email, identifier)),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)

  if (!user?.passwordHash) throw Unauthorized('Invalid credentials')
  if (!(await Bun.password.verify(password, user.passwordHash)))
    throw Unauthorized('Invalid credentials')
  if (user.status !== 'active') throw Unauthorized(`Account is ${user.status}`)

  return user
}

export const issueRefreshToken = async (userId: string, ctx: SessionContext) => {
  const token = secretToken(48)
  await db.insert(sessions).values({
    userId,
    refreshTokenHash: await sha256(token),
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS()),
  })
  return token
}

export const rotateRefreshToken = async (token: string, ctx: SessionContext) => {
  const hash = await sha256(token)
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.refreshTokenHash, hash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!session) throw Unauthorized('Invalid or expired refresh token')

  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id))
  const next = await issueRefreshToken(session.userId, ctx)
  return { userId: session.userId, refreshToken: next }
}

export const revokeRefreshToken = async (token: string) => {
  const hash = await sha256(token)
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.refreshTokenHash, hash), isNull(sessions.revokedAt)))
}

export const revokeAllSessions = (userId: string) =>
  db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))

export const getUserById = async (id: string) => {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  if (!user) throw NotFound('User')
  return user
}

export const publicUser = (user: typeof users.$inferSelect) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  bio: user.bio,
  role: user.role,
  isVerified: user.isVerified,
  reputationScore: user.reputationScore,
  tasksCreatedCount: user.tasksCreatedCount,
  tasksCompletedCount: user.tasksCompletedCount,
  totalEarnedUsd: user.totalEarnedUsd,
  createdAt: user.createdAt,
})

export const privateUser = (user: typeof users.$inferSelect) => ({
  ...publicUser(user),
  email: user.email,
  emailVerifiedAt: user.emailVerifiedAt,
  phone: user.phone,
  phoneVerifiedAt: user.phoneVerifiedAt,
  referralCode: user.referralCode,
  status: user.status,
  country: user.country,
})
