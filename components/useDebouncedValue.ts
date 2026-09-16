"use client";

import { useEffect, useState } from "react";
import { normalizeQuery } from "./debounce";

/**
 * The React face of `debounce()`: returns `value`, but only after it has been
 * still for `delay` ms.
 *
 * WHY A DEBOUNCED *VALUE* AND NOT A DEBOUNCED *CALLBACK*
 * -----------------------------------------------------
 * The search box stays a CONTROLLED COMPONENT — its `value` is React state, so
 * every keystroke paints instantly and the caret never jumps. What we delay is
 * the derived value that the fetch effect depends on. Debouncing the callback
 * instead would mean either an uncontrolled input (laggy value, awkward to
 * clear) or a `useCallback` whose identity has to be babysat across renders.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay);
    // Cleanup runs before the NEXT effect and on unmount: cancelling the timer
    // here is what actually produces the debounce — each new keystroke throws
    // away the previous pending update.
    return () => clearTimeout(id);
  }, [value, delay]);

  return settled;
}

/** Debounced + normalised, the exact pair the search box needs. */
export function useDebouncedQuery(raw: string, delay = 250): string {
  return useDebouncedValue(normalizeQuery(raw), delay);
}
