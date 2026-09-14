import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { zeroAddress } from 'viem'
import { type Pagination, paginated } from '../common/http.ts'
import { format } from '../common/money.ts'
import { env } from '../config/env.ts'
import { db } from '../db/index.ts'
import { assets, escrows, EVM_CHAINS, tasks, wallets, webhookEvents } from '../db/schema/index.ts'

/**
 * Riwayat aktivitas on-chain sebuah user, dibangun dari event kontrak yang
 * sudah diindeks ke `webhook_events`. Tidak ada panggilan RPC di jalur ini.
 *
 * Yang tercakup: fund (owner mengunci dana), award (worker menerima), refund
 * (owner mengambil sisa), withdraw (dana keluar dari kontrak). Transfer biasa di
 * luar kontrak tidak ada di sini — untuk itu tautkan ke explorer alamatnya.
 */
export type OnchainActivity = {
  type: 'fund' | 'award' | 'refund' | 'withdraw' | 'fee'
  /** in = klaim bertambah / dana masuk ke wallet; out = dana keluar dari wallet */
  direction: 'in' | 'out'
  wallet: string
  amount: string
  amountFormatted: string
  asset: { symbol: string; decimals: number; address: string }
  txHash: string
  explorerUrl: string
  blockNumber: number | null
  at: Date
  /** null untuk withdraw: penarikan itu per aset, bisa mencakup beberapa task sekaligus */
  task: { publicId: string; title: string } | null
  note: string
}


const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '')

export const listOnchainActivity = async (userId: string, page: Pagination) => {
  const myWallets = await db
    .select({ address: wallets.address })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), inArray(wallets.chain, [...EVM_CHAINS])))
  const addrs = myWallets.map((w) => w.address.toLowerCase())
  if (addrs.length === 0) return paginated([], 0, page)

  // Alamat wallet muncul di field berbeda tergantung event
  const field = (k: string) => sql`lower(${webhookEvents.payload}->>${k})`
  const touches = or(
    inArray(field('creator'), addrs),
    inArray(field('winner'), addrs),
    inArray(field('account'), addrs),
    inArray(field('recipient'), addrs),
  )
  const where = and(
    eq(webhookEvents.source, 'evm'),
    inArray(webhookEvents.eventType, ['BountyFunded', 'RewardAllocated', 'BountyRefunded', 'Withdrawn']),
    isNotNull(webhookEvents.processedAt),
    touches,
  )

  const rows = await db
    .select()
    .from(webhookEvents)
    .where(where)
    .orderBy(desc(webhookEvents.createdAt))
    .limit(page.limit)
    .offset(page.offset)
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(where)

  if (rows.length === 0) return paginated([], total, page)

  // Konteks: bountyId → task, alamat aset → simbol/desimal
  const bountyIds = [...new Set(rows.map((r) => lower(r.payload.bountyId)).filter(Boolean))]
  const taskByBounty = new Map<string, { publicId: string; title: string }>()
  if (bountyIds.length) {
    const found = await db
      .select({ bountyId: escrows.onchainBountyId, publicId: tasks.publicId, title: tasks.title })
      .from(escrows)
      .innerJoin(tasks, eq(tasks.id, escrows.taskId))
      .where(inArray(sql`lower(${escrows.onchainBountyId})`, bountyIds))
    for (const f of found) if (f.bountyId) taskByBounty.set(f.bountyId.toLowerCase(), { publicId: f.publicId, title: f.title })
  }

  const evmAssets = await db.select().from(assets).where(inArray(assets.chain, [...EVM_CHAINS]))
  const assetByAddr = new Map(
    evmAssets.map((a) => [(a.mintAddress ?? zeroAddress).toLowerCase(), { symbol: a.symbol, decimals: a.decimals, address: a.mintAddress ?? zeroAddress }]),
  )
  const assetOf = (addr: unknown) =>
    assetByAddr.get(lower(addr)) ?? { symbol: '?', decimals: 18, address: String(addr ?? zeroAddress) }

  const data: OnchainActivity[] = []
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>
    const txHash = typeof p.txHash === 'string' ? p.txHash : r.externalId.split(':')[0]!
    const base = {
      txHash,
      explorerUrl: `${env.evm.explorerUrl}/tx/${txHash}`,
      blockNumber: p.blockNumber ? Number(p.blockNumber) : null,
      at: p.blockTimestamp ? new Date(Number(p.blockTimestamp) * 1000) : r.createdAt,
      task: taskByBounty.get(lower(p.bountyId)) ?? null,
    }
    const push = (a: Omit<OnchainActivity, keyof typeof base>) => data.push({ ...base, ...a })
    const withAmount = (amount: unknown, asset: ReturnType<typeof assetOf>) => ({
      amount: String(amount ?? '0'),
      amountFormatted: format(String(amount ?? '0'), asset.decimals),
      asset,
    })

    switch (r.eventType) {
      case 'BountyFunded': {
        const asset = assetOf(p.asset)
        const total = (BigInt(String(p.budget ?? 0)) + BigInt(String(p.fee ?? 0))).toString()
        push({ type: 'fund', direction: 'out', wallet: String(p.creator), ...withAmount(total, asset), note: `Mendanai task (reward ${format(String(p.budget ?? 0), asset.decimals)} + fee ${format(String(p.fee ?? 0), asset.decimals)})` })
        break
      }
      case 'RewardAllocated': {
        const asset = assetOf(p.asset)
        if (addrs.includes(lower(p.winner)))
          push({ type: 'award', direction: 'in', wallet: String(p.winner), ...withAmount(p.reward, asset), note: 'Reward disetujui — bisa ditarik lewat withdraw()' })
        break
      }
      case 'BountyRefunded': {
        const asset = assetOf(p.asset)
        push({ type: 'refund', direction: 'in', wallet: String(p.creator), ...withAmount(p.amount, asset), note: 'Sisa dana task dikembalikan — bisa ditarik lewat withdraw()' })
        break
      }
      case 'Withdrawn': {
        const asset = assetOf(p.asset)
        const wallet = addrs.includes(lower(p.recipient)) ? String(p.recipient) : String(p.account)
        push({ type: 'withdraw', direction: 'in', wallet, ...withAmount(p.amount, asset), note: lower(p.account) === lower(p.recipient) ? 'Dana keluar dari kontrak ke wallet' : `Dana keluar dari kontrak ke ${p.recipient}` })
        break
      }
    }
  }

  return paginated(data, total, page)
}

/** Ringkasan per wallet: total masuk/keluar dari kontrak, untuk header halaman wallet. */
export const onchainSummary = async (userId: string) => {
  const activity = await listOnchainActivity(userId, { page: 1, limit: 1000, offset: 0 })
  const totals = new Map<string, { symbol: string; decimals: number; in: bigint; out: bigint }>()
  for (const a of activity.data) {
    const key = a.asset.address.toLowerCase()
    const t = totals.get(key) ?? { symbol: a.asset.symbol, decimals: a.asset.decimals, in: 0n, out: 0n }
    if (a.type === 'withdraw') t.in += BigInt(a.amount)
    else if (a.direction === 'out') t.out += BigInt(a.amount)
    totals.set(key, t)
  }
  return [...totals.values()].map((t) => ({
    asset: t.symbol,
    withdrawnToWallet: format(t.in, t.decimals),
    lockedIntoEscrow: format(t.out, t.decimals),
  }))
}

