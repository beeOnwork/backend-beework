import { eq } from 'drizzle-orm'
import type { Address, Hex } from 'viem'
import { env } from '../../config/env.ts'
import { db } from '../../db/index.ts'
import { settings } from '../../db/schema/index.ts'
import { processLog } from './indexer.ts'

/**
 * GhostGraph sebagai sumber event kedua. Backend menarik `escrowEvents` sejak
 * blok terakhir yang sudah diambil dan memasukkannya ke jalur `processLog` yang
 * sama dengan indexer RPC — kunci `txHash:logIndex` menjamin tidak ada duplikasi
 * meskipun kedua sumber melaporkan event yang sama.
 */
type GhostEvent = {
  id: string
  kind: 'BountyFunded' | 'RewardAllocated' | 'BountyRefunded' | 'Withdrawn'
  bountyId: Hex
  taskId: Hex
  submissionId: Hex
  creator: Address
  reviewer: Address
  winner: Address
  account: Address
  recipient: Address
  asset: Address
  amount: string
  fee: string
  deadline: string
  refundAt: string
  maxWinners: number
  block: string
  logIndex: number
  transactionHash: Hex
  timestamp: number
}

const PAGE = 200
const cursorKey = () => `ghost_cursor:${env.evm.chainId}:${(env.evm.escrowAddress || '').toLowerCase()}`

const QUERY = /* GraphQL */ `
  query Events($after: String, $block: BigInt!) {
    escrowEvents(
      where: { block_gt: $block }
      orderBy: "block"
      orderDirection: "asc"
      limit: ${PAGE}
      after: $after
    ) {
      items {
        id kind bountyId taskId submissionId creator reviewer winner account recipient asset
        amount fee deadline refundAt maxWinners block logIndex transactionHash timestamp
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const ghostQuery = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
  if (!env.ghost.enabled) throw new Error('GHOST_GRAPHQL_URL is not configured')
  const res = await fetch(env.ghost.graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.ghost.apiKey ? { 'x-ghost-api-key': env.ghost.apiKey, authorization: `Bearer ${env.ghost.apiKey}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Ghost HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(`Ghost GraphQL: ${json.errors.map((e) => e.message).join('; ')}`)
  if (!json.data) throw new Error('Ghost: respons tanpa data')
  return json.data
}

const loadCursor = async (): Promise<bigint> => {
  const [row] = await db.select().from(settings).where(eq(settings.key, cursorKey())).limit(1)
  if (row) return BigInt(String(row.value))
  return BigInt(Math.max(0, env.evm.indexerStartBlock - 1))
}

const saveCursor = (block: bigint) =>
  db
    .insert(settings)
    .values({ key: cursorKey(), value: block.toString(), description: 'Blok terakhir yang ditarik dari GhostGraph' })
    .onConflictDoUpdate({ target: settings.key, set: { value: block.toString() } })

/** Bentuk ulang baris Ghost jadi args event persis seperti hasil parseEventLogs. */
const toLogArgs = (e: GhostEvent): Record<string, unknown> => {
  switch (e.kind) {
    case 'BountyFunded':
      return {
        bountyId: e.bountyId, taskId: e.taskId, creator: e.creator, reviewer: e.reviewer, asset: e.asset,
        budget: BigInt(e.amount), fee: BigInt(e.fee), deadline: BigInt(e.deadline), refundAt: BigInt(e.refundAt),
        maxWinners: Number(e.maxWinners),
      }
    case 'RewardAllocated':
      return { bountyId: e.bountyId, submissionId: e.submissionId, winner: e.winner, asset: e.asset, reward: BigInt(e.amount), fee: BigInt(e.fee) }
    case 'BountyRefunded':
      return { bountyId: e.bountyId, creator: e.creator, asset: e.asset, amount: BigInt(e.amount) }
    case 'Withdrawn':
      return { account: e.account, asset: e.asset, recipient: e.recipient, amount: BigInt(e.amount) }
  }
}

/** Tarik semua event baru dari Ghost dan proses. Dipanggil job berulang. */
export const reconcileFromGhost = async (log: (m: string) => void = () => {}) => {
  if (!env.ghost.enabled || !env.evm.enabled) return { skipped: true, events: 0 }

  let cursorBlock = await loadCursor()
  let after: string | null = null
  let processed = 0
  let maxBlock = cursorBlock

  type Page = { escrowEvents: { items: GhostEvent[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
  for (;;) {
    const data: Page = await ghostQuery<Page>(QUERY, { after, block: cursorBlock.toString() })
    const { items, pageInfo } = data.escrowEvents

    for (const e of items) {
      await processLog({
        eventName: e.kind,
        args: toLogArgs(e),
        transactionHash: e.transactionHash,
        logIndex: Number(e.logIndex),
        blockNumber: BigInt(e.block),
        blockTimestamp: BigInt(e.timestamp),
      })
      processed++
      if (BigInt(e.block) > maxBlock) maxBlock = BigInt(e.block)
    }

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }

  // Kursor hanya maju ke blok yang sudah lengkap: blok terakhir bisa saja masih
  // punya event yang belum diindeks Ghost, jadi tahan satu blok di belakang.
  const next = maxBlock > cursorBlock ? maxBlock - 1n : cursorBlock
  if (next > cursorBlock) await saveCursor(next)
  if (processed) log(`${processed} event dari Ghost, kursor → blok ${next}`)
  return { skipped: false, events: processed, cursor: next.toString() }
}

/** Status kedua sumber, untuk endpoint admin/ops. */
export const ghostStatus = async () => ({
  enabled: env.ghost.enabled,
  url: env.ghost.enabled ? env.ghost.graphqlUrl.replace(/\/\/([^/]+)@/, '//***@') : null,
  cursorBlock: env.ghost.enabled ? (await loadCursor()).toString() : null,
})
