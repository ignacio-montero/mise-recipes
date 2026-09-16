import { PrismaClient } from "@prisma/client";

// ⚠️ Pinned to `globalThis` in EVERY environment, production included.
//
// The obvious version of this file guards the global with
// `if (NODE_ENV !== "production")`, on the reasoning that the global only
// exists to survive dev hot-reload. That reasoning is incomplete and the
// production case is the one that bites:
//
// Next bundles each App Router route into its own self-contained webpack
// bundle, and a module that several bundles import is DUPLICATED into each one.
// So `new PrismaClient()` at module scope runs once per bundle — measured at
// **13 instances** in this app's standalone build (12 API routes + the worker
// chunk). Thirteen connections to one SQLite file from one process, each with
// its own Rust query-engine pool inside a 640 MB mem_limit, and every one of
// them a writer. That is how you get `SQLITE_BUSY: database is locked` on the
// phone while the worker saves a recipe.
//
// `globalThis` is the only scope all those bundles genuinely share, so the
// singleton has to live there. Same lesson as `lib/worker.ts` — module scope is
// a singleton per module GRAPH, not per process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = (globalForPrisma.prisma ??= new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
}));

// SQLite defaults serialise writers with an immediate `SQLITE_BUSY` rather than
// waiting. WAL lets readers run while a writer holds the file, and busy_timeout
// makes a contending writer wait instead of failing — together they turn "the
// phone got a 500 because the worker was mid-save" into "the phone waited 5 ms".
// Fire-and-forget: these are session pragmas, applied when the pool opens.
if (!(globalThis as { __misePragmas?: boolean }).__misePragmas) {
  (globalThis as { __misePragmas?: boolean }).__misePragmas = true;
  // ⚠️ `PRAGMA journal_mode` RETURNS a row (the mode it settled on), and Prisma's
  // $executeRaw* refuses any statement that produces results — "Execute returned
  // results, which is not allowed in SQLite" (P2010). It has to go through
  // $queryRawUnsafe — and so does `PRAGMA busy_timeout=N` (it returns the value it
  // set), so BOTH go through the query path. Get this wrong and the pragmas throw
  // at boot, are swallowed by the catch, and you silently keep SQLite's defaults.
  void (async () => {
    try {
      const [row] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>(
        "PRAGMA journal_mode=WAL;",
      );
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
      console.log(`[prisma] journal_mode=${row?.journal_mode ?? "?"} busy_timeout=5000ms`);
    } catch (e) {
      console.warn("[prisma] could not set pragmas", e);
    }
  })();
}
