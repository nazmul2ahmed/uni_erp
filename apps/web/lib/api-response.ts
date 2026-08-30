import { NextResponse } from "next/server";
import { AppError, successEnvelope, errorEnvelope } from "@erp/shared";

/**
 * Wraps a route handler with standard envelope + error handling.
 * Per 04 §37 (response contract) — production errors never include
 * stack traces; AppError.details contains only safe, structured context.
 */
export function apiHandler(fn: () => Promise<unknown>) {
  return async () => {
    const requestId = crypto.randomUUID();
    try {
      const data = await fn();
      return NextResponse.json(successEnvelope(data, requestId));
    } catch (e) {
      if (e instanceof AppError) {
        return NextResponse.json(errorEnvelope(e, requestId), { status: e.status });
      }
      // Unexpected/infra error — never leak internals (04 §37).
      console.error(`[requestId=${requestId}]`, e);
      const internal = new AppError("INTERNAL_ERROR", "An unexpected error occurred");
      return NextResponse.json(errorEnvelope(internal, requestId), { status: 500 });
    }
  };
}
