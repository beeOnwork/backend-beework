import { bearer } from '@elysiajs/bearer'
import { jwt } from '@elysiajs/jwt'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { Forbidden, Unauthorized } from '../common/errors.ts'
import { env } from '../config/env.ts'
import { db } from '../db/index.ts'
import { users } from '../db/schema/index.ts'

export type AuthUser = {
  id: string
  username: string
  role: 'user' | 'moderator' | 'admin'
  status: 'active' | 'suspended' | 'banned' | 'deleted'
  isVerified: boolean
}

const loadUser = async (token: string | undefined, verify: (t: string) => Promise<unknown>) => {
  if (!token) return null
  const payload = (await verify(token)) as { sub?: string; typ?: string } | false
  if (!payload || payload.typ !== 'access' || !payload.sub) return null

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      status: users.status,
      isVerified: users.isVerified,
    })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1)

  return (row as AuthUser | undefined) ?? null
}

export const authPlugin = new Elysia({ name: 'auth' })
  .use(bearer())
  .use(jwt({ name: 'jwt', secret: env.jwtSecret, exp: env.accessTtl }))
  .derive({ as: 'scoped' }, async ({ bearer: token, jwt }) => ({
    /** user opsional — dipakai endpoint publik yang perilakunya berbeda saat login */
    currentUser: await loadUser(token, jwt.verify),
  }))
  .macro({
    /** `{ auth: true }` mewajibkan login; `{ auth: 'admin' }` mewajibkan role admin */
    auth: (mode: boolean | 'verified' | 'moderator' | 'admin') => ({
      resolve({ currentUser }) {
        if (!mode) return { user: currentUser as AuthUser }
        if (!currentUser) throw Unauthorized()
        if (currentUser.status !== 'active') throw Forbidden(`Account is ${currentUser.status}`)
        if (mode === 'verified' && !currentUser.isVerified)
          throw Forbidden('Account verification required')
        if (mode === 'admin' && currentUser.role !== 'admin') throw Forbidden('Admin only')
        if (mode === 'moderator' && currentUser.role === 'user') throw Forbidden('Moderator only')
        return { user: currentUser }
      },
    }),
  })
