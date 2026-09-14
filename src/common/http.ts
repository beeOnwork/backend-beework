import { t } from 'elysia'

export const paginationQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
})

export type Pagination = { page: number; limit: number; offset: number }

export const resolvePagination = (query: { page?: number; limit?: number }): Pagination => {
  const page = query.page ?? 1
  const limit = query.limit ?? 20
  return { page, limit, offset: (page - 1) * limit }
}

export const paginated = <T>(data: T[], total: number, { page, limit }: Pagination) => ({
  data,
  meta: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    hasNext: page * limit < total,
  },
})
