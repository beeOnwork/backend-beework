import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'
import { env } from './config/env.ts'
import { sql } from './db/index.ts'
import { adminRoutes } from './modules/admin/admin.routes.ts'
import { authRoutes } from './modules/auth/auth.routes.ts'
import { catalogRoutes } from './modules/catalog/catalog.routes.ts'
import { notificationRoutes } from './modules/notifications/notification.routes.ts'
import { onchainRoutes } from './modules/onchain/onchain.routes.ts'
import { referralRoutes } from './modules/referrals/referral.routes.ts'
import { submissionRoutes } from './modules/submissions/submission.routes.ts'
import { taskRoutes } from './modules/tasks/task.routes.ts'
import { userRoutes } from './modules/users/user.routes.ts'
import { walletRoutes } from './modules/wallet/wallet.routes.ts'
import { errorPlugin } from './plugins/error.ts'
import { globalRateLimit } from './plugins/rate-limit.ts'

export const app = new Elysia()
  .use(errorPlugin)
  .use(cors())
  // batas global per IP, sebelum routing & parsing body — murah untuk menahan flood
  .onRequest(({ request, server, set }) =>
    globalRateLimit(request, server?.requestIP(request)?.address, set.headers as Record<string, string>),
  )
  .use(
    swagger({
      path: '/docs',
      documentation: {
        info: {
          title: `${env.appName} API`,
          version: '0.1.0',
          description:
            'Backend marketplace task & bounty. Semua nominal dinyatakan dalam base unit token (lihat `decimals` pada /assets).',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
    }),
  )
  .get('/health', async () => {
    const start = performance.now()
    await sql`select 1`
    return {
      status: 'ok',
      uptime: process.uptime(),
      db: { ok: true, latencyMs: Math.round(performance.now() - start) },
    }
  })
  .group('/api/v1', (api) =>
    api
      .use(authRoutes)
      .use(userRoutes)
      .use(catalogRoutes)
      .use(taskRoutes)
      .use(submissionRoutes)
      .use(walletRoutes)
      .use(referralRoutes)
      .use(notificationRoutes)
      .use(onchainRoutes)
      .use(adminRoutes),
  )

export type App = typeof app
