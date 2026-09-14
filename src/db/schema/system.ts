import {
  bigint,
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
import { pk, timestamps } from './_shared.ts'
import { jobStatus } from './enums.ts'
import { users } from './identity.ts'

export const files = pgTable(
  'files',
  {
    id: pk(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    storageKey: varchar({ length: 255 }).notNull(),
    url: text().notNull(),
    mimeType: varchar({ length: 120 }).notNull(),
    sizeBytes: integer().notNull(),
    checksum: varchar({ length: 128 }),
    scanStatus: varchar({ length: 20 }).notNull().default('pending'),
    ...timestamps,
  },
  (t) => [uniqueIndex('files_storage_key').on(t.storageKey)],
)

/** Jejak aksi sensitif: approve, release dana, ubah role, resolve dispute */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    action: varchar({ length: 80 }).notNull(),
    entityType: varchar({ length: 40 }).notNull(),
    entityId: uuid(),
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
    ip: varchar({ length: 45 }),
    userAgent: text(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
  ],
)

/** Inbox webhook (GitHub, Helius/Solana, Decaf) - idempotent by externalId */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: pk(),
    source: varchar({ length: 40 }).notNull(),
    eventType: varchar({ length: 80 }).notNull(),
    externalId: varchar({ length: 200 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    error: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('webhook_events_source_external_key').on(t.source, t.externalId),
    index('webhook_events_pending_idx').on(t.processedAt),
  ],
)

/**
 * Antrean job berbasis Postgres (SELECT ... FOR UPDATE SKIP LOCKED).
 * Cukup untuk beban internal; ganti ke BullMQ/Redis kalau throughput naik.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: pk(),
    type: varchar({ length: 60 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: jobStatus().notNull().default('queued'),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lockedAt: timestamp({ withTimezone: true }),
    lockedBy: varchar({ length: 64 }),
    lastError: text(),
    /** cegah job duplikat untuk entitas yang sama */
    dedupeKey: varchar({ length: 160 }),
    ...timestamps,
  },
  (t) => [
    index('jobs_poll_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_key').on(t.dedupeKey),
  ],
)

/** Outbox event untuk integrasi luar / analytics */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: pk(),
    aggregateType: varchar({ length: 40 }).notNull(),
    aggregateId: uuid().notNull(),
    eventType: varchar({ length: 80 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    publishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('outbox_events_unpublished_idx').on(t.publishedAt, t.createdAt)],
)

/** Posisi terakhir indexer event on-chain, per kontrak. */
export const chainCursors = pgTable(
  'chain_cursors',
  {
    id: pk(),
    chainId: integer().notNull(),
    contractAddress: varchar({ length: 42 }).notNull(),
    lastBlock: bigint({ mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('chain_cursors_key').on(t.chainId, t.contractAddress)],
)

export const settings = pgTable('settings', {
  key: varchar({ length: 80 }).primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  description: text(),
  ...timestamps,
})

export const reports = pgTable(
  'reports',
  {
    id: pk(),
    reporterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: varchar({ length: 40 }).notNull(),
    entityId: uuid().notNull(),
    reason: varchar({ length: 60 }).notNull(),
    details: text(),
    status: varchar({ length: 20 }).notNull().default('open'),
    handledById: uuid().references(() => users.id),
    handledAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('reports_status_idx').on(t.status)],
)
