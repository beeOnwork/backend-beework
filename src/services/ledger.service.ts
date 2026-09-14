import { and, eq, isNull, sql as raw } from 'drizzle-orm'
import { InsufficientFunds } from '../common/errors.ts'
import { add, gte, isPositive, sub, toBig } from '../common/money.ts'
import { db, type Executor } from '../db/index.ts'
import { accounts, ledgerEntries, transactions } from '../db/schema/index.ts'

export type AccountRef =
  | { ownerType: 'user'; ownerId: string }
  | { ownerType: 'escrow'; ownerId: string }
  | { ownerType: 'platform'; ownerId?: null }
  /** sisi dunia luar untuk deposit/penarikan; boleh bersaldo negatif */
  | { ownerType: 'external'; ownerId?: null }
  /** penahanan dana per payout */
  | { ownerType: 'hold'; ownerId: string }

export const EXTERNAL: AccountRef = { ownerType: 'external', ownerId: null }
export const PLATFORM: AccountRef = { ownerType: 'platform', ownerId: null }

export type Movement = {
  account: AccountRef
  /** credit = dana masuk ke akun, debit = dana keluar dari akun */
  direction: 'credit' | 'debit'
  amount: string
  memo?: string
}

export type PostTransactionInput = {
  type: (typeof transactions.$inferInsert)['type']
  assetId: string
  amount: string
  movements: Movement[]
  initiatedById?: string | null
  referenceType?: string
  referenceId?: string
  idempotencyKey?: string
  chain?: (typeof transactions.$inferInsert)['chain']
  txSignature?: string
  status?: (typeof transactions.$inferInsert)['status']
  metadata?: Record<string, unknown>
}

/** Ambil (atau buat) akun ledger dan kunci barisnya sampai transaksi selesai. */
export const lockAccount = async (
  tx: Executor,
  ref: AccountRef,
  assetId: string,
): Promise<typeof accounts.$inferSelect> => {
  const ownerId = ref.ownerId ?? null

  const where = and(
    eq(accounts.ownerType, ref.ownerType),
    ownerId === null ? isNull(accounts.ownerId) : eq(accounts.ownerId, ownerId),
    eq(accounts.assetId, assetId),
  )

  const [existing] = await tx.select().from(accounts).where(where).for('update').limit(1)
  if (existing) return existing

  await tx
    .insert(accounts)
    .values({ ownerType: ref.ownerType, ownerId, assetId })
    .onConflictDoNothing()

  const [created] = await tx.select().from(accounts).where(where).for('update').limit(1)
  if (!created) throw new Error('Failed to create ledger account')
  return created
}

/**
 * Catat satu transaksi double-entry. Total kredit harus sama dengan total debit,
 * dan saldo akun di-update di dalam transaksi DB yang sama.
 */
export const postTransaction = async (tx: Executor, input: PostTransactionInput) => {
  const totalCredit = input.movements
    .filter((m) => m.direction === 'credit')
    .reduce((acc, m) => acc + toBig(m.amount), 0n)
  const totalDebit = input.movements
    .filter((m) => m.direction === 'debit')
    .reduce((acc, m) => acc + toBig(m.amount), 0n)

  if (totalCredit !== totalDebit)
    throw new Error(`Unbalanced transaction: credit ${totalCredit} != debit ${totalDebit}`)

  const [transaction] = await tx
    .insert(transactions)
    .values({
      type: input.type,
      status: input.status ?? 'confirmed',
      assetId: input.assetId,
      amount: input.amount,
      initiatedById: input.initiatedById ?? null,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      chain: input.chain ?? 'offchain',
      txSignature: input.txSignature,
      confirmedAt: (input.status ?? 'confirmed') === 'confirmed' ? new Date() : null,
      metadata: input.metadata,
    })
    .returning()

  if (!transaction) throw new Error('Failed to create transaction')

  for (const movement of input.movements) {
    if (!isPositive(movement.amount)) throw new Error('Movement amount must be positive')

    const account = await lockAccount(tx, movement.account, input.assetId)
    const nextBalance =
      movement.direction === 'credit'
        ? add(account.balance, movement.amount)
        : sub(account.balance, movement.amount)

    // Hanya akun `external` yang boleh minus — itu cermin dana di luar platform.
    if (toBig(nextBalance) < 0n && account.ownerType !== 'external')
      throw InsufficientFunds(
        `Account ${account.id} would go negative (balance ${account.balance}, debit ${movement.amount})`,
      )

    await tx.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id))

    await tx.insert(ledgerEntries).values({
      transactionId: transaction.id,
      accountId: account.id,
      direction: movement.direction,
      amount: movement.amount,
      balanceAfter: nextBalance,
      memo: movement.memo,
    })
  }

  return transaction
}

/** Perpindahan sederhana antar dua akun. */
export const transfer = async (
  tx: Executor,
  params: Omit<PostTransactionInput, 'movements'> & {
    from: AccountRef
    to: AccountRef
    memo?: string
  },
) => {
  const { from, to, memo, ...rest } = params
  return postTransaction(tx, {
    ...rest,
    movements: [
      { account: from, direction: 'debit', amount: rest.amount, memo },
      { account: to, direction: 'credit', amount: rest.amount, memo },
    ],
  })
}

export const getBalances = (userId: string) =>
  db
    .select({
      assetId: accounts.assetId,
      balance: accounts.balance,
    })
    .from(accounts)
    .where(and(eq(accounts.ownerType, 'user'), eq(accounts.ownerId, userId)))

/** Cek integritas: total debit harus sama dengan total kredit di seluruh buku. */
export const assertLedgerBalanced = async () => {
  const [row] = await db.execute<{ diff: string }>(raw`
    select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::text as diff
    from ledger_entries
  `)
  return row?.diff === '0'
}

/** Dana masuk dari luar platform (deposit on-chain terkonfirmasi) ke saldo user. */
export const creditDeposit = (
  tx: Executor,
  params: {
    userId: string
    assetId: string
    amount: string
    txSignature?: string
    referenceId?: string
    chain?: PostTransactionInput['chain']
  },
) =>
  transfer(tx, {
    type: 'deposit',
    assetId: params.assetId,
    amount: params.amount,
    from: EXTERNAL,
    to: { ownerType: 'user', ownerId: params.userId },
    initiatedById: params.userId,
    referenceType: 'deposit',
    referenceId: params.referenceId,
    idempotencyKey: params.txSignature ? `deposit:${params.txSignature}` : undefined,
    chain: params.chain ?? 'solana',
    txSignature: params.txSignature,
    memo: 'Deposit',
  })

/**
 * Tahan dana untuk penarikan: saldo user pindah ke akun `hold` milik payout itu.
 * Semuanya lewat ledger, jadi `accounts.balance` tetap bisa direkonsiliasi.
 */
export const holdForPayout = (
  tx: Executor,
  params: { userId: string; assetId: string; amount: string; payoutId: string },
) =>
  transfer(tx, {
    type: 'withdrawal',
    assetId: params.assetId,
    amount: params.amount,
    from: { ownerType: 'user', ownerId: params.userId },
    to: { ownerType: 'hold', ownerId: params.payoutId },
    initiatedById: params.userId,
    referenceType: 'payout',
    referenceId: params.payoutId,
    idempotencyKey: `payout_hold:${params.payoutId}`,
    memo: 'Withdrawal hold',
  })

/** Penarikan terkonfirmasi on-chain: dana keluar dari platform. */
export const settlePayout = (
  tx: Executor,
  params: {
    assetId: string
    amount: string
    payoutId: string
    userId: string
    txSignature?: string
  },
) =>
  transfer(tx, {
    type: 'withdrawal',
    assetId: params.assetId,
    amount: params.amount,
    from: { ownerType: 'hold', ownerId: params.payoutId },
    to: EXTERNAL,
    initiatedById: params.userId,
    referenceType: 'payout',
    referenceId: params.payoutId,
    idempotencyKey: `payout_settle:${params.payoutId}`,
    chain: 'solana',
    txSignature: params.txSignature,
    memo: 'Withdrawal settled',
  })

/** Penarikan gagal/dibatalkan: dana kembali ke saldo user. */
export const releaseHold = (
  tx: Executor,
  params: { userId: string; assetId: string; amount: string; payoutId: string },
) =>
  transfer(tx, {
    type: 'adjustment',
    assetId: params.assetId,
    amount: params.amount,
    from: { ownerType: 'hold', ownerId: params.payoutId },
    to: { ownerType: 'user', ownerId: params.userId },
    initiatedById: params.userId,
    referenceType: 'payout',
    referenceId: params.payoutId,
    idempotencyKey: `payout_release:${params.payoutId}`,
    memo: 'Withdrawal cancelled',
  })
