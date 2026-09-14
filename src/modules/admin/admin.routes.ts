import { Elysia, t } from 'elysia'
import { listJobs, runNow } from '../../jobs/runner.ts'
import { authPlugin } from '../../plugins/auth.ts'

export const adminRoutes = new Elysia({ prefix: '/admin', tags: ['Admin'] })
  .use(authPlugin)
  .get('/jobs', () => listJobs(), {
    auth: 'admin',
    detail: { summary: 'Antrean job: berulang, tertunda, gagal' },
  })
  .post(
    '/jobs/:type/run',
    async ({ params }) => ({ type: params.type, result: await runNow(params.type) }),
    {
      auth: 'admin',
      params: t.Object({ type: t.String() }),
      detail: {
        summary: 'Jalankan job berulang sekarang (tanpa menunggu jadwal)',
        description: 'Contoh: `tasks.expire`, `maintenance.cleanup`.',
      },
    },
  )
