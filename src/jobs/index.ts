import { expireTasksHandler } from './handlers/expire-tasks.ts'
import { maintenanceHandler } from './handlers/maintenance.ts'
import { reconcileFromGhost } from '../services/evm/ghost.service.ts'
import { registerRecurring, startJobRunner, stopJobRunner } from './runner.ts'

const MIN = 60_000

/** Daftar job berulang. Interval = jeda setelah eksekusi sebelumnya selesai. */
registerRecurring('tasks.expire', 1 * MIN, expireTasksHandler)
registerRecurring('maintenance.cleanup', 60 * MIN, maintenanceHandler)
/** sumber event kedua; no-op kalau GHOST_GRAPHQL_URL kosong */
registerRecurring('evm.ghost-reconcile', 1 * MIN, (_, ctx) => reconcileFromGhost(ctx.log))

export { startJobRunner, stopJobRunner }
