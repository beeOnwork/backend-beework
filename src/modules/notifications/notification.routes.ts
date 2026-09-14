import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { paginationQuery, resolvePagination } from '../../common/http.ts'
import { db } from '../../db/index.ts'
import { notifications } from '../../db/schema/index.ts'
import { authPlugin } from '../../plugins/auth.ts'

export const notificationRoutes = new Elysia({ prefix: '/notifications', tags: ['Notifications'] })
  .use(authPlugin)
  .get(
    '/',
    ({ user, query }) => {
      const page = resolvePagination(query)
      return db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, user.id),
            query.unreadOnly ? isNull(notifications.readAt) : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(page.limit)
        .offset(page.offset)
    },
    {
      auth: true,
      query: t.Composite([paginationQuery, t.Object({ unreadOnly: t.Optional(t.Boolean()) })]),
    },
  )
  .get(
    '/unread-count',
    async ({ user }) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
      return { count: row?.count ?? 0 }
    },
    { auth: true },
  )
  .post(
    '/read',
    async ({ user, body }) => {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.userId, user.id),
            body.ids?.length
              ? sql`${notifications.id} = any(${body.ids})`
              : isNull(notifications.readAt),
          ),
        )
      return { success: true }
    },
    {
      auth: true,
      body: t.Object({ ids: t.Optional(t.Array(t.String({ format: 'uuid' }))) }),
      detail: { summary: 'Tandai terbaca (kosongkan ids untuk semua)' },
    },
  )
