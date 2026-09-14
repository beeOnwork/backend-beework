import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { amount, money, pk, timestamps } from './_shared.ts'
import { assets } from './catalog.ts'
import {
  accountOwnerType,
  chain,
  entryDirection,
  escrowStatus,
  payoutDestination,
  transactionStatus,
  transactionType,
} from './enums.ts'
import { users } from './identity.ts'
import { tasks } from './work.ts'

/**
 * Buku besar double-entry. Setiap pergerakan dana = 1 `transactions` +
 * >= 2 `ledger_entries` yang jumlah debit dan kreditnya harus seimbang.
 * Saldo user dihitung dari `accounts.balance` (di-update dalam transaksi DB
 * yang sama dengan entry-nya), bukan dari SUM on-the-fly.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: pk(),
    ownerType: accountOwnerType().notNull(),
    /** users.id, escrows.id, atau NULL untuk akun platform */
    ownerId: uuid(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    /**
     * Saldo tersedia. Hanya boleh berubah lewat `postTransaction` supaya
     * selalu sama dengan hasil replay `ledger_entries`. Dana yang ditahan
     * tidak disimpan di sini — dana itu pindah ke akun `escrow` atau `hold`.
     */
    balance: money(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_owner_asset_key').on(t.ownerType, t.ownerId, t.assetId),
    index('accounts_owner_idx').on(t.ownerId),
  ],
)

export const transactions = pgTable(
  'transactions',
  {
    id: pk(),
    type: transactionType().notNull(),
    status: transactionStatus().notNull().default('pending'),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: amount().notNull(),

    initiatedById: uuid().references(() => users.id),
    /** polymorphic: task, submission, referral, payout, tip, ... */
    referenceType: varchar({ length: 40 }),
    referenceId: uuid(),

    /** wajib untuk semua endpoint yang memindahkan dana */
    idempotencyKey: varchar({ length: 120 }),

    // --- jejak on-chain ---
    chain: chain().notNull().default('offchain'),
    txSignature: varchar({ length: 128 }),
    confirmedAt: timestamp({ withTimezone: true }),
    failureReason: text(),

    metadata: jsonb().$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('transactions_idempotency_key').on(t.idempotencyKey),
    uniqueIndex('transactions_tx_signature_key').on(t.txSignature),
    index('transactions_reference_idx').on(t.referenceType, t.referenceId),
    index('transactions_user_idx').on(t.initiatedById, t.createdAt),
  ],
)

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: pk(),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: 'restrict' }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    direction: entryDirection().notNull(),
    amount: amount().notNull(),
    /** snapshot saldo setelah entry ini, untuk rekonsiliasi */
    balanceAfter: amount().notNull(),
    memo: text(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('ledger_entries_tx_idx').on(t.transactionId),
    index('ledger_entries_account_idx').on(t.accountId, t.createdAt),
  ],
)

/** Dana task yang ditahan sampai submission disetujui */
export const escrows = pgTable(
  'escrows',
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    /** reward + fee */
    totalAmount: amount().notNull(),
    rewardAmount: amount().notNull(),
    feeAmount: amount().notNull().default('0'),
    releasedAmount: money(),
    refundedAmount: money(),

    status: escrowStatus().notNull().default('pending'),

    chain: chain().notNull().default('offchain'),
    /** PDA / alamat vault kalau escrow dijalankan on-chain */
    onchainAddress: varchar({ length: 128 }),
    // --- khusus kontrak EVM BeeworkEscrow ---
    chainId: integer(),
    contractAddress: varchar({ length: 42 }),
    /** bytes32 bountyId = keccak256(chainId, contract, creator, taskId) */
    onchainBountyId: varchar({ length: 66 }),
    creatorAddress: varchar({ length: 42 }),
    reviewerAddress: varchar({ length: 42 }),
    fundingTxHash: varchar({ length: 66 }),
    refundAt: timestamp({ withTimezone: true }),
    fundingTxId: uuid().references(() => transactions.id),
    fundedAt: timestamp({ withTimezone: true }),
    settledAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('escrows_task_key').on(t.taskId),
    index('escrows_status_idx').on(t.status),
    uniqueIndex('escrows_onchain_bounty_key').on(t.chainId, t.onchainBountyId),
  ],
)

/** Penarikan saldo ke wallet eksternal / Decaf */
export const payouts = pgTable(
  'payouts',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: amount().notNull(),
    feeAmount: amount().notNull().default('0'),
    destinationType: payoutDestination().notNull().default('wallet'),
    destinationAddress: varchar({ length: 255 }).notNull(),
    status: transactionStatus().notNull().default('pending'),
    transactionId: uuid().references(() => transactions.id),
    txSignature: varchar({ length: 128 }),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    failureReason: text(),
    ...timestamps,
  },
  (t) => [index('payouts_user_idx').on(t.userId, t.status)],
)

/** Setoran masuk yang terdeteksi dari chain sebelum dikreditkan ke ledger */
export const deposits = pgTable(
  'deposits',
  {
    id: pk(),
    userId: uuid().references(() => users.id),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: amount().notNull(),
    chain: chain().notNull().default('solana'),
    fromAddress: varchar({ length: 128 }),
    toAddress: varchar({ length: 128 }).notNull(),
    txSignature: varchar({ length: 128 }).notNull(),
    slot: varchar({ length: 32 }),
    confirmations: varchar({ length: 16 }),
    status: transactionStatus().notNull().default('pending'),
    transactionId: uuid().references(() => transactions.id),
    ...timestamps,
  },
  (t) => [uniqueIndex('deposits_tx_signature_key').on(t.txSignature)],
)

/** Tip langsung antar user (mis. dari GitHub bot) */
export const tips = pgTable(
  'tips',
  {
    id: pk(),
    fromUserId: uuid()
      .notNull()
      .references(() => users.id),
    toUserId: uuid().references(() => users.id),
    /** kalau penerima belum punya akun: identitas eksternal + link klaim */
    recipientHandle: varchar({ length: 120 }),
    claimToken: varchar({ length: 64 }),
    claimedAt: timestamp({ withTimezone: true }),

    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: amount().notNull(),
    message: text(),
    /** konteks: issue/PR/comment GitHub */
    sourceUrl: text(),
    status: transactionStatus().notNull().default('pending'),
    transactionId: uuid().references(() => transactions.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tips_claim_token_key').on(t.claimToken),
    index('tips_to_user_idx').on(t.toUserId),
  ],
)

export const escrowsRelations = relations(escrows, ({ one }) => ({
  task: one(tasks, { fields: [escrows.taskId], references: [tasks.id] }),
  asset: one(assets, { fields: [escrows.assetId], references: [assets.id] }),
}))

export const transactionsRelations = relations(transactions, ({ many, one }) => ({
  entries: many(ledgerEntries),
  asset: one(assets, { fields: [transactions.assetId], references: [assets.id] }),
}))

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  transaction: one(transactions, {
    fields: [ledgerEntries.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, { fields: [ledgerEntries.accountId], references: [accounts.id] }),
}))
