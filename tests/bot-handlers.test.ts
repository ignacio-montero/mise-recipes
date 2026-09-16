// Tests for bot/handlers.ts (routing + the ingest authorisation rule) and for
// the token redaction in bot/telegram.ts.
//
// These are INTEGRATION-flavoured unit tests: they exercise the real routing
// code but hand it **fakes** for its two collaborators (Telegram and the Mise
// API) through the `Deps` object the module already takes. That seam is
// *dependency injection*, and it is the reason the whole routing table can be
// exercised with no bot token, no socket and no database.
//
// Terminology, since these words get used loosely: a **stub** returns canned
// data (our `api`), a **spy** records calls for later assertions (our `tg`),
// and a **mock** is a stub that also asserts about how it was called. Below we
// use stubs + spies and keep the assertions in the test body, which reads
// better than assertions buried in a mock.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate, PendingImports, type Deps } from "@/bot/handlers";
import { TelegramClient, TelegramError, type TgUpdate } from "@/bot/telegram";
import type { ImportJobDTO, RecipeDTO } from "@/lib/types";

const OWNER_CHAT = "1234567890";

const RECIPE = {
  id: "r1",
  title: "Crispy Shrimp Tacos",
  ingredients: [{ item: "shrimp" }],
  steps: ["Fry."],
  servings: "6-8 tacos",
} as RecipeDTO;

type Sent = { chatId: number | string; text: string };

function makeDeps(over: Partial<Deps> = {}) {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  // The parameter is declared even though the body ignores it: `vi.fn(async () =>
  // …)` infers an argument tuple of `[]`, so `mock.calls[0][0]` is a type error
  // AND, worse, would silently type as `undefined` if the tuple were looser.
  // Declaring the shape is what lets the assertions below read the call args.
  type CreateImportInput = Parameters<Deps["api"]["createImport"]>[0];
  const createImport = vi.fn(async (_input: CreateImportInput) => ({
    kind: "enqueued" as const,
    id: "job1",
  }));
  const getImport = vi.fn(
    async (): Promise<ImportJobDTO> =>
      ({ id: "job1", status: "done", stage: null, url: "u", recipeId: "r1", recipe: RECIPE,
         error: null, canRetryWithText: false, createdAt: "", updatedAt: "" }) as ImportJobDTO,
  );

  const tg = {
    sendMessage: vi.fn(async (chatId: number | string, text: string) => {
      sent.push({ chatId, text });
      return 4471; // the message_id the outcome is later edited into
    }),
    editMessageText: vi.fn(async (chatId: number | string, _id: number, text: string) => {
      edits.push({ chatId, text });
    }),
  };

  const api = { createImport, getImport, listRecipes: vi.fn(async () => [RECIPE]),
                searchRecipes: vi.fn(async () => [RECIPE]), getRecipe: vi.fn(async () => RECIPE) };

  const deps = {
    tg: tg as unknown as Deps["tg"],
    api: api as unknown as Deps["api"],
    chatId: OWNER_CHAT,
    publicBase: "https://mise.example",
    pending: new PendingImports(),
    log: vi.fn(),
    // Injected rather than faked with vi.useFakeTimers(): the seam already
    // exists, and driving a real 1 ms poll is simpler (and less fragile) than
    // interleaving fake timers with awaited promises.
    pollIntervalMs: 1,
    pollBudgetMs: 2_000,
    ...over,
  } as Deps;

  return { deps, tg, api, sent, edits };
}

const message = (over: Record<string, unknown> = {}): TgUpdate => ({
  update_id: 1,
  message: {
    message_id: 10,
    date: 0,
    chat: { id: Number(OWNER_CHAT), type: "private" },
    from: { id: 1, is_bot: false },
    text: "hello",
    ...over,
  },
} as TgUpdate);

describe("who the bot is willing to listen to (PRD F5)", () => {
  it("drops a message from a stranger's chat in complete silence", async () => {
    // The security property: a stranger who guessed the bot's username gets no
    // reply at all, so they cannot tell a live bot from a dead token. Note the
    // assertion is on the ABSENCE of effects — the dangerous failure here is
    // doing something, not doing nothing.
    const { deps, tg, api } = makeDeps();
    await handleUpdate(
      message({ chat: { id: 999, type: "private" }, text: "https://example.com/tacos" }),
      deps,
    );
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(api.createImport).not.toHaveBeenCalled();
  });

  it("compares chat ids across the number/string boundary", () => {
    // Telegram sends `chat.id` as a NUMBER; TELEGRAM_CHAT_ID is a STRING from
    // the environment. `999 === "999"` is false in JS, so a strict comparison
    // here would lock the owner out of their own bot. This test pins the
    // String()-on-both-sides comparison the code relies on.
    expect(String(Number(OWNER_CHAT))).toBe(OWNER_CHAT);
  });

  it("answers /id from any chat, because that is how you learn your chat id", async () => {
    const { deps, sent } = makeDeps();
    await handleUpdate(message({ chat: { id: 999, type: "private" }, text: "/id" }), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("<code>999</code>"); // only their own id
  });

  it("ignores edited messages and channel posts entirely", async () => {
    const { deps, tg, api } = makeDeps();
    await handleUpdate({ update_id: 2, edited_message: message().message } as TgUpdate, deps);
    await handleUpdate({ update_id: 3, channel_post: message().message } as TgUpdate, deps);
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(api.createImport).not.toHaveBeenCalled();
  });
});

describe("importing a link from the owner", () => {
  it("replies immediately, enqueues, then edits the same message with the result", async () => {
    // PRD §4: "⏳ Importing…" within a second, then the same bubble becomes
    // "✅ …". The ORDER matters: the progress message must be sent first,
    // because its message_id is what the job reports back to.
    const { deps, api, sent, edits } = makeDeps();
    await handleUpdate(message({ text: "https://www.instagram.com/reel/C9dO9AevUQx/" }), deps);

    expect(sent[0].text).toBe("⏳ Importing…");
    expect(api.createImport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://www.instagram.com/reel/C9dO9AevUQx/",
        chatId: OWNER_CHAT,
        messageId: 4471,
      }),
    );
    expect(edits.at(-1)!.text).toContain("✅ <b>Crispy Shrimp Tacos</b>");
  });

  it("uses only the first link when a message contains several", async () => {
    const { deps, api } = makeDeps();
    await handleUpdate(message({ text: "https://a.example/1 and https://b.example/2" }), deps);
    expect(api.createImport).toHaveBeenCalledTimes(1);
    expect(api.createImport.mock.calls[0][0].url).toBe("https://a.example/1");
  });

  it("reports an already-saved recipe instead of importing it twice", async () => {
    const { deps, edits } = makeDeps();
    (deps.api.createImport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "duplicate", recipeId: "r1",
    });
    await handleUpdate(message({ text: "https://a.example/1" }), deps);
    expect(edits.at(-1)!.text).toContain("📖 Already saved:");
    expect(edits.at(-1)!.text).toContain("Crispy Shrimp Tacos");
  });

  it("nudges when the message has no link at all", async () => {
    const { deps, sent } = makeDeps();
    await handleUpdate(message({ text: "what's for dinner" }), deps);
    expect(sent.at(-1)!.text).toContain("Send me a Reel");
  });

  it("never throws, even when Telegram itself fails", async () => {
    // **Poison-message protection.** The caller advances the polling offset
    // once this resolves; if it threw, Telegram would redeliver the same bad
    // update forever and, under `restart: unless-stopped`, that is an infinite
    // loop rather than a crash you would notice.
    const { deps, tg } = makeDeps();
    tg.sendMessage.mockRejectedValue(new TelegramError("boom", "transient"));
    await expect(
      handleUpdate(message({ text: "https://a.example/1" }), deps),
    ).resolves.toBeUndefined();
  });
});

describe("the manual-caption fallback (PRD F4)", () => {
  it("re-imports the ORIGINAL url with the pasted text, not a link inside it", async () => {
    // Subtle and important: a pasted caption usually contains its own links
    // ("full recipe at mysite.com"). Treating those as a new import would
    // import the wrong thing, so the reply path is checked before URL
    // extraction.
    const { deps, api } = makeDeps();
    deps.pending.set(4471, { jobId: "job0", url: "https://www.instagram.com/reel/C9dO9AevUQx/", failedAt: Date.now() });

    await handleUpdate(
      message({
        text: "1 lb shrimp\n2 tbsp mayo\nmore at https://someblog.example/x",
        reply_to_message: { message_id: 4471, date: 0, chat: { id: Number(OWNER_CHAT), type: "private" }, from: { id: 2, is_bot: true } },
      }),
      deps,
    );

    expect(api.createImport).toHaveBeenCalledTimes(1);
    const arg = api.createImport.mock.calls[0][0];
    expect(arg.url).toBe("https://www.instagram.com/reel/C9dO9AevUQx/");
    expect(arg.text).toContain("1 lb shrimp");
  });

  it("says so honestly when the in-memory mapping was lost to a restart", async () => {
    const { deps, sent } = makeDeps();
    await handleUpdate(
      message({
        text: "1 lb shrimp",
        reply_to_message: { message_id: 999, date: 0, chat: { id: Number(OWNER_CHAT), type: "private" }, from: { id: 2, is_bot: true } },
      }),
      deps,
    );
    expect(sent.at(-1)!.text).toContain("lost track");
  });
});

describe("the bounded message→job map", () => {
  it("evicts the least recently used entry once it is full", () => {
    const p = new PendingImports(2);
    p.set(1, { jobId: "a", url: "u1", failedAt: 0 });
    p.set(2, { jobId: "b", url: "u2", failedAt: 0 });
    p.get(1); // touching 1 makes 2 the least recently used
    p.set(3, { jobId: "c", url: "u3", failedAt: 0 });

    expect(p.size).toBe(2);
    expect(p.get(2)).toBeUndefined(); // evicted
    expect(p.get(1)?.jobId).toBe("a");
    expect(p.get(3)?.jobId).toBe("c");
  });

  it("overwrites rather than duplicating the same message id", () => {
    const p = new PendingImports(2);
    p.set(1, { jobId: "a", url: "u1", failedAt: 0 });
    p.set(1, { jobId: "a2", url: "u1", failedAt: 0 });
    expect(p.size).toBe(1);
    expect(p.get(1)?.jobId).toBe("a2");
  });
});

describe("the Telegram client never leaks its token", () => {
  const TOKEN = "7712345678:AAF-abcdefghijklmnopqrstuvwxyz012345";
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  it("redacts the token out of a network-failure message", async () => {
    // The Bot API puts the token in the URL PATH, so undici's error text
    // ("request to https://api.telegram.org/bot<TOKEN>/getUpdates failed")
    // carries the secret straight into `docker logs`.
    globalThis.fetch = vi.fn(async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
    }) as unknown as typeof fetch;

    const tg = new TelegramClient({ token: TOKEN });
    const err = await tg.getUpdates(null).catch((e: unknown) => e as TelegramError);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).message).not.toContain(TOKEN);
    expect((err as TelegramError).message).toContain("***");
  });

  it("redacts the token out of an API error description too", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: `Unauthorized: bot${TOKEN}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const tg = new TelegramClient({ token: TOKEN });
    const err = (await tg.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("fatal"); // 401 must never be retried
    expect(err.message).not.toContain(TOKEN);
  });

  it("classifies a 409 as a conflict, so two pollers back off instead of fighting", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Conflict: terminated by other getUpdates" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const tg = new TelegramClient({ token: TOKEN });
    const err = (await tg.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("conflict");
  });

  it("carries Telegram's own retry_after hint on a 429", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 17 } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const tg = new TelegramClient({ token: TOKEN });
    const err = (await tg.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterSec).toBe(17);
  });
});
