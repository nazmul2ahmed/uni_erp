/**
 * Canonical error codes -> HTTP status mapping.
 * Per 11_API_SPECIFICATION.md §3 (completes 04 §38).
 * Phase 1 subset only — full catalog grows as later phases land.
 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  // Decision EXP-005: a posted business fact can be reversed at most once.
  ALREADY_REVERSED: 409,
  AUTHENTICATION_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  // Decision SEC-008: the account still uses a one-time password; only changing it is allowed.
  PASSWORD_CHANGE_REQUIRED: 403,
  TENANT_ACCESS_DENIED: 403,
  TENANT_SUSPENDED: 403,
  USER_NOT_FOUND: 404,
  MEMBERSHIP_NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  RETURN_QTY_EXCEEDED: 409,
  INSUFFICIENT_STOCK: 409,
  // Per 11 §3 catalog + 07 §7.5a DiscountThresholdPolicy (Decision
  // DOM-006). 403, not 409 — this is a permission-boundary rejection
  // (the actor lacks sales.discount.override), not a resource-state
  // conflict, mirroring PERMISSION_DENIED's status code for the same
  // reason.
  DISCOUNT_EXCEEDED: 403,
  // 30_MODULE_VAN_SALES.md §4.2 steps 3-4 (Decisions VAN-009/VAN-008).
  // 409, not 403 — both are resource-state conflicts (an existing
  // assignment blocks a new one), the same status-code reasoning as
  // RETURN_QTY_EXCEEDED/INSUFFICIENT_STOCK above, not a permission
  // boundary (ASSIGNMENT_OVERDUE can itself be BYPASSED by a
  // permission, but the rejection itself is about assignment STATE).
  ASSIGNMENT_ALREADY_ACTIVE: 409,
  ASSIGNMENT_OVERDUE: 409,
  // Generic conditional-uniqueness violation (Postgres 23505 on a
  // partial unique index), per 06 v2.0 §5.4-§5.6's phone/sku
  // conditional UNIQUE constraints. Introduced in Phase 2 (Customer/
  // Supplier/Item CRUD) — generalized the same way RESOURCE_NOT_FOUND
  // was generalized above, rather than adding a per-entity
  // DUPLICATE_PHONE/DUPLICATE_SKU code for what is structurally the
  // same failure class across entities.
  DUPLICATE_RESOURCE: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  INVALID_CREDENTIALS: 401,
  OWNER_TRANSFER_REQUIRED: 409,
  // Per 11 §3: "should never surface — internal invariant." Thrown by
  // lib/accounting.ts's postJournal() if debit != credit; every named
  // posting-rule wrapper is constructed to make this unreachable in
  // practice (08 §11 INV-ACC-001) — it exists as defense-in-depth, not
  // an expected business-rule rejection a client should ever render.
  UNBALANCED_JOURNAL: 500,
  PERIOD_LOCKED: 409,
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