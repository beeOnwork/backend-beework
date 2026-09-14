import { t } from 'elysia'

/** Amplop error nyata dari plugins/error.ts: { error: { code, message, details? } }. */
export const errorSchema = (description: string) =>
  t.Object(
    {
      error: t.Object({
        code: t.String(),
        message: t.String(),
        details: t.Optional(t.Any()),
      }),
    },
    { description },
  )

export const commonErrors = {
  400: errorSchema('Bad request'),
  401: errorSchema('Authentication required'),
  403: errorSchema('Forbidden'),
  404: errorSchema('Not found'),
  409: errorSchema('Conflict'),
  422: errorSchema('Validation or business-rule error'),
}

/** Amplop pagination nyata dari common/http.ts `paginated()`. */
export const pageMeta = t.Object({
  page: t.Number(),
  limit: t.Number(),
  total: t.Optional(t.Number()),
  totalPages: t.Optional(t.Number()),
  hasNext: t.Optional(t.Boolean()),
})

export const pageOf = (item: ReturnType<typeof t.Object> | ReturnType<typeof t.Any>) =>
  t.Object({ data: t.Array(item), meta: pageMeta })

const nullable = (schema: ReturnType<typeof t.String> | ReturnType<typeof t.Number>) =>
  t.Optional(t.Union([schema, t.Null()]))

/** Baris penuh tabel `tasks`, seperti yang dikembalikan create/publish/cancel dan bersarang di detail. */
export const taskSchema = t.Object({
  id: t.String(),
  publicId: t.String(),
  type: t.Union([t.Literal('task'), t.Literal('bounty'), t.Literal('quest')]),
  title: t.String(),
  description: t.Optional(t.String()),
  ownerId: t.Optional(t.String()),
  categoryId: nullable(t.String()),
  visibility: t.Optional(t.String()),
  privateToken: nullable(t.String()),
  status: t.String(),
  rewardAssetId: t.Optional(t.String()),
  rewardAmount: t.String(),
  platformFeeAmount: t.Optional(t.String()),
  maxWinners: t.Optional(t.Number()),
  winnersCount: t.Optional(t.Number()),
  requiresVerified: t.Optional(t.Boolean()),
  autoApprove: t.Optional(t.Boolean()),
  allowMultipleSubmissions: t.Optional(t.Boolean()),
  onchainTaskId: nullable(t.String()),
  githubRepo: nullable(t.String()),
  githubIssueNumber: nullable(t.Number()),
  githubIssueUrl: nullable(t.String()),
  deadlineAt: t.Optional(t.Union([t.String(), t.Null()])),
  requirements: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
  viewCount: t.Optional(t.Number()),
  submissionCount: t.Optional(t.Number()),
  applicationCount: t.Optional(t.Number()),
  metadata: t.Optional(t.Any()),
  publishedAt: t.Optional(t.Union([t.String(), t.Null()])),
  completedAt: t.Optional(t.Union([t.String(), t.Null()])),
  cancelledAt: t.Optional(t.Union([t.String(), t.Null()])),
  deletedAt: t.Optional(t.Union([t.String(), t.Null()])),
  createdAt: t.String(),
  updatedAt: t.Optional(t.String()),
})

/** Baris ringkas `/tasks/` (feed publik) dan `/tasks/mine` — kolom trimmed, tanpa `description`. */
export const taskListItemSchema = t.Object({
  id: t.String(),
  publicId: t.String(),
  type: t.String(),
  title: t.String(),
  status: t.String(),
  visibility: t.Optional(t.String()),
  rewardAmount: t.String(),
  maxWinners: t.Optional(t.Number()),
  winnersCount: t.Optional(t.Number()),
  requiresVerified: t.Optional(t.Boolean()),
  deadlineAt: t.Optional(t.Union([t.String(), t.Null()])),
  publishedAt: t.Optional(t.Union([t.String(), t.Null()])),
  submissionCount: t.Optional(t.Number()),
  viewCount: t.Optional(t.Number()),
  createdAt: t.String(),
  // Hanya ada di `/tasks/` (feed publik); `/tasks/mine` tidak menyertakan join ini.
  owner: t.Optional(t.Object({ id: t.String(), username: t.String(), avatarUrl: t.Union([t.String(), t.Null()]) })),
  category: t.Optional(t.Union([t.Object({ slug: t.String(), name: t.String() }), t.Null()])),
  asset: t.Optional(t.Object({ symbol: t.String(), decimals: t.Number(), logoUrl: t.Union([t.String(), t.Null()]) })),
})

/** `GET /tasks/:id` — baris plus join owner/asset/category, tidak digabung jadi satu objek. */
export const taskDetailSchema = t.Object({
  task: taskSchema,
  owner: t.Object({
    id: t.String(),
    username: t.String(),
    displayName: t.Union([t.String(), t.Null()]),
    avatarUrl: t.Union([t.String(), t.Null()]),
    isVerified: t.Boolean(),
  }),
  asset: t.Object({ id: t.String(), symbol: t.String(), decimals: t.Number() }),
  category: t.Union([t.Object({ slug: t.String(), name: t.String() }), t.Null()]),
})

/** `POST /tasks/` — `onchain` longgar (`t.Any`) karena isinya hasil spread `publicConfig()` yang dinamis. */
export const createTaskResultSchema = t.Object({
  task: taskSchema,
  fee: t.String(),
  totalRequired: t.String(),
  escrowMode: t.Union([t.Literal('onchain'), t.Literal('ledger')]),
  onchain: t.Optional(t.Union([t.Any(), t.Null()])),
})

export const apiUserSchema = t.Object({
  id: t.String(),
  username: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  avatarUrl: t.Union([t.String(), t.Null()]),
  bio: t.Union([t.String(), t.Null()]),
  role: t.String(),
  isVerified: t.Boolean(),
  reputationScore: t.Optional(t.Number()),
  tasksCreatedCount: t.Optional(t.Number()),
  tasksCompletedCount: t.Optional(t.Number()),
  totalEarnedUsd: t.Optional(t.Union([t.String(), t.Null()])),
  createdAt: t.String(),
  email: t.Optional(t.Union([t.String(), t.Null()])),
  emailVerifiedAt: t.Optional(t.Union([t.String(), t.Null()])),
  phone: t.Optional(t.Union([t.String(), t.Null()])),
  phoneVerifiedAt: t.Optional(t.Union([t.String(), t.Null()])),
  country: t.Optional(t.Union([t.String(), t.Null()])),
  status: t.Optional(t.String()),
  referralCode: t.Optional(t.String()),
})

export const authResultSchema = t.Object({
  user: apiUserSchema,
  accessToken: t.String(),
  refreshToken: t.String(),
  isNewUser: t.Optional(t.Boolean()),
})

export const submissionSchema = t.Object({
  id: t.String(),
  taskId: t.String(),
  userId: t.String(),
  content: t.Optional(t.Union([t.String(), t.Null()])),
  links: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
  githubPrUrl: t.Optional(t.Union([t.String(), t.Null()])),
  status: t.String(),
  reviewNote: t.Optional(t.Union([t.String(), t.Null()])),
  reviewedAt: t.Optional(t.Union([t.String(), t.Null()])),
  payoutAmount: t.Optional(t.Union([t.String(), t.Null()])),
  rank: t.Optional(t.Union([t.Number(), t.Null()])),
  revisionCount: t.Optional(t.Number()),
  createdAt: t.String(),
  updatedAt: t.Optional(t.String()),
})
