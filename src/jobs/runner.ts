import { and, eq, lte, or, sql } from 'drizzle-orm'
import { hostname } from 'node:os'
import { env } from '../config/env.ts'
import { db, type Executor } from '../db/index.ts'
import { jobs } from '../db/schema/index.ts'

/**
 * Antrean job di Postgres. Klaim pakai `FOR UPDATE SKIP LOCKED`, jadi aman
 * dijalankan lebih dari satu proses tanpa job yang sama dieksekusi dua kali.
 *
 * Dua jenis job:
 *  - sekali jalan: enqueue(type, payload, runAt) — retry dengan backoff, lalu `dead`
 *  - berulang: didaftarkan di `recurring` — satu baris per type (dedupeKey), setelah
 *    selesai baris yang sama dijadwalkan ulang; tidak pernah `dead`.
 */
export type JobContext = { jobId: string; attempt: number; log: (msg: string) => void }
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<unknown>

const handlers = new Map<string, JobHandler>()
const recurring = new Map<string, number>() // type → interval ms

export const registerHandler = (type: string, handler: JobHandler) => {
  handlers.set(type, handler)
}

export const registerRecurring = (type: string, everyMs: number, handler: JobHandler) => {
  handlers.set(type, handler)
  recurring.set(type, everyMs)
}

export const enqueue = (
  tx: Executor,
  job: { type: string; payload?: Record<string, unknown>; runAt?: Date; dedupeKey?: string; maxAttempts?: number },
) =>
  tx
    .insert(jobs)
    .values({
      type: job.type,
      payload: job.payload ?? {},
      runAt: job.runAt ?? new Date(),
      dedupeKey: job.dedupeKey,
      maxAttempts: job.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id })

const WORKER_ID = `${hostname()}:${process.pid}`
/** job `processing` lebih lama dari ini dianggap yatim (proses mati) dan diklaim ulang */
const STALE_LOCK_MS = 10 * 60_000
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** attempt, 60 * 60_000)

/** Pastikan tiap job berulang punya satu baris hidup di antrean. */
const ensureRecurring = async () => {
  for (const [type] of recurring) {
    await db
      .insert(jobs)
      .values({ type, payload: {}, dedupeKey: `recurring:${type}`, maxAttempts: 1_000_000 })
      .onConflictDoNothing()
  }
}

const claimOne = () =>
  db.transaction(async (tx) => {
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS)
    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        or(
          and(eq(jobs.status, 'queued'), lte(jobs.runAt, new Date())),
          and(eq(jobs.status, 'processing'), lte(jobs.lockedAt, staleBefore)),
        ),
      )
      .orderBy(jobs.runAt)
      .limit(1)
      .for('update', { skipLocked: true })

    if (!job) return null

    await tx
      .update(jobs)
      .set({ status: 'processing', lockedAt: new Date(), lockedBy: WORKER_ID, attempts: job.attempts + 1 })
      .where(eq(jobs.id, job.id))

    return { ...job, attempts: job.attempts + 1 }
  })

const finish = async (job: typeof jobs.$inferSelect, error?: Error) => {
  const every = recurring.get(job.type)

  if (!error) {
    if (every) {
      await db
        .update(jobs)
        .set({ status: 'queued', runAt: new Date(Date.now() + every), attempts: 0, lockedAt: null, lockedBy: null, lastError: null })
        .where(eq(jobs.id, job.id))
    } else {
      await db.update(jobs).set({ status: 'succeeded', lockedAt: null, lockedBy: null }).where(eq(jobs.id, job.id))
    }
    return
  }

  const message = error.message.slice(0, 2000)
  if (every) {
    // job berulang tidak boleh mati; coba lagi di jadwal berikutnya
    await db
      .update(jobs)
      .set({ status: 'queued', runAt: new Date(Date.now() + every), lockedAt: null, lockedBy: null, lastError: message })
      .where(eq(jobs.id, job.id))
    return
  }

  const dead = job.attempts >= job.maxAttempts
  await db
    .update(jobs)
    .set({
      status: dead ? 'dead' : 'queued',
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
      lockedAt: null,
      lockedBy: null,
      lastError: message,
    })
    .where(eq(jobs.id, job.id))
}

export const runOne = async (job: typeof jobs.$inferSelect) => {
  const handler = handlers.get(job.type)
  if (!handler) {
    await finish(job, new Error(`No handler registered for job type ${job.type}`))
    return
  }
  const log = (msg: string) => console.log(`[job ${job.type}#${job.id.slice(0, 8)}] ${msg}`)
  try {
    await handler(job.payload, { jobId: job.id, attempt: job.attempts, log })
    await finish(job)
  } catch (error) {
    log(`gagal (percobaan ${job.attempts}/${job.maxAttempts}): ${(error as Error).message}`)
    await finish(job, error as Error)
  }
}

/** Jalankan satu job berulang sekarang juga (dipakai admin & test), tanpa menunggu jadwal. */
export const runNow = async (type: string) => {
  const handler = handlers.get(type)
  if (!handler) throw new Error(`Unknown job type ${type}`)
  const log = (msg: string) => console.log(`[job ${type} manual] ${msg}`)
  return handler({}, { jobId: 'manual', attempt: 0, log })
}

let timer: ReturnType<typeof setTimeout> | undefined
let running = false

export const startJobRunner = async () => {
  if (!env.jobsEnabled) {
    console.log('🕒 job runner nonaktif (JOBS_ENABLED=false)')
    return
  }
  await ensureRecurring()

  const tick = async () => {
    if (running) return
    running = true
    try {
      // habiskan antrean yang sudah jatuh tempo, lalu tidur
      for (;;) {
        const job = await claimOne()
        if (!job) break
        await runOne(job)
      }
    } catch (error) {
      console.error('[jobs]', (error as Error).message)
    } finally {
      running = false
      timer = setTimeout(tick, env.jobsPollMs)
    }
  }
  console.log(`🕒 job runner aktif (${WORKER_ID}), berulang: ${[...recurring.keys()].join(', ') || '-'}`)
  void tick()
}

export const stopJobRunner = () => {
  if (timer) clearTimeout(timer)
  timer = undefined
}

export const listJobs = () =>
  db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      runAt: jobs.runAt,
      attempts: jobs.attempts,
      lockedBy: jobs.lockedBy,
      lastError: jobs.lastError,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .orderBy(sql`case ${jobs.status} when 'processing' then 0 when 'queued' then 1 when 'dead' then 2 else 3 end`, jobs.runAt)
    .limit(100)
