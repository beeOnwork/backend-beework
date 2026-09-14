import { pgEnum } from 'drizzle-orm/pg-core'

// ---- Identity ----
export const userRole = pgEnum('user_role', ['user', 'moderator', 'admin'])
export const userStatus = pgEnum('user_status', ['active', 'suspended', 'banned', 'deleted'])
export const authProvider = pgEnum('auth_provider', [
  'github',
  'twitter',
  'google',
  'discord',
  'wallet',
  /** Privy: satu DID mewakili email + embedded wallet sekaligus */
  'privy',
])
export const chain = pgEnum('chain', [
  'solana',
  'ethereum',
  'base',
  /** EVM chain yang dipakai kontrak BeeworkEscrow (native = MON) */
  'monad',
  'offchain',
])

/** Chain yang eskrownya hidup di kontrak on-chain, bukan ledger internal */
export const EVM_CHAINS = ['ethereum', 'base', 'monad'] as const
export type EvmChain = (typeof EVM_CHAINS)[number]
export const verificationType = pgEnum('verification_type', [
  'email',
  'phone',
  'twitter',
  'github',
  'kyc',
])
export const verificationStatus = pgEnum('verification_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
])

// ---- Work ----
export const taskType = pgEnum('task_type', ['task', 'bounty', 'quest'])
export const taskVisibility = pgEnum('task_visibility', ['public', 'private', 'unlisted'])
export const taskStatus = pgEnum('task_status', [
  'draft',
  'pending_deposit',
  'open',
  'in_progress',
  'in_review',
  'completed',
  'cancelled',
  'expired',
  'disputed',
])
export const applicationStatus = pgEnum('application_status', [
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
])
export const submissionStatus = pgEnum('submission_status', [
  'pending',
  'in_review',
  'needs_revision',
  'approved',
  'rejected',
  'withdrawn',
])
export const disputeStatus = pgEnum('dispute_status', [
  'open',
  'under_review',
  'resolved',
  'dismissed',
])

// ---- Money ----
export const escrowStatus = pgEnum('escrow_status', [
  'pending',
  'funded',
  'partially_released',
  'released',
  'refunded',
  'failed',
])
export const accountOwnerType = pgEnum('account_owner_type', [
  'user',
  'platform',
  'escrow',
  /** dunia luar (on-chain / bank). Satu-satunya akun yang boleh bersaldo negatif:
   * saldonya = total dana yang pernah masuk ke platform. */
  'external',
  /** penahanan dana per payout, sampai transaksi on-chain terkonfirmasi */
  'hold',
])
export const entryDirection = pgEnum('entry_direction', ['debit', 'credit'])
export const transactionType = pgEnum('transaction_type', [
  'deposit',
  'withdrawal',
  'escrow_fund',
  'escrow_release',
  'escrow_refund',
  'platform_fee',
  'referral_payout',
  'tip',
  'stake',
  'unstake',
  'reward_distribution',
  'adjustment',
])
export const transactionStatus = pgEnum('transaction_status', [
  'pending',
  'processing',
  'confirmed',
  'failed',
  'reversed',
])
export const payoutDestination = pgEnum('payout_destination', ['wallet', 'decaf', 'internal'])

// ---- Growth / system ----
export const referralStatus = pgEnum('referral_status', ['pending', 'qualified', 'void'])
export const notificationChannel = pgEnum('notification_channel', [
  'in_app',
  'email',
  'push',
  'discord',
])
export const jobStatus = pgEnum('job_status', [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'dead',
])
export const seasonStatus = pgEnum('season_status', ['upcoming', 'active', 'settling', 'closed'])
