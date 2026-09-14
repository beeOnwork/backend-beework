import { app } from './app.ts'
import { env } from './config/env.ts'
import { sql } from './db/index.ts'
import { assertContractMatches } from './services/evm/escrow.contract.ts'
import { startJobRunner, stopJobRunner } from './jobs/index.ts'
import { startIndexer, stopIndexer } from './services/evm/indexer.ts'

if (env.evm.enabled) {
  // Gagal keras kalau alamat kontraknya salah — lebih baik tidak start daripada
  // menerbitkan fundArgs yang tidak akan pernah bisa diverifikasi.
  await assertContractMatches()
}

app.listen({ hostname: env.host, port: env.port })
startIndexer()
await startJobRunner()

console.log(`🚀 ${env.appName} API on http://${env.host}:${env.port}`)
console.log(`📚 Swagger  http://localhost:${env.port}/docs`)

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down...`)
  await app.stop()
  await sql.end()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
