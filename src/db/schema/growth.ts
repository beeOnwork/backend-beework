import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { amount, money, pk, timestamps } from './_shared.ts'
import { assets } from './catalog.ts'
import { notificationChannel, referralStatus, seasonStatus } from './enums.ts'
import { users } from './identity.ts'
import { transactions } from './ledger.ts'
import { tasks } from './work.ts'

/**
 * Referral dianggap "qualified" saat referee menyelesaikan task berbayar
 * atau membuat task. Referrer mendapat REFERRAL_SHARE_BPS dari platform fee.
 */
export const referrals = pgTable(
  'referrals',
  {
    id: pk(),
    referrerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refereeId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    code: varchar({ length: 32 }).notNull(),
    status: referralStatus().notNull().default('pending'),
    qualifiedAt: timestamp({ withTimezone: true }),
    totalEarnedUsd: money(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('referrals_referee_key').on(t.refereeId),
    index('referrals_referrer_idx').on(t.referrerId, t.status),
  ],
)

export const referralPayouts = pgTable(
  'referral_payouts',
  {
    id: pk(),
    referralId: uuid()
      .notNull()
      .references(() => referrals.id, { onDelete: 'cascade' }),
    sourceTaskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: amount().notNull(),
    transactionId: uuid().references(() => transactions.id),
    ...timestamps,
  },
  (t) => [index('referral_payouts_referral_idx').on(t.referralId)],
)

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar({ length: 60 }).notNull(),
    title: varchar({ length: 200 }).notNull(),
    body: text(),
    data: jsonb().$type<Record<string, unknown>>(),
    actionUrl: text(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
)

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar({ length: 60 }).notNull(),
    channel: notificationChannel().notNull(),
    enabled: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('notification_prefs_unique').on(t.userId, t.type, t.channel)],
)

/** Device token untuk push notification (mobile app) */
export const devices = pgTable(
  'devices',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar({ length: 16 }).notNull(), // ios | android | web
    pushToken: text().notNull(),
    appVersion: varchar({ length: 32 }),
    lastSeenAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('devices_push_token_key').on(t.pushToken)],
)

// ---------------------------------------------------------------------------
// Token $WORK: staking dan revenue share per Season
// ---------------------------------------------------------------------------

export const seasons = pgTable(
  'seasons',
  {
    id: pk(),
    number: integer().notNull(),
    name: varchar({ length: 80 }).notNull(),
    status: seasonStatus().notNull().default('upcoming'),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    /** total revenue platform yang masuk pool season ini */
    totalRevenueUsd: money(),
    distributedUsd: money(),
    /** 80% peserta / 20% growth */
    participantShareBps: integer().notNull().default(8000),
    /** dari bagian peserta: 52% base stake, 48% partisipasi */
    baseRewardBps: integer().notNull().default(5200),
    ...timestamps,
  },
  (t) => [uniqueIndex('seasons_number_key').on(t.number)],
)

export const stakes = pgTable(
  'stakes',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    amount: money(),
    /** loyalty mulai 5%, +15.83% tiap minggu tanpa withdraw, cap 100% */
    loyaltyBps: integer().notNull().default(500),
    stakedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastAccrualAt: timestamp({ withTimezone: true }),
    withdrawnAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('stakes_user_asset_key').on(t.userId, t.assetId)],
)

/**
 * Poin partisipasi per season: 2 poin / 1 USDC yang dibayarkan,
 * 1 poin / 1 USDC yang didapat. Dihitung H-1 sebelum payday.
 */
export const participationPoints = pgTable(
  'participation_points',
  {
    id: pk(),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pointsFromPaid: numeric({ precision: 20, scale: 4 }).notNull().default('0'),
    pointsFromEarned: numeric({ precision: 20, scale: 4 }).notNull().default('0'),
    totalPoints: numeric({ precision: 20, scale: 4 }).notNull().default('0'),
    /** 1 = top 10%, 2 = 20% berikutnya, 3 = sisanya */
    tier: integer(),
    computedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('participation_points_unique').on(t.seasonId, t.userId)],
)

export const rewardDistributions = pgTable(
  'reward_distributions',
  {
    id: pk(),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base | participation */
    kind: varchar({ length: 20 }).notNull(),
    assetId: uuid()
      .notNull()
      .references(() => assets.id),
    grossAmount: amount().notNull(),
    /** setelah dikali loyaltyBps */
    netAmount: amount().notNull(),
    paydayDate: timestamp({ withTimezone: true }).notNull(),
    transactionId: uuid().references(() => transactions.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('reward_distributions_unique').on(t.seasonId, t.userId, t.kind, t.paydayDate),
    index('reward_distributions_user_idx').on(t.userId),
  ],
)
