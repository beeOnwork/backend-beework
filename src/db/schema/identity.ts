import { relations } from 'drizzle-orm'
import {
  boolean,
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
import { money, pk, timestamps } from './_shared.ts'
import {
  authProvider,
  chain,
  userRole,
  userStatus,
  verificationStatus,
  verificationType,
} from './enums.ts'

export const users = pgTable(
  'users',
  {
    id: pk(),
    username: varchar({ length: 39 }).notNull(),
    displayName: varchar({ length: 120 }),
    email: varchar({ length: 255 }),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    phone: varchar({ length: 32 }),
    phoneVerifiedAt: timestamp({ withTimezone: true }),
    passwordHash: text(),
    avatarUrl: text(),
    bio: text(),
    country: varchar({ length: 2 }),
    timezone: varchar({ length: 64 }),

    role: userRole().notNull().default('user'),
    status: userStatus().notNull().default('active'),

    /** badge "Verified Only" — syarat sebagian task & participation reward */
    isVerified: boolean().notNull().default(false),
    verifiedAt: timestamp({ withTimezone: true }),

    referralCode: varchar({ length: 32 }).notNull(),
    referredById: uuid(),

    /** agregat cache untuk profil & leaderboard; sumber kebenaran = ledger */
    reputationScore: integer().notNull().default(0),
    tasksCreatedCount: integer().notNull().default(0),
    tasksCompletedCount: integer().notNull().default(0),
    totalEarnedUsd: money(),
    totalPaidUsd: money(),

    lastActiveAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_username_key').on(t.username),
    uniqueIndex('users_email_key').on(t.email),
    uniqueIndex('users_referral_code_key').on(t.referralCode),
    index('users_referred_by_idx').on(t.referredById),
    index('users_status_idx').on(t.status),
  ],
)

/** OAuth / social login (GitHub, X, Discord, Google) */
export const linkedAccounts = pgTable(
  'linked_accounts',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider().notNull(),
    providerAccountId: varchar({ length: 128 }).notNull(),
    username: varchar({ length: 120 }),
    accessTokenEnc: text(),
    refreshTokenEnc: text(),
    scope: text(),
    expiresAt: timestamp({ withTimezone: true }),
    profile: jsonb().$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('linked_accounts_provider_key').on(t.provider, t.providerAccountId),
    index('linked_accounts_user_idx').on(t.userId),
  ],
)

/** Wallet on-chain milik user; verified lewat signMessage */
export const wallets = pgTable(
  'wallets',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chain: chain().notNull().default('solana'),
    address: varchar({ length: 128 }).notNull(),
    label: varchar({ length: 64 }),
    isPrimary: boolean().notNull().default(false),
    verifiedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('wallets_chain_address_key').on(t.chain, t.address),
    index('wallets_user_idx').on(t.userId),
  ],
)

/** Refresh-token session; access token tetap stateless JWT */
export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: varchar({ length: 128 }).notNull(),
    userAgent: text(),
    ip: varchar({ length: 45 }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_refresh_hash_key').on(t.refreshTokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
)

/** OTP / magic link / verifikasi wallet — token sekali pakai */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: pk(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    purpose: varchar({ length: 40 }).notNull(), // email_verify, phone_otp, wallet_nonce, password_reset
    identifier: varchar({ length: 255 }).notNull(),
    secretHash: varchar({ length: 128 }).notNull(),
    attempts: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('auth_challenges_lookup_idx').on(t.purpose, t.identifier)],
)

export const verificationRequests = pgTable(
  'verification_requests',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: verificationType().notNull(),
    status: verificationStatus().notNull().default('pending'),
    payload: jsonb().$type<Record<string, unknown>>(),
    reviewedById: uuid().references(() => users.id),
    reviewedAt: timestamp({ withTimezone: true }),
    rejectionReason: text(),
    ...timestamps,
  },
  (t) => [index('verification_requests_user_idx').on(t.userId, t.status)],
)

/** API key untuk integrasi internal / bot */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar({ length: 80 }).notNull(),
    prefix: varchar({ length: 12 }).notNull(),
    keyHash: varchar({ length: 128 }).notNull(),
    scopes: text().array().notNull().default([]),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('api_keys_prefix_key').on(t.prefix)],
)

export const usersRelations = relations(users, ({ many, one }) => ({
  linkedAccounts: many(linkedAccounts),
  wallets: many(wallets),
  sessions: many(sessions),
  referrer: one(users, {
    fields: [users.referredById],
    references: [users.id],
    relationName: 'referrer',
  }),
}))

export const linkedAccountsRelations = relations(linkedAccounts, ({ one }) => ({
  user: one(users, { fields: [linkedAccounts.userId], references: [users.id] }),
}))

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}))
