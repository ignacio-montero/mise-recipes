// Next.js calls `register()` exactly once per server process, before any
// request is handled. That is the only hook in the framework with those two
// properties, which is why the import worker is started here and nowhere else
// (docs/ARCHITECTURE.md §2): starting it from a route handler would restart it
// on every cold module evaluation, and starting it at a module top level would
// run it during `next build` too.

export async function register(): Promise<void> {
  // ⚠️ This shape is load-bearing — a POSITIVE `if`, not an early `return`.
  //
  // Next compiles this file for BOTH runtimes, including edge, where
  // `node:child_process` (reached via lib/worker → lib/ytdlp) does not exist and
  // webpack fails the build with "UnhandledSchemeError: Reading from
  // node:child_process". The guard survives that only because webpack replaces
  // `process.env.NEXT_RUNTIME` at build time and then folds away the body of an
  // `if (false)` block — imports and all. An early `return` does NOT get that
  // treatment: webpack folds constant conditions, it does not do control-flow
  // reachability, so the dynamic imports below stay in the edge bundle and the
  // dev server dies. Same reason the imports are dynamic rather than top-level.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { config } = await import("./lib/config");
    if (!config.worker.enabled) {
      console.log("[instrumentation] WORKER_ENABLED=false — imports will queue but not run");
      return;
    }
    const { startWorker } = await import("./lib/worker");
    // Idempotent by contract: the dev server re-runs `register()` on some
    // restarts, and two loops would mean two SQLite writers racing one job.
    startWorker();
  }
}
