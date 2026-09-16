"use client";

import { useEffect, useState } from "react";

/**
 * Keeps the screen on while a recipe is open.
 *
 * WHY: you put the phone down to chop, it sleeps in twelve seconds, and now you
 * unlock it with a wet thumb. This is the single most kitchen-specific feature
 * in the app (PRD F7).
 *
 * THREE THINGS THAT MAKE THIS FIDDLIER THAN IT LOOKS
 * 1. FEATURE DETECTION. The Screen Wake Lock API doesn't exist on older iOS
 *    (before 16.4) or in Firefox on some platforms. Touching `navigator.wakeLock`
 *    without a guard throws and takes the whole cook view down with it — so the
 *    guard is not politeness, it's the difference between "no wake lock" and
 *    "no page".
 * 2. iOS RELEASES THE LOCK when the tab is backgrounded or the screen is locked,
 *    and does NOT restore it when you come back. So we re-acquire on
 *    `visibilitychange`. Without that, the feature works exactly once.
 * 3. IT MUST BE RELEASED on unmount. Leaving a sentinel held after navigating
 *    away keeps the user's screen alive on the grocery list too — a battery bug
 *    with no visible cause.
 *
 * Returns whether a lock is currently held, so the UI can say so rather than
 * making the user wonder.
 */

// Minimal local shape. Declared here rather than relying on lib.dom, because
// the API's typings differ across TypeScript versions and a missing global
// would break the build on a machine with an older lib.
type Sentinel = { released: boolean; release: () => Promise<void> };
type WakeLockCapableNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<Sentinel> };
};

export function useWakeLock(enabled: boolean): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined") return;
    const nav = navigator as WakeLockCapableNavigator;
    if (!nav.wakeLock) return; // unsupported: silently do nothing

    let sentinel: Sentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      // Requesting while hidden always rejects; skip rather than log noise.
      if (document.visibilityState !== "visible") return;
      try {
        const s = await nav.wakeLock!.request("screen");
        if (cancelled) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        setActive(true);
      } catch {
        // Denied (low battery, no user gesture yet). Not worth a message: the
        // screen simply behaves as it normally would.
        setActive(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void acquire();
      } else {
        setActive(false);
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      setActive(false);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    };
  }, [enabled]);

  return active;
}
