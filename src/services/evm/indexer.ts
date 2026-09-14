import { and, eq } from 'drizzle-orm'
import { type Address, getAddress, type Hex, parseEventLogs } from 'viem'
import { env } from '../../config/env.ts'
import { db } from '../../db/index.ts'
import { chainCursors, webhookEvents } from '../../db/schema/index.ts'
import { recordAwarded, recordFunded, recordRefunded } from '../onchain-escrow.service.ts'
import { getPublicClient } from './client.ts'
import { escrowAbi } from './escrow.contract.ts'

const SOURCE = 'evm'
/**
 * Blok per panggilan getLogs. RPC publik membatasi ini keras — Monad testnet
 * menolak lebih dari 100 blok. Naikkan lewat EVM_LOGS_BLOCK_SPAN kalau memakai
 * RPC sendiri/berbayar.
 */
const MAX_BLOCK_SPAN = BigInt(env.evm.logsBlockSpan)

let timer: ReturnType<typeof setTimeout> | undefined
let running = false

const contract = (): Address => getAddress(env.evm.escrowAddress as Address)

const loadCursor = async () => {
  const [row] = await db
    .select()
    .from(chainCursors)
    .where(and(eq(chainCursors.chainId, env.evm.chainId), eq(chainCursors.contractAddress, contract())))
    .limit(1)
  if (row) return BigInt(row.lastBlock)

  await db
    .insert(chainCursors)
    .values({ chainId: env.evm.chainId, contractAddress: contract(), lastBlock: env.evm.indexerStartBlock })
    .onConflictDoNothing()
  return BigInt(env.evm.indexerStartBlock)
}

const saveCursor = (block: bigint) =>
  db
    .update(chainCursors)
    .set({ lastBlock: Number(block) })
    .where(and(eq(chainCursors.chainId, env.evm.chainId), eq(chainCursors.contractAddress, contract())))

/**
 * Satu event = satu baris webhook_events (unik per txHash:logIndex). Kalau baris
 * sudah ada dan sudah diproses, lewati — inilah yang membuat reorg ringan dan
 * restart proses tidak menggandakan pencatatan.
 */
export const processLog = async (log: {
  eventName: string
  args: Record<string, unknown>
  transactionHash: Hex
  logIndex: number
  blockNumber: bigint
  blockTimestamp: bigint
}) => {
  const externalId = `${log.transactionHash}:${log.logIndex}`

  const [inserted] = await db
    .insert(webhookEvents)
    .values({
      source: SOURCE,
      eventType: log.eventName,
      externalId,
      // args + konteks tx, supaya riwayat aktivitas wallet bisa dibaca tanpa RPC lagi
      payload: JSON.parse(
        JSON.stringify(
          { ...log.args, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, blockTimestamp: log.blockTimestamp },
          (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      ),
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id })

  if (!inserted) return // sudah pernah masuk

  try {
    await db.transaction(async (tx) => {
      const a = log.args
      switch (log.eventName) {
        case 'BountyFunded':
          await recordFunded(tx, {
            bountyId: a.bountyId as Hex,
            taskId: a.taskId as Hex,
            creator: a.creator as Address,
            reviewer: a.reviewer as Address,
            asset: a.asset as Address,
            budget: a.budget as bigint,
            fee: a.fee as bigint,
            deadline: a.deadline as bigint,
            refundAt: a.refundAt as bigint,
            maxWinners: Number(a.maxWinners),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
          })
          break
        case 'RewardAllocated':
          await recordAwarded(tx, {
            bountyId: a.bountyId as Hex,
            submissionId: a.submissionId as Hex,
            winner: a.winner as Address,
            reward: a.reward as bigint,
            txHash: log.transactionHash,
          })
          break
        case 'BountyRefunded':
          await recordRefunded(tx, {
            bountyId: a.bountyId as Hex,
            amount: a.amount as bigint,
            txHash: log.transactionHash,
          })
          break
        // Withdrawn & TokenPermissionUpdated: cukup tercatat di webhook_events
      }
      await tx
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.id, inserted.id))
    })
  } catch (error) {
    // Event yang tidak cocok dengan task mana pun (mis. fund() liar dari luar app)
    // dicatat errornya dan dilewati; tidak boleh menghentikan indexer.
    await db
      .update(webhookEvents)
      .set({ error: (error as Error).message, attempts: 1 })
      .where(eq(webhookEvents.id, inserted.id))
    console.error(`[evm-indexer] ${log.eventName} ${externalId}: ${(error as Error).message}`)
  }
}

export const syncOnce = async () => {
  const client = getPublicClient()
  const head = await client.getBlockNumber()
  const safeHead = head - BigInt(env.evm.confirmations)
  let from = (await loadCursor()) + 1n
  if (from > safeHead) return { from, to: safeHead, events: 0 }

  let processed = 0
  while (from <= safeHead) {
    const to = from + MAX_BLOCK_SPAN - 1n < safeHead ? from + MAX_BLOCK_SPAN - 1n : safeHead
    const rawLogs = await client.getLogs({ address: contract(), fromBlock: from, toBlock: to })
    const logs = parseEventLogs({ abi: escrowAbi, logs: rawLogs })

    // timestamp blok diambil sekali per blok, bukan per log
    const timestamps = new Map<bigint, bigint>()
    for (const log of logs) {
      if (!timestamps.has(log.blockNumber))
        timestamps.set(log.blockNumber, (await client.getBlock({ blockNumber: log.blockNumber })).timestamp)
      await processLog({
        eventName: log.eventName,
        args: log.args as Record<string, unknown>,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockTimestamp: timestamps.get(log.blockNumber)!,
      })
      processed++
    }
    await saveCursor(to)
    from = to + 1n
  }
  return { to: safeHead, events: processed }
}

export const startIndexer = () => {
  if (!env.evm.enabled) {
    console.log('⛓️  EVM indexer nonaktif (EVM_ESCROW_ADDRESS/EVM_REVIEWER_PRIVATE_KEY kosong)')
    return
  }
  if (!env.evm.rpcIndexerEnabled) {
    console.log('⛓️  EVM indexer RPC dimatikan (EVM_INDEXER_ENABLED=false) — mengandalkan Ghost')
    return
  }
  const tick = async () => {
    if (running) return
    running = true
    try {
      const r = await syncOnce()
      if (r.events) console.log(`[evm-indexer] ${r.events} event sampai blok ${r.to}`)
    } catch (error) {
      console.error('[evm-indexer]', (error as Error).message)
    } finally {
      running = false
      timer = setTimeout(tick, env.evm.indexerIntervalMs)
    }
  }
  console.log(`⛓️  EVM indexer aktif: chain ${env.evm.chainId}, kontrak ${env.evm.escrowAddress}`)
  void tick()
}

export const stopIndexer = () => {
  if (timer) clearTimeout(timer)
  timer = undefined
}
