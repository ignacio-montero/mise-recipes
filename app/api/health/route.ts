// GET /api/health — what the compose healthcheck curls.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ApiError, handle } from "@/lib/http";
import { workerStatus } from "@/lib/worker";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  // A real query, not just "the process is up": the container's job is to serve
  // data, and a healthcheck that passes while the SQLite volume is unmounted
  // would keep a useless container in rotation. Cheap enough to run every 30 s.
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch (e) {
    console.error("[health] db unreachable", e);
  }

  const worker = workerStatus();

  // Non-200 when the DB is unreachable is the whole contract here — Docker only
  // looks at the status, not the body. The worker being asleep is NOT fatal:
  // restarting the container would not fix it and would drop in-flight imports.
  if (!db) {
    throw new ApiError("internal", "Database unreachable.", { ok: false, db: false, worker });
  }

  return NextResponse.json({ ok: true, db: true, worker });
});
