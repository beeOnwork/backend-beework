export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const BadRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details)
export const Unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message)
export const Forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message)
export const NotFound = (resource = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${resource} not found`)
export const Conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details)
export const UnprocessableEntity = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE_ENTITY', message, details)
export const TooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message)
export const InsufficientFunds = (message = 'Insufficient balance') =>
  new AppError(422, 'INSUFFICIENT_FUNDS', message)
