process.env.DATABASE_URL = "file:./tests/.tmp-pragma-probe.db";
const { PrismaClient } = await import("@prisma/client");
const p = new PrismaClient();
await p.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS t (id INTEGER)");
try { await p.$executeRawUnsafe("PRAGMA journal_mode=WAL;"); console.log("execute WAL: ok"); }
catch (e) { console.log("execute WAL: FAILED ->", e.meta?.message ?? e.message); }
console.log("queryRaw WAL:", await p.$queryRawUnsafe("PRAGMA journal_mode=WAL;"));
console.log("mode now:", await p.$queryRawUnsafe("PRAGMA journal_mode;"));
try { await p.$executeRawUnsafe("PRAGMA busy_timeout=5000;"); console.log("execute busy_timeout: ok"); }
catch (e) { console.log("execute busy_timeout: FAILED ->", e.meta?.message ?? e.message); }
await p.$disconnect();
