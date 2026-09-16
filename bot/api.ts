// Client for Mise's own HTTP API (docs/API_SPEC.md §2 and §3).
//
// The bot is a "dumb transport" (ARCHITECTURE §1): it owns no extraction logic
// and no database handle — it turns Telegram messages into these HTTP calls and
// renders what comes back. That is why this file exists instead of the bot
// importing `lib/extract` or Prisma directly: ONE implementation of "import
// this URL" serves both the bot and the web paste box, so the two can't drift.

import type { ImportJobDTO, RecipeDTO } from "../lib/types";

export class MiseApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "MiseApiError";
  }
}

/**
 * A **discriminated union** rather than a nullable field: 409-already-saved is
 * a perfectly normal outcome of an import, not a failure, and the caller must
 * be forced to handle it. `if (res.kind === "duplicate")` is checked by the
 * compiler; `if (res.recipeId)` would not be.
 */
export type CreateImportResult =
  | { kind: "enqueued"; id: string }
  | { kind: "duplicate"; recipeId: string | null };

type ErrorEnvelope = {
  error?: { code?: string; message?: string };
  recipeId?: string;
};

export type MiseApiOptions = {
  baseUrl: string;
  ingestToken: string;
  timeoutMs?: number;
};

export class MiseApi {
  private readonly base: string;
  private readonly ingestToken: string;
  private readonly timeoutMs: number;

  constructor(opts: MiseApiOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.ingestToken = opts.ingestToken;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { rawErrors?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      // No secret can appear here: the token travels in a header, never the URL.
      throw new MiseApiError(`${path} unreachable — ${msg}`);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok && !init.rawErrors) {
      const env = (body ?? {}) as ErrorEnvelope;
      throw new MiseApiError(
        env.error?.message ?? `HTTP ${res.status}`,
        res.status,
        env.error?.code ?? null,
      );
    }
    return { status: res.status, body: body as T };
  }

  /**
   * `POST /api/imports` — returns as soon as the job is queued (202), it does
   * NOT wait for extraction. That is the whole reason the bot posts a
   * `⏳ Importing…` message first and edits it later: a 25 s synchronous HTTP
   * call would time out somewhere in the chain and give the user nothing.
   *
   * Deliberately NOT retried on failure. `POST` is not idempotent in general,
   * and a silent retry could enqueue the same URL twice; the user gets a
   * visible error instead and can re-send the link.
   */
  async createImport(input: {
    url: string;
    chatId: string | number;
    messageId: number;
    text?: string;
  }): Promise<CreateImportResult> {
    const { status, body } = await this.request<{ id?: string } & ErrorEnvelope>(
      "/api/imports",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Defence in depth (ARCHITECTURE §5): the web app has no auth, but
          // off-page enqueueing needs this shared secret, so a stray request on
          // the Docker network cannot make the box download videos.
          "x-mise-token": this.ingestToken,
        },
        body: JSON.stringify({
          url: input.url,
          source: "telegram",
          chatId: String(input.chatId),
          messageId: input.messageId,
          ...(input.text ? { text: input.text } : {}),
        }),
        rawErrors: true,
      },
    );

    if (status === 409) return { kind: "duplicate", recipeId: body?.recipeId ?? null };
    if (status >= 400 || !body?.id) {
      throw new MiseApiError(
        body?.error?.message ?? `HTTP ${status}`,
        status,
        body?.error?.code ?? null,
      );
    }
    return { kind: "enqueued", id: body.id };
  }

  /** `GET /api/imports/:id` — one poll of a job's progress. */
  async getImport(id: string): Promise<ImportJobDTO> {
    const { body } = await this.request<ImportJobDTO>(
      `/api/imports/${encodeURIComponent(id)}`,
    );
    return body;
  }

  /** `GET /api/recipes` — newest first by default (`sort=recent`). */
  async listRecipes(limit = 5): Promise<RecipeDTO[]> {
    const { body } = await this.request<{ recipes: RecipeDTO[] }>(
      `/api/recipes?sort=recent&limit=${limit}`,
    );
    return body?.recipes ?? [];
  }

  /** `GET /api/recipes?q=…` — the same free-text search the PWA uses. */
  async searchRecipes(query: string, limit = 5): Promise<RecipeDTO[]> {
    const { body } = await this.request<{ recipes: RecipeDTO[] }>(
      `/api/recipes?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    return body?.recipes ?? [];
  }

  /**
   * `GET /api/recipes/:id` — only used to put a *title* in the
   * "📖 Already saved" reply, since the 409 envelope carries just `recipeId`.
   * Failure here is non-fatal: the caller falls back to a title-less message.
   */
  async getRecipe(id: string): Promise<RecipeDTO> {
    const { body } = await this.request<{ recipe: RecipeDTO }>(
      `/api/recipes/${encodeURIComponent(id)}`,
    );
    return body.recipe;
  }
}
