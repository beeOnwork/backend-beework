import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { NotFound } from '../../common/errors.ts'
import { paginationQuery, resolvePagination } from '../../common/http.ts'
import { db } from '../../db/index.ts'
import { ratings, tasks, users, wallets } from '../../db/schema/index.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { limits, rateLimitPlugin } from '../../plugins/rate-limit.ts'
import { createChallenge, verifyAndLinkWallet } from '../../services/wallet-verify.service.ts'
import { publicUser } from '../auth/auth.service.ts'

const walletChain = t.Union([
  t.Literal('solana'),
  t.Literal('ethereum'),
  t.Literal('base'),
  t.Literal('monad'),
])

export const userRoutes = new Elysia({ prefix: '/users', tags: ['Users'] })
  .use(authPlugin)
  .use(rateLimitPlugin)
  .get(
    '/leaderboard',
    ({ query }) => {
      const page = resolvePagination(query)
      return db
        .select({
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
          isVerified: users.isVerified,
          reputationScore: users.reputationScore,
          tasksCompletedCount: users.tasksCompletedCount,
          totalEarnedUsd: users.totalEarnedUsd,
        })
        .from(users)
        .where(and(eq(users.status, 'active'), isNull(users.deletedAt)))
        .orderBy(desc(sql`${users.totalEarnedUsd}::numeric`), desc(users.reputationScore))
        .limit(page.limit)
        .offset(page.offset)
    },
    { query: paginationQuery, detail: { summary: 'Leaderboard earner' } },
  )
  .get(
    '/:username',
    async ({ params }) => {
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.username, params.username), isNull(users.deletedAt)))
        .limit(1)
      if (!user) throw NotFound('User')

      const [ratingRow] = await db
        .select({
          average: sql<string>`coalesce(avg(${ratings.score}), 0)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(ratings)
        .where(eq(ratings.toUserId, user.id))

      return { ...publicUser(user), rating: ratingRow }
    },
    { params: t.Object({ username: t.String() }), detail: { summary: 'Profil publik' } },
  )
  .get(
    '/:username/tasks',
    ({ params, query }) => {
      const page = resolvePagination(query)
      return db
        .select({
          publicId: tasks.publicId,
          title: tasks.title,
          status: tasks.status,
          rewardAmount: tasks.rewardAmount,
          createdAt: tasks.createdAt,
        })
        .from(tasks)
        .innerJoin(users, eq(users.id, tasks.ownerId))
        .where(
          and(
            eq(users.username, params.username),
            eq(tasks.visibility, 'public'),
            isNull(tasks.deletedAt),
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(page.limit)
        .offset(page.offset)
    },
    { params: t.Object({ username: t.String() }), query: paginationQuery },
  )
  .patch(
    '/me',
    async ({ user, body }) => {
      const [updated] = await db
        .update(users)
        .set(body)
        .where(eq(users.id, user.id))
        .returning()
      return publicUser(updated!)
    },
    {
      auth: true,
      body: t.Object({
        displayName: t.Optional(t.String({ maxLength: 120 })),
        bio: t.Optional(t.String({ maxLength: 1000 })),
        avatarUrl: t.Optional(t.String({ format: 'uri' })),
        country: t.Optional(t.String({ minLength: 2, maxLength: 2 })),
        timezone: t.Optional(t.String({ maxLength: 64 })),
      }),
      detail: { summary: 'Perbarui profil sendiri' },
    },
  )
  .get('/me/wallets', ({ user }) => db.select().from(wallets).where(eq(wallets.userId, user.id)), {
    auth: true,
    detail: { summary: 'Wallet yang tertaut ke akun saya' },
  })
  .post(
    '/me/wallets/challenge',
    ({ user, body }) => createChallenge(user.id, body.chain, body.address),
    {
      auth: true,
      rateLimit: limits.walletChallenge,
      body: t.Object({ chain: walletChain, address: t.String({ minLength: 20, maxLength: 128 }) }),
      detail: {
        summary: 'Langkah 1 — minta pesan untuk ditandatangani',
        description:
          'Mengembalikan `message` dan `nonce` (berlaku 10 menit). Tandatangani `message` ' +
          'dengan wallet yang alamatnya diberikan, lalu kirim ke POST /users/me/wallets. ' +
          'EVM: personal_sign (EIP-191). Solana: signMessage ed25519.',
      },
    },
  )
  .post(
    '/me/wallets',
    async ({ user, body, set }) => {
      const wallet = await verifyAndLinkWallet({ userId: user.id, ...body })
      set.status = 201
      return wallet
    },
    {
      auth: true,
      rateLimit: limits.walletVerify,
      body: t.Object({
        chain: walletChain,
        address: t.String({ minLength: 20, maxLength: 128 }),
        nonce: t.String({ minLength: 10, maxLength: 64 }),
        signature: t.String({ minLength: 64, maxLength: 512 }),
        label: t.Optional(t.String({ maxLength: 64 })),
        isPrimary: t.Optional(t.Boolean()),
      }),
      detail: {
        summary: 'Langkah 2 — tautkan wallet dengan bukti tanda tangan',
        description:
          'Wallet hanya tersimpan kalau tanda tangan cocok dengan alamatnya. Tanpa ini, ' +
          'award() on-chain bisa dikirim ke alamat salah ketik dan tidak bisa ditarik kembali.',
      },
    },
  )
  .delete(
    '/me/wallets/:id',
    async ({ user, params }) => {
      const [removed] = await db
        .delete(wallets)
        .where(and(eq(wallets.id, params.id), eq(wallets.userId, user.id)))
        .returning({ id: wallets.id })
      if (!removed) throw NotFound('Wallet')
      return { success: true }
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
