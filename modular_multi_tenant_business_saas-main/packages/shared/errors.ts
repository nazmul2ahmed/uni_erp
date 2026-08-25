/**
 * Canonical error codes -> HTTP status mapping.
 * Per 11_API_SPECIFICATION.md §3 (completes 04 §38).
 * Phase 1 subset only — full catalog grows as later phases land.
 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  AUTHENTICATION_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  TENANT_ACCESS_DENIED: 403,
  TENANT_SUSPENDED: 403,
  USER_NOT_FOUND: 404,
  MEMBERSHIP_NOT_FOUND: 404,
  EMAIL_ALREADY_REGISTERED: 409,
  INVALID_CREDENTIALS: 401,
  OWNER_TRANSFER_REQUIRED: 409, // per 05 §75a, Decision TEN-001, INV-OWN-003
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

/**
 * Standard API response envelope, per 04 §37.
 */
export function successEnvelope<T>(data: T, requestId: string) {
  return { success: true as const, data, meta: { requestId } };
}

export function errorEnvelope(error: AppError, requestId: string) {
  return {
    success: false as const,
    error: { code: error.code, message: error.message, details: error.details ?? {} },
    requestId,
  };
}
