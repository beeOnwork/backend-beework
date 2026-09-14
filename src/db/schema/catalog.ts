import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { pk, timestamps } from './_shared.ts'
import { chain } from './enums.ts'

/** Token/mata uang yang bisa dipakai sebagai reward (SPL token, atau saldo internal) */
export const assets = pgTable(
  'assets',
  {
    id: pk(),
    symbol: varchar({ length: 24 }).notNull(),
    name: varchar({ length: 80 }).notNull(),
    chain: chain().notNull().default('solana'),
    mintAddress: varchar({ length: 128 }),
    decimals: integer().notNull().default(6),
    logoUrl: text(),
    isStable: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    /** cache harga untuk konversi ke USD (leaderboard, points, fee) */
    priceUsd: numeric({ precision: 20, scale: 8 }),
    priceUpdatedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('assets_chain_mint_key').on(t.chain, t.mintAddress)],
)

export const categories = pgTable(
  'categories',
  {
    id: pk(),
    slug: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 80 }).notNull(),
    description: text(),
    icon: varchar({ length: 64 }),
    parentId: uuid(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('categories_slug_key').on(t.slug)],
)

export const tags = pgTable(
  'tags',
  {
    id: pk(),
    slug: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 80 }).notNull(),
    usageCount: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('tags_slug_key').on(t.slug)],
)
