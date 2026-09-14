import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Semua nominal uang disimpan sebagai *base unit* (integer) mengikuti `decimals`
 * pada tabel `assets` — 1 USDC = 1_000_000. numeric(38,0) menghindari galat
 * floating point dan cukup untuk token dengan 18 desimal.
 */
export const amount = (name?: string) =>
  name
    ? numeric(name, { precision: 38, scale: 0 })
    : numeric({ precision: 38, scale: 0 })

export const money = () => amount().notNull().default('0')

export const pk = () => uuid().primaryKey().defaultRandom()

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}
