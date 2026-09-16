// INTEGRATION tests for lib/prisma.ts — the client singleton and its PRAGMAs.
//
// WHY THIS IS WORTH A TEST FILE AT ALL
// ------------------------------------
// Both behaviours here are INVISIBLE WHEN BROKEN. If the WAL pragma silently
// fails, everything still works on a developer's laptop, where nothing writes
// concurrently; it shows up in production as an occasional 500 on the phone
// while the worker saves a recipe, which is almost impossible to attribute
// after the fact. Configuration that fails silently is exactly what a test is
// for — "it didn't throw" is not the same as "it took effect", and the only way
// to tell the difference is to ASK THE DATABASE what it thinks its settings are.
//
// This is also a small lesson in the limits of code review: the original version
// of this file looked completely correct and threw on every single boot.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { removeTempDatabase, useTempDatabase } from "./helpers/db";

const DB_FILE = useTempDatabase("pragmas");

let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  // NOTE: deliberately NO `migrate()` here, and the reason is itself a finding.
  // `PRAGMA journal_mode=WAL` needs exclusive access to the file, so running it
  // alongside the migration's DDL gets SQLITE_BUSY ("database is locked") and
  // the pragma is silently skipped — which is what happened on the first draft
  // of this file. In the real container that race cannot occur: the schema is
  // baked into a seed DB and copied by docker-entrypoint.sh BEFORE the server
  // process starts, so the database is idle when lib/prisma.ts loads. This file
  // needs no tables anyway.
  await settled();
});

afterAll(async () => {
  await prisma.$disconnect();
  removeTempDatabase(DB_FILE);
  // WAL mode creates two sidecar files the shared helper does not know about.
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${DB_FILE}${suffix}`)) fs.rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
});

/** The pragmas are applied fire-and-forget at module load, so a test that
 *  checks them immediately is racing the import. Poll instead of sleeping a
 *  fixed amount: fast when it works, and it fails with a useful message rather
 *  than flaking on a slow machine. */
async function journalMode(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode;");
  return rows[0]?.journal_mode?.toLowerCase() ?? "";
}

/**
 * Wait for the fire-and-forget pragma block to finish — WITHOUT touching the
 * database.
 *
 * ⚠️ The obvious version of this helper polls `PRAGMA journal_mode;` in a loop,
 * and it is a **Heisenbug generator**: switching a database into WAL needs an
 * exclusive lock, and a concurrent reader on another pooled connection makes
 * that switch fail with SQLITE_BUSY immediately (busy_timeout does not apply to
 * a journal-mode change). So the act of polling is what made the pragma fail —
 * the test broke the thing it was measuring, intermittently, and only under
 * load when the whole suite ran together. This cost a real debugging session;
 * it is the reason the helper below reads the FILESYSTEM instead.
 *
 * SQLite materialises `<db>-shm` and `<db>-wal` alongside the database the
 * moment WAL mode is active, so their existence is an out-of-band signal that
 * costs no lock.
 */
async function settled(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(`${DB_FILE}-shm`) || fs.existsSync(`${DB_FILE}-wal`)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SQLite is actually configured the way lib/prisma.ts says it is", () => {
  it("has journal_mode=WAL, not merely a line of code that asks for it", () => {
    //
    // CONCEPT — **WAL (write-ahead logging)**. SQLite's default rollback journal
    // takes an exclusive lock on the whole database for the duration of a write,
    // so a reader that arrives mid-write is refused with SQLITE_BUSY straight
    // away. In WAL mode the writer appends to a separate log, so readers keep
    // reading the last committed state and are never blocked. For this app that
    // is the difference between "the phone got a 500 because the worker was
    // mid-save" and "the phone read the previous state and moved on".
    //
    // REGRESSION TEST: this pragma was issued through `$executeRawUnsafe`, which
    // refuses any SQLite statement that returns rows — and `PRAGMA journal_mode`
    // returns the mode it settled on. So it threw on every boot, the `.catch`
    // logged a warning nobody reads, and the chained `busy_timeout` never ran
    // either. The database quietly kept its defaults.
    return expect(journalMode()).resolves.toBe("wal");
  });

  it("keeps WAL mode after a reconnect, because it is stored in the file", async () => {
    // Not a session setting: SQLite writes the journal mode into the database
    // header, so it survives a container restart. Worth pinning, because it is
    // the reason a one-shot pragma at boot is a legitimate strategy here rather
    // than something that must run on every new connection.
    await prisma.$disconnect();
    await prisma.$connect();
    await expect(journalMode()).resolves.toBe("wal");
  });

  it("has a busy_timeout, so a contending writer waits instead of 500ing", async () => {
    // The other half. WAL lets readers through; busy_timeout is what makes a
    // second WRITER wait its turn rather than fail immediately. SQLite allows
    // one writer at a time no matter what, so this is the setting that turns a
    // hard error into a few milliseconds of latency.
    //
    // ⚠️ HONESTY NOTE, and a lesson worth more than the assertion: this test
    // ALSO PASSED while the pragma block was completely broken, because Prisma's
    // SQLite connector already defaults busy_timeout to 5000 ms. A test that
    // cannot fail proves nothing — so treat this one as "the effective
    // configuration is what we want", not as "our line of code did it". The
    // journal_mode test above is the one that actually exercises our code.
    const rows = await prisma.$queryRawUnsafe<{ timeout: number }[]>("PRAGMA busy_timeout;");
    expect(Number(rows[0]?.timeout)).toBeGreaterThanOrEqual(5000);
  });

  it("documents WHY the pragmas cannot go through $executeRaw", () => {
    // Pinned as a test so that "simplifying" this back to $executeRawUnsafe
    // fails here, loudly, instead of in production silence. Prisma models the
    // execute/query split on "does this statement return rows?", and PRAGMA
    // assignments do.
    return expect(prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;")).rejects.toThrow(
      /Execute returned results/,
    );
  });
});

describe("one PrismaClient per process, not one per webpack bundle", () => {
  it("pins the client to globalThis even outside development", () => {
    // REGRESSION TEST for the 13-instances bug. The idiomatic snippet guards
    // this global with `if (NODE_ENV !== "production")`, on the reasoning that
    // it only exists to survive dev hot-reload. That reasoning misses how Next
    // builds: each App Router route is its own webpack bundle, and a shared
    // module is DUPLICATED into every one of them, so `new PrismaClient()` at
    // module scope runs once per bundle — 13 times here, 13 pools of writers
    // against one SQLite file inside a 640 MB container.
    //
    // NODE_ENV is "test" under vitest, i.e. neither "development" nor
    // "production" — which is precisely the point: the pin must be
    // unconditional, so any environment satisfies this assertion.
    expect(process.env.NODE_ENV).not.toBe("development");
    expect((globalThis as { prisma?: unknown }).prisma).toBe(prisma);
  });

  it("re-importing the module hands back the same instance", async () => {
    const again = await import("@/lib/prisma");
    expect(again.prisma).toBe(prisma);
  });
});
