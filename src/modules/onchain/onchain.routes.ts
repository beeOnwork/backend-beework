import { and, eq, inArray } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { getAddress } from 'viem'
import { NotFound } from '../../common/errors.ts'
import { format } from '../../common/money.ts'
import { db } from '../../db/index.ts'
import { assets, escrows, EVM_CHAINS, tasks, wallets } from '../../db/schema/index.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { env } from '../../config/env.ts'
import { escrowAbi, publicConfig, readBounty, readClaimable } from '../../services/evm/escrow.contract.ts'
import { assetAddress } from '../../services/onchain-escrow.service.ts'
import { ghostStatus } from '../../services/evm/ghost.service.ts'
import { chainCursors, webhookEvents } from '../../db/schema/index.ts'
import { getPublicClient } from '../../services/evm/client.ts'
import { sql } from 'drizzle-orm'
import { resolveTaskId } from '../tasks/task.service.ts'

export const onchainRoutes = new Elysia({ prefix: '/onchain', tags: ['On-chain'] })
  .use(authPlugin)
  .get(
    '/config',
    () => ({ enabled: env.evm.enabled, ...publicConfig() }),
    {
      detail: {
        summary: 'Konfigurasi kontrak eskrow (chain, alamat, reviewer, fee)',
        description: 'Dipakai frontend untuk membangun transaksi fund(). Tidak butuh login.',
      },
    },
  )
  .get('/abi', () => escrowAbi, {
    detail: {
      summary: 'ABI kontrak BeeworkEscrow',
      description: 'Sama persis dengan yang dipakai backend (hasil kompilasi solc 0.8.28). Untuk viem/ethers di frontend, Remix, atau MetaMask.',
    },
  })
  .get(
    '/indexer-status',
    async () => {
      if (!env.evm.enabled) return { enabled: false }
      const head = await getPublicClient().getBlockNumber().catch(() => null)
      const [cursor] = await db.select().from(chainCursors).where(eq(chainCursors.chainId, env.evm.chainId)).limit(1)
      const [counts] = await db
        .select({
          total: sql<number>`count(*)::int`,
          processed: sql<number>`count(*) filter (where ${webhookEvents.processedAt} is not null)::int`,
          failed: sql<number>`count(*) filter (where ${webhookEvents.error} is not null)::int`,
        })
        .from(webhookEvents)
        .where(eq(webhookEvents.source, 'evm'))
      return {
        enabled: true,
        chainHead: head?.toString() ?? null,
        rpc: {
          enabled: env.evm.rpcIndexerEnabled,
          cursorBlock: cursor?.lastBlock ?? null,
          lagBlocks: head && cursor ? Number(head) - cursor.lastBlock : null,
        },
        ghost: await ghostStatus(),
        events: counts,
      }
    },
    { auth: 'admin', detail: { summary: 'Posisi indexer RPC & Ghost vs head chain, jumlah event' } },
  )
  .get(
    '/claimable',
    async ({ user }) => {
      if (!env.evm.enabled) return []

      const myWallets = await db
        .select({ address: wallets.address, chain: wallets.chain })
        .from(wallets)
        .where(and(eq(wallets.userId, user.id), inArray(wallets.chain, [...EVM_CHAINS])))

      const evmAssets = await db
        .select()
        .from(assets)
        .where(and(eq(assets.isActive, true), inArray(assets.chain, [...EVM_CHAINS])))

      const rows = []
      for (const wallet of myWallets) {
        for (const asset of evmAssets) {
          const amount = await readClaimable(assetAddress(asset), getAddress(wallet.address))
          if (amount === 0n) continue
          rows.push({
            wallet: wallet.address,
            asset: { id: asset.id, symbol: asset.symbol, decimals: asset.decimals, address: assetAddress(asset) },
            amount: amount.toString(),
            amountFormatted: format(amount, asset.decimals),
          })
        }
      }
      return rows
    },
    {
      auth: true,
      detail: {
        summary: 'Dana yang bisa ditarik dari kontrak oleh wallet saya',
        description:
          'Hasil award() atau refund() menumpuk di `claimable` kontrak; user menariknya ' +
          'sendiri lewat withdraw(asset, recipient). Backend tidak memegang dana ini.',
      },
    },
  )
  .get(
    '/tasks/:id',
    async ({ params }) => {
      const taskId = await resolveTaskId(params.id)
      const [row] = await db
        .select({ escrow: escrows, task: { publicId: tasks.publicId, status: tasks.status } })
        .from(escrows)
        .innerJoin(tasks, eq(tasks.id, escrows.taskId))
        .where(eq(escrows.taskId, taskId))
        .limit(1)
      if (!row?.escrow.onchainBountyId) throw NotFound('On-chain escrow for this task')

      const live = await readBounty(row.escrow.onchainBountyId as `0x${string}`)
      return {
        task: row.task,
        db: {
          status: row.escrow.status,
          bountyId: row.escrow.onchainBountyId,
          fundingTxHash: row.escrow.fundingTxHash,
          releasedAmount: row.escrow.releasedAmount,
          refundAt: row.escrow.refundAt,
        },
        // sumber kebenaran; kalau berbeda dari `db`, indexer sedang tertinggal
        onchain: live
          ? {
              creator: live.creator,
              reviewer: live.reviewer,
              asset: live.asset,
              budget: live.budget.toString(),
              awarded: live.awarded.toString(),
              feeCharged: live.feeCharged.toString(),
              winners: live.winners,
              maxWinners: live.maxWinners,
              closed: live.closed,
              refundAt: new Date(Number(live.refundAt) * 1000),
            }
          : null,
      }
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { summary: 'Status eskrow on-chain sebuah task (DB vs kontrak)' },
    },
  )
