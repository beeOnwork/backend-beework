import { Elysia } from 'elysia'
import { AppError } from '../common/errors.ts'
import { env } from '../config/env.ts'

export const errorPlugin = new Elysia({ name: 'error' })
  .error({ APP_ERROR: AppError })
  .onError({ as: 'global' }, ({ code, error, set, path }) => {
    // `instanceof`, bukan `code === 'APP_ERROR'`: registrasi .error() tidak
    // selalu merambat ke plugin anak, sehingga 403/409 bisa bocor jadi 500.
    if (error instanceof AppError) {
      set.status = error.status
      return { error: { code: error.code, message: error.message, details: error.details } }
    }

    if (code === 'VALIDATION') {
      set.status = 422
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.all,
        },
      }
    }

    if (code === 'NOT_FOUND') {
      set.status = 404
      return { error: { code: 'NOT_FOUND', message: `Route ${path} not found` } }
    }

    if (code === 'PARSE') {
      set.status = 400
      return { error: { code: 'INVALID_BODY', message: 'Malformed request body' } }
    }

    // Drizzle membungkus error Postgres jadi "Failed query: ..." dan menaruh
    // penyebab aslinya di `cause` — tanpa ini penyebabnya tidak pernah terlihat.
    const cause = (error as { cause?: unknown }).cause as
      | { code?: string; message?: string; detail?: string; constraint_name?: string }
      | undefined
    const pgError = (error as { code?: string }).code ? (error as never) : cause
    const pgCode = (pgError as { code?: string } | undefined)?.code

    if (pgCode === '23505') {
      set.status = 409
      return {
        error: {
          code: 'CONFLICT',
          message: 'Resource already exists',
          ...(env.isProd ? {} : { constraint: (pgError as { constraint_name?: string }).constraint_name }),
        },
      }
    }
    if (pgCode === '23503') {
      set.status = 422
      return { error: { code: 'FOREIGN_KEY_VIOLATION', message: 'Referenced resource does not exist' } }
    }

    console.error(`[${code}] ${path}`, error, cause ? `\n  caused by: ${cause.message}` : '')
    set.status = 500
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong',
        ...(env.isProd
          ? {}
          : {
              debug: (error as Error).message,
              cause: cause?.message,
              pgCode,
            }),
      },
    }
  })
