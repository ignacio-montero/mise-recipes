// Debouncing, as a pure function of time rather than a React hook, so a test
// can drive it with fake timers and no renderer.
//
// CONCEPT — DEBOUNCE vs THROTTLE
// ------------------------------
// Typing "shr" into the search box fires three keystrokes in ~200 ms. Without
// help that is three `GET /api/recipes?q=` round trips, two of which are
// already stale before they return. DEBOUNCE waits for the storm to stop: the
// call happens `wait` ms after the LAST event. THROTTLE is the other shape —
// "at most once every N ms" — and is what you want for scroll/resize handlers
// where you need periodic updates during the storm, not just after it.
// Search wants debounce: the only query that matters is the final one.
//
// Debouncing alone does NOT fix out-of-order responses (a slow "shr" can land
// after a fast "shrimp"); that needs request cancellation, which is why
// RecipeList.tsx also carries an AbortController.

export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  /** Drop a pending call — what a component does on unmount. */
  cancel: () => void;
  /** Run a pending call now (e.g. the user pressed Enter). */
  flush: () => void;
};

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };

  const debounced = ((...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, wait);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };

  return debounced;
}

/** Search-specific normalisation: trim, collapse whitespace. Exported because
 *  "  shrimp  " and "shrimp" must not be treated as two different queries —
 *  otherwise a trailing space costs a pointless request. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
