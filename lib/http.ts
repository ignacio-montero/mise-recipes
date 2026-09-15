// The single error envelope from docs/API_SPEC.md §1. Routes throw ApiError and
// let `handle()` shape the response, so no route hand-rolls its own error JSON.
import { NextResponse } from "next/server";
import type { ApiErrorCode } from "./types";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400, unauthorized: 401, not_found: 404, conflict: 409,
  unsupported_source: 422, extraction_failed: 422, not_a_recipe: 422,
  rate_limited: 429, internal: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message }, ...(e.extra ?? {}) },
      { status: STATUS[e.code] },
    );
  }
  console.error("[api] unhandled", e);
  return NextResponse.json(
    { error: { code: "internal", message: "Something went wrong." } },
    { status: 500 },
  );
}

/** Wrap a route handler so any thrown ApiError becomes the standard envelope. */
export function handle<A extends unknown[]>(
  fn: (...args: A) => Promise<NextResponse>,
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ApiError("bad_request", `\`${field}\` must be a non-empty string.`);
  }
  return v.trim();
}
