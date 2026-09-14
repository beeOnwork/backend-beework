import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.ts'
import * as schema from './schema/index.ts'

export const sql = postgres(env.databaseUrl, {
  max: env.dbPoolMax,
  prepare: false,
  onnotice: env.isProd ? () => {} : undefined,
})

export const db = drizzle(sql, { schema, casing: 'snake_case', logger: !env.isProd })

export type Database = typeof db
/** Tipe yang sama untuk db maupun tx, supaya service bisa dipanggil di dalam transaksi */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export { schema }
