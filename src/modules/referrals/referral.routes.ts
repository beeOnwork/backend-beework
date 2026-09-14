import { desc, eq, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db } from '../../db/index.ts'
import { assets, referralPayouts, referrals, users } from '../../db/schema/index.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { env } from '../../config/env.ts'

export const referralRoutes = new Elysia({ prefix: '/referrals', tags: ['Referrals'] })
  .use(authPlugin)
  .get(
    '/me',
    async ({ user }) => {
      const [me] = await db
        .select({ referralCode: users.referralCode })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)

      const [stats] = await db
        .select({
          total: sql<number>`count(*)::int`,
          qualified: sql<number>`count(*) filter (where ${referrals.status} = 'qualified')::int`,
          earnedUsd: sql<string>`coalesce(sum(${referrals.totalEarnedUsd}), 0)::text`,
        })
        .from(referrals)
        .where(eq(referrals.referrerId, user.id))

      return {
        code: me?.referralCode,
        link: `${env.appUrl}?ref=${me?.referralCode}`,
        sharePercent: env.referralShareBps / 100,
        stats,
      }
    },
    { auth: true, detail: { summary: 'Kode & statistik referral saya' } },
  )
  .get(
    '/invited',
    ({ user }) =>
      db
        .select({
          status: referrals.status,
          qualifiedAt: referrals.qualifiedAt,
          totalEarnedUsd: referrals.totalEarnedUsd,
          user: { username: users.username, avatarUrl: users.avatarUrl },
        })
        .from(referrals)
        .innerJoin(users, eq(users.id, referrals.refereeId))
        .where(eq(referrals.referrerId, user.id))
        .orderBy(desc(referrals.createdAt)),
    { auth: true, detail: { summary: 'Daftar user yang saya undang' } },
  )
  .get(
    '/payouts',
    ({ user }) =>
      db
        .select({
          amount: referralPayouts.amount,
          createdAt: referralPayouts.createdAt,
          asset: { symbol: assets.symbol, decimals: assets.decimals },
        })
        .from(referralPayouts)
        .innerJoin(referrals, eq(referrals.id, referralPayouts.referralId))
        .innerJoin(assets, eq(assets.id, referralPayouts.assetId))
        .where(eq(referrals.referrerId, user.id))
        .orderBy(desc(referralPayouts.createdAt)),
    { auth: true, detail: { summary: 'Komisi referral yang sudah dibayar' } },
  )
