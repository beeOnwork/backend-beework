import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { BadRequest, InsufficientFunds } from '../../common/errors.ts'
import { paginationQuery, resolvePagination } from '../../common/http.ts'
import { format, gte, isPositive } from '../../common/money.ts'
import { db } from '../../db/index.ts'
import {
  accounts,
  assets,
  ledgerEntries,
  payouts,
  transactions,
  wallets,
} from '../../db/schema/index.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { limits, rateLimitPlugin } from '../../plugins/rate-limit.ts'
import { holdForPayout } from '../../services/ledger.service.ts'
import { listOnchainActivity, onchainSummary } from '../../services/onchain-activity.service.ts'
import { env } from '../../config/env.ts'

export const walletRoutes = new Elysia({ prefix: '/wallet', tags: ['Wallet'] })
  .use(authPlugin)
  .use(rateLimitPlugin)
  .get(
    '/balances',
    async ({ user }) => {
      const rows = await db
        .select({
          balance: accounts.balance,
          asset: {
            id: assets.id,
            symbol: assets.symbol,
            decimals: assets.decimals,
            logoUrl: assets.logoUrl,
          },
        })
        .from(accounts)
        .innerJoin(assets, eq(assets.id, accounts.assetId))
        .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, user.id)))

      // Dana yang sedang ditahan ada di akun `hold`, tercermin sebagai payout pending.
      const pending = await db
        .select({
          assetId: payouts.assetId,
          amount: sql<string>`coalesce(sum(${payouts.amount}), 0)::text`,
        })
        .from(payouts)
        .where(and(eq(payouts.userId, user.id), inArray(payouts.status, ['pending', 'processing'])))
        .groupBy(payouts.assetId)

      const pendingByAsset = new Map(pending.map((p) => [p.assetId, p.amount]))

      return rows.map((row) => {
        const locked = pendingByAsset.get(row.asset.id) ?? '0'
        return {
          ...row,
          locked,
          balanceFormatted: format(row.balance, row.asset.decimals),
          lockedFormatted: format(locked, row.asset.decimals),
        }
      })
    },
    { auth: true, detail: { summary: 'Saldo per token' } },
  )
  .get(
    '/transactions',
    async ({ user, query }) => {
      const page = resolvePagination(query)
      const userAccounts = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, user.id)))

      if (userAccounts.length === 0) return { data: [], meta: { page: 1, limit: page.limit, total: 0, totalPages: 1, hasNext: false } }

      const rows = await db
        .select({
          entry: {
            id: ledgerEntries.id,
            direction: ledgerEntries.direction,
            amount: ledgerEntries.amount,
            balanceAfter: ledgerEntries.balanceAfter,
            memo: ledgerEntries.memo,
            createdAt: ledgerEntries.createdAt,
          },
          transaction: {
            type: transactions.type,
            status: transactions.status,
            referenceType: transactions.referenceType,
            referenceId: transactions.referenceId,
            txSignature: transactions.txSignature,
          },
          asset: { symbol: assets.symbol, decimals: assets.decimals },
        })
        .from(ledgerEntries)
        .innerJoin(transactions, eq(transactions.id, ledgerEntries.transactionId))
        .innerJoin(assets, eq(assets.id, transactions.assetId))
        .where(
          inArray(
            ledgerEntries.accountId,
            userAccounts.map((a) => a.id),
          ),
        )
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(page.limit)
        .offset(page.offset)

      return { data: rows, meta: { page: page.page, limit: page.limit } }
    },
    { auth: true, query: paginationQuery, detail: { summary: 'Riwayat mutasi saldo' } },
  )
  .get(
    '/onchain-activity',
    ({ user, query }) => listOnchainActivity(user.id, resolvePagination(query)),
    {
      auth: true,
      query: paginationQuery,
      detail: {
        summary: 'Riwayat transaksi on-chain wallet saya (fund, award, refund, withdraw)',
        description:
          'Dibangun dari event kontrak BeeworkEscrow yang diindeks — setiap baris punya `txHash` dan ' +
          '`explorerUrl`. Transfer biasa di luar kontrak tidak tercakup; untuk itu pakai `explorerAddressUrl` ' +
          'dari GET /wallet/addresses.',
      },
    },
  )
  .get('/onchain-summary', ({ user }) => onchainSummary(user.id), {
    auth: true,
    detail: { summary: 'Total yang pernah dikunci ke escrow & ditarik ke wallet, per aset' },
  })
  .get(
    '/addresses',
    async ({ user }) =>
      (await db.select().from(wallets).where(eq(wallets.userId, user.id))).map((w) => ({
        ...w,
        explorerAddressUrl:
          w.chain === 'solana' ? `https://solscan.io/account/${w.address}` : `${env.evm.explorerUrl}/address/${w.address}`,
      })),
    { auth: true, detail: { summary: 'Wallet on-chain yang terhubung, dengan tautan explorer' } },
  )
  .post(
    '/payouts',
    async ({ user, body, set }) => {
      if (!isPositive(body.amount)) throw BadRequest('Amount must be greater than zero')

      const [account] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.ownerType, 'user'),
            eq(accounts.ownerId, user.id),
            eq(accounts.assetId, body.assetId),
          ),
        )
        .limit(1)

      if (!account || !gte(account.balance, body.amount)) throw InsufficientFunds()

      const payout = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(payouts)
          .values({
            userId: user.id,
            assetId: body.assetId,
            amount: body.amount,
            destinationType: body.destinationType ?? 'wallet',
            destinationAddress: body.destinationAddress,
          })
          .returning()

        // Tahan dananya lewat ledger; worker on-chain yang nanti menyelesaikan.
        await holdForPayout(tx, {
          userId: user.id,
          assetId: body.assetId,
          amount: body.amount,
          payoutId: row!.id,
        })
        return row!
      })

      set.status = 202
      return payout
    },
    {
      auth: 'verified',
      rateLimit: limits.payout,
      body: t.Object({
        assetId: t.String({ format: 'uuid' }),
        amount: t.String({ pattern: '^[0-9]+$' }),
        destinationType: t.Optional(
          t.Union([t.Literal('wallet'), t.Literal('decaf'), t.Literal('internal')]),
        ),
        destinationAddress: t.String({ minLength: 3, maxLength: 255 }),
      }),
      detail: {
        summary: 'Ajukan penarikan (dana dikunci, diproses worker on-chain)',
        description: 'Butuh akun terverifikasi. Status awal `pending`.',
      },
    },
  )
  .get('/payouts', ({ user }) => db.select().from(payouts).where(eq(payouts.userId, user.id)), {
    auth: true,
    detail: { summary: 'Riwayat penarikan' },
  })
