import { Elysia, t } from 'elysia'
import { paginationQuery, resolvePagination } from '../../common/http.ts'
import { authPlugin } from '../../plugins/auth.ts'
import { limits, rateLimitPlugin } from '../../plugins/rate-limit.ts'
import { resolveTaskId } from '../tasks/task.service.ts'
import * as service from './submission.service.ts'

const submissionBody = t.Object({
  content: t.Optional(t.String({ maxLength: 20_000 })),
  links: t.Optional(t.Array(t.String({ format: 'uri' }), { maxItems: 10 })),
  githubPrUrl: t.Optional(t.String({ format: 'uri' })),
})

export const submissionRoutes = new Elysia({ tags: ['Submissions'] })
  .use(authPlugin)
  .use(rateLimitPlugin)
  .post(
    '/tasks/:id/submissions',
    async ({ user, params, body, set }) => {
      set.status = 201
      return service.createSubmission(user, await resolveTaskId(params.id), body)
    },
    {
      auth: true,
      rateLimit: limits.submit,
      params: t.Object({ id: t.String() }),
      body: submissionBody,
      detail: { summary: 'Kirim hasil kerja untuk sebuah task' },
    },
  )
  .get(
    '/tasks/:id/submissions',
    async ({ user, params, query }) =>
      service.listTaskSubmissions(user, await resolveTaskId(params.id), resolvePagination(query)),
    {
      auth: true,
      params: t.Object({ id: t.String() }),
      query: paginationQuery,
      detail: { summary: 'Daftar submission (owner lihat semua, worker lihat miliknya)' },
    },
  )
  .get(
    '/submissions/mine',
    ({ user, query }) => service.listMySubmissions(user, resolvePagination(query)),
    { auth: true, query: paginationQuery, detail: { summary: 'Submission saya' } },
  )
  .post(
    '/submissions/:id/approve',
    ({ user, params, body }) => service.approveSubmission(user, params.id, body?.payoutAmount),
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Optional(
        t.Object({ payoutAmount: t.Optional(t.String({ pattern: '^[0-9]+$' })) }),
      ),
      detail: { summary: 'Setujui submission & lepaskan dana escrow' },
    },
  )
  .post(
    '/submissions/:id/review',
    ({ user, params, body }) => service.reviewSubmission(user, params.id, body),
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        status: t.Union([t.Literal('rejected'), t.Literal('needs_revision')]),
        note: t.Optional(t.String({ maxLength: 2000 })),
      }),
      detail: { summary: 'Tolak atau minta revisi' },
    },
  )
  .patch(
    '/submissions/:id',
    ({ user, params, body }) => service.reviseSubmission(user, params.id, body),
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Composite([submissionBody, t.Object({ note: t.Optional(t.String()) })]),
      detail: { summary: 'Kirim revisi (menyimpan versi sebelumnya)' },
    },
  )
