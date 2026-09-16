// Next.js calls `register()` exactly once per server process, before any
// request is handled. That is the only hook in the framework with those two
// properties, which is why the import worker is started here and nowhere else
// (docs/ARCHITECTURE.md §2) — starting it from a route handler would start it
// again on every cold module evaluation, and starting it from a module
// top-level would run it during `next build` too.

export async function register(): Promise<void> {
  // Next evaluates this file in every runtime it builds for. The worker needs a
  // filesystem, child processes and a SQLite connection, none of which exist in
  // the edge runtime — so anything Node-only must be behind this check AND
  // behind a dynamic import, or the edge bundle fails to compile on modules it
  // will never execute.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { config } = await import("./lib/config");
  if (!config.worker.enabled) {
    console.log("[instrumentation] WORKER_ENABLED=false — imports will queue but not run");
    return;
  }

  const { startWorker } = await import("./lib/worker");
  // Idempotent by contract: the dev server re-runs `register()` on some
  // restarts, and two loops would mean two SQLite writers racing the same job.
  startWorker();
}
