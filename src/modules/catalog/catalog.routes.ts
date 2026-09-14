import { asc, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db } from '../../db/index.ts'
import { assets, categories, tags } from '../../db/schema/index.ts'

export const catalogRoutes = new Elysia({ tags: ['Catalog'] })
  .get(
    '/assets',
    () =>
      db
        .select({
          id: assets.id,
          symbol: assets.symbol,
          name: assets.name,
          chain: assets.chain,
          mintAddress: assets.mintAddress,
          decimals: assets.decimals,
          logoUrl: assets.logoUrl,
          isStable: assets.isStable,
        })
        .from(assets)
        .where(eq(assets.isActive, true))
        .orderBy(asc(assets.symbol)),
    { detail: { summary: 'Token yang bisa dipakai sebagai reward' } },
  )
  .get(
    '/categories',
    () =>
      db
        .select()
        .from(categories)
        .where(eq(categories.isActive, true))
        .orderBy(asc(categories.sortOrder)),
    { detail: { summary: 'Kategori task' } },
  )
  .get('/tags', () => db.select().from(tags).orderBy(asc(tags.name)), {
    detail: { summary: 'Tag/skill' },
  })
