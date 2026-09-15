// Query-string helpers for the list endpoints.
import { ApiError } from "@/lib/http";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** A hard ceiling on `limit` is a cheap denial-of-service guard: without it one
 *  request can ask the box to serialise the entire table into memory. */
export function parseLimit(raw: string | null, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError("bad_request", "`limit` must be a positive integer.");
  }
  return Math.min(n, max);
}

/** Cursor pagination: the cursor is the id of the last row the client saw.
 *  Offset pagination (`skip=100`) is simpler but skips or repeats rows when
 *  something is inserted between two page loads — with `recent` sort and a bot
 *  inserting recipes in the background, that is the normal case here. */
export function parseCursor(raw: string | null): string | undefined {
  const c = raw?.trim();
  return c ? c : undefined;
}
