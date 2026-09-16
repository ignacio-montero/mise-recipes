// Test database plumbing.
//
// Concept — **test fixture**: a known, disposable environment a test runs
// against. Here the fixture is a real SQLite file, not a mock of Prisma. The
// bugs these tests hunt (unique constraints, ordering, cursor pagination,
// `contains` semantics) live in the SQL layer, so mocking the DB would mock out
// exactly the thing under test. This is an *integration test* seam.
//
// One database FILE per test file, created in tests/.tmp-<name>.db and deleted
// afterwards, so files can run in parallel workers without fighting over rows.
// The schema is generated from prisma/schema.prisma at runtime (via
// `prisma migrate diff`) rather than checked in, so it can never drift.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

/** MUST be called at the top of a test file, BEFORE anything imports
 *  `@/lib/prisma` — PrismaClient reads DATABASE_URL when it is constructed.
 *  That is why every test file that uses this loads its route modules with a
 *  dynamic `await import()` inside `beforeAll`, not a static top-level import. */
export function useTempDatabase(name: string): string {
  const file = path.join(ROOT, "tests", `.tmp-${name}.db`);
  for (const f of [file, `${file}-journal`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  process.env.DATABASE_URL = `file:${file}`;
  return file;
}

let cachedDdl: string | null = null;

function schemaDdl(): string {
  if (cachedDdl) return cachedDdl;
  cachedDdl = execFileSync(
    path.join(ROOT, "node_modules", ".bin", "prisma"),
    [
      "migrate", "diff",
      "--from-empty",
      "--to-schema-datamodel", path.join(ROOT, "prisma", "schema.prisma"),
      "--script",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  return cachedDdl;
}

type RawClient = { $executeRawUnsafe(sql: string): Promise<unknown> };

/** Create the tables. Statements are applied one at a time because SQLite's
 *  driver only executes a single statement per call. */
export async function migrate(prisma: RawClient): Promise<void> {
  const withoutComments = schemaDdl()
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of withoutComments.split(";")) {
    const sql = stmt.trim();
    if (!sql) continue;
    await prisma.$executeRawUnsafe(sql);
  }
}

export function removeTempDatabase(file: string): void {
  for (const f of [file, `${file}-journal`]) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}
