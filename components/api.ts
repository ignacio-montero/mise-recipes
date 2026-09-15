// The one place the frontend talks to the backend.
//
// WHY A WRAPPER RATHER THAN BARE `fetch` IN EVERY COMPONENT
// --------------------------------------------------------
// The API has exactly one error envelope (API_SPEC §1):
//   { "error": { "code": "conflict", "message": "Already saved." } }
// ...sometimes with extra keys (a 409 from POST /api/imports also carries
// `recipeId`). Decoding that in ten components means ten chances to forget the
// `.error.message` unwrap and render "[object Object]" at the user. Here it is
// decoded once and thrown as a typed `ApiClientError`, so every call site can
// do `catch (e) { setError(errorMessage(e)) }` and, where it matters, branch on
// `e.code === "conflict"`.
//
// All paths are RELATIVE ("/api/recipes"). The app is same-origin, and a
// relative URL means the tailnet hostname, localhost and the container's
// internal name all work without configuration.

import type { ApiErrorCode } from "./types";

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiErrorCode | "network",
    message: string,
    readonly status: number,
    /** The whole decoded body, for the extra keys the envelope may carry
     *  (e.g. `recipeId` on a 409 from POST /api/imports). */
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Safe for any thrown value, including the ones that aren't Errors at all. */
export function errorMessage(e: unknown, fallback = "Something went wrong."): string {
  if (e instanceof ApiClientError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** True for the abort we cause ourselves when a newer request supersedes an
 *  older one — never an error worth showing. */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      // The server is the source of truth and it is one hop away on the
      // tailnet; a stale cached recipe is worse than a 20 ms round trip.
      cache: "no-store",
    });
  } catch (e) {
    if (isAbort(e)) throw e; // let callers distinguish "superseded" from "down"
    throw new ApiClientError("network", "Can't reach Mise. Is the server up?", 0);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const err = payload.error as { code?: ApiErrorCode; message?: string } | undefined;
    throw new ApiClientError(
      err?.code ?? "internal",
      err?.message ?? `Request failed (${res.status}).`,
      res.status,
      payload,
    );
  }

  return body as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

export function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export function apiDelete<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/** Build "/api/recipes?q=…&favorite=true", omitting empty params so the URL
 *  stays readable in the network tab and the server never has to special-case
 *  `q=""`. */
export function withQuery(path: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
