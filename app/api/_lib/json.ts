// Request-body plumbing shared by every write route. Lives under `app/api/_lib`
// (an underscore folder is invisible to the App Router) rather than in `lib/`,
// because this is HTTP-shaped concern, not domain logic.
import { ApiError } from "@/lib/http";

/** A malformed or absent body is a client mistake, not a 500. Routes that take
 *  no body (POST /cooked) get `{}` instead of an exception. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    throw new ApiError("bad_request", "Could not read the request body.");
  }
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("bad_request", "Body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError("bad_request", "Body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Reject unknown keys with an ALLOWLIST: a blocklist silently accepts whatever
 *  the next schema change adds, and typos like `favourite` would vanish into
 *  the void instead of telling the caller they did nothing. */
export function assertAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ApiError(
      "bad_request",
      `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}

export function asNullableString(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new ApiError("bad_request", `\`${field}\` must be a string or null.`);
  const t = v.trim();
  return t === "" ? null : t;
}

export function asNullableInt(
  v: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ApiError("bad_request", `\`${field}\` must be an integer or null.`);
  }
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  if (v < min || v > max) {
    throw new ApiError("bad_request", `\`${field}\` must be between ${min} and ${max}.`);
  }
  return v;
}

export function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ApiError("bad_request", `\`${field}\` must be a boolean.`);
  return v;
}

export function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new ApiError("bad_request", `\`${field}\` must be an array of strings.`);
  return v.map((s, i) => {
    if (typeof s !== "string") {
      throw new ApiError("bad_request", `\`${field}[${i}]\` must be a string.`);
    }
    return s.trim();
  }).filter((s) => s !== "");
}
