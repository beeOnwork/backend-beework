import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, sql } from './index.ts'

await migrate(db, { migrationsFolder: './drizzle' })
console.log('✅ migrations applied')
await sql.end()
