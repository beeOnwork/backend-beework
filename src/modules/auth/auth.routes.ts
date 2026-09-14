import { Elysia, t } from 'elysia'
import { authPlugin } from '../../plugins/auth.ts'
import { clientIp, limits, rateLimitPlugin } from '../../plugins/rate-limit.ts'
import { captchaConfig, verifyCaptcha } from '../../services/captcha.service.ts'
import * as service from './auth.service.ts'
import { loginWithPrivy } from './privy.service.ts'

const usernameSchema = t.String({ minLength: 3, maxLength: 39, pattern: '^[a-zA-Z0-9_-]+$' })

export const authRoutes = new Elysia({ prefix: '/auth', tags: ['Auth'] })
  .use(authPlugin)
  .use(rateLimitPlugin)
  .get('/captcha', () => captchaConfig(), {
    detail: { summary: 'Provider & site key captcha untuk widget pendaftaran' },
  })
  .post(
    '/register',
    async ({ body, jwt, request, server, set }) => {
      // Dicek sebelum hash argon2 & insert — pekerjaan mahal hanya untuk manusia.
      await verifyCaptcha(body.captchaToken, {
        remoteIp: clientIp(request, server?.requestIP(request)?.address),
        action: 'register',
      })
      const { captchaToken: _captcha, ...input } = body
      const user = await service.register(input)
      const refreshToken = await service.issueRefreshToken(user.id, {
        userAgent: request.headers.get('user-agent') ?? undefined,
        ip: server?.requestIP(request)?.address,
      })
      set.status = 201
      return {
        user: service.privateUser(user),
        accessToken: await jwt.sign({ sub: user.id, typ: 'access', role: user.role }),
        refreshToken,
      }
    },
    {
      rateLimit: limits.register,
      body: t.Object({
        username: usernameSchema,
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 8, maxLength: 128 }),
        displayName: t.Optional(t.String({ maxLength: 120 })),
        referralCode: t.Optional(t.String({ maxLength: 32 })),
        /** token dari widget captcha; wajib bila GET /auth/captcha → enabled */
        captchaToken: t.Optional(t.String({ maxLength: 4096 })),
      }),
      detail: {
        summary: 'Daftar akun baru',
        description:
          'Kalau `GET /auth/captcha` mengembalikan `enabled: true`, sertakan `captchaToken` ' +
          'dari widget. Tanpa token → 400 CAPTCHA_REQUIRED; token tidak sah → 403 CAPTCHA_FAILED.',
      },
    },
  )
  .post(
    '/login',
    async ({ body, jwt, request, server }) => {
      const user = await service.verifyCredentials(body.identifier, body.password)
      const refreshToken = await service.issueRefreshToken(user.id, {
        userAgent: request.headers.get('user-agent') ?? undefined,
        ip: server?.requestIP(request)?.address,
      })
      return {
        user: service.privateUser(user),
        accessToken: await jwt.sign({ sub: user.id, typ: 'access', role: user.role }),
        refreshToken,
      }
    },
    {
      rateLimit: limits.login,
      body: t.Object({
        identifier: t.String({ minLength: 3 }),
        password: t.String({ minLength: 1 }),
      }),
      detail: { summary: 'Login dengan username/email + password' },
    },
  )
  .post(
    '/refresh',
    async ({ body, jwt, request, server }) => {
      const { userId, refreshToken } = await service.rotateRefreshToken(body.refreshToken, {
        userAgent: request.headers.get('user-agent') ?? undefined,
        ip: server?.requestIP(request)?.address,
      })
      const user = await service.getUserById(userId)
      return {
        accessToken: await jwt.sign({ sub: user.id, typ: 'access', role: user.role }),
        refreshToken,
      }
    },
    {
      rateLimit: limits.refresh,
      body: t.Object({ refreshToken: t.String() }),
      detail: { summary: 'Tukar refresh token (rotasi)' },
    },
  )
  .post(
    '/logout',
    async ({ body }) => {
      await service.revokeRefreshToken(body.refreshToken)
      return { success: true }
    },
    { body: t.Object({ refreshToken: t.String() }) },
  )
  .post(
    '/privy',
    async ({ body, jwt, request, server, set }) => {
      const { user, isNew } = await loginWithPrivy(body)
      const refreshToken = await service.issueRefreshToken(user.id, {
        userAgent: request.headers.get('user-agent') ?? undefined,
        ip: server?.requestIP(request)?.address,
      })
      set.status = isNew ? 201 : 200
      return {
        user: service.privateUser(user),
        accessToken: await jwt.sign({ sub: user.id, typ: 'access', role: user.role }),
        refreshToken,
        isNewUser: isNew,
      }
    },
    {
      rateLimit: limits.privy,
      body: t.Object({
        /**
         * Field `token` dari respons Privy (aud = app id kita).
         * Bukan `privy_access_token`, yang audience-nya auth.privy.io.
         */
        token: t.String({ minLength: 20 }),
        referralCode: t.Optional(t.String({ maxLength: 32 })),
      }),
      detail: {
        summary: 'Login/daftar dengan Privy (email + embedded Solana wallet)',
        description:
          'Kirim field `token` dari respons login Privy. Email dan alamat wallet ' +
          'diambil dari API Privy, bukan dari body, sehingga tidak bisa dipalsukan. ' +
          'Balas 201 kalau akun baru dibuat, 200 kalau login akun yang sudah ada.',
      },
    },
  )
  .get('/me', ({ user }) => service.getUserById(user.id).then(service.privateUser), {
    auth: true,
    detail: { summary: 'Profil user yang sedang login' },
  })
