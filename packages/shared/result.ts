/**
 * Result<T, E> — success/failure without throwing, for EXPECTED
 * business-rule violations. Per 07_CORE_DOMAIN_SPECIFICATION.md §2, §18.
 *
 * Unexpected failures (infra errors, unanticipated constraint violations)
 * still propagate as exceptions per 07 §18 — this type is only for
 * anticipated domain/application-layer failures.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok === true;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return r.ok === false;
}
