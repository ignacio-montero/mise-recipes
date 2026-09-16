// The cooked-counter's arithmetic and its wording, as pure functions.
//
// WHY THIS ISN'T INLINE IN CookView
// --------------------------------
// "Cooked it" and its undo are OPTIMISTIC (see GroceryList.tsx's note): the
// screen paints the new count before the server has agreed, so the client has
// to compute the same answer the server will. That makes this the one piece of
// logic in the feature that exists in TWO places — here and in
// `app/api/recipes/[id]/cooked/route.ts` — and a divergence between them would
// show up as a number that flickers 3 → 4 → 3 when the response lands.
// Pulling it out means the rule can be tested directly, against the same cases
// the route's integration test uses. Same split as components/grocery.ts.
//
// THE RULE, stated once (the route's DELETE comment states the SQL half):
//   +1 → count + 1, lastCookedAt = now.
//   -1 → max(0, count - 1); lastCookedAt becomes null AT ZERO and is otherwise
//        left alone, because nothing stores the date of the cook before last.

/** The only two fields of a Recipe this module touches. Typed structurally so
 *  the functions work on a whole `Recipe` without importing it — and so a test
 *  can pass `{ cookedCount: 3, lastCookedAt: null }` and nothing else. */
export type CookedFields = { cookedCount: number; lastCookedAt: string | null };

export type CookedDelta = 1 | -1;

/**
 * Apply one cook (or one undo) to a recipe-shaped object, returning a NEW
 * object. Never mutates: React compares by reference, so editing
 * `recipe.cookedCount` in place and calling `setRecipe(recipe)` would change
 * the data and repaint nothing.
 *
 * `now` is injected with a default rather than read from `Date.now()` inside,
 * for the same reason `relativeTime` in format.ts does it: a function that
 * reads the clock is a function whose test has to mock the clock.
 */
export function applyCookedDelta<T extends CookedFields>(
  recipe: T,
  delta: CookedDelta,
  now: Date = new Date(),
): T {
  if (delta === 1) {
    return { ...recipe, cookedCount: recipe.cookedCount + 1, lastCookedAt: now.toISOString() };
  }
  const count = Math.max(0, recipe.cookedCount - 1);
  return { ...recipe, cookedCount: count, lastCookedAt: count === 0 ? null : recipe.lastCookedAt };
}

/** Undo is offered only when there is something to undo. The server would
 *  happily accept the call anyway (it is idempotent at zero), but a button that
 *  does nothing is a worse answer than no button. */
export function canUndoCooked(recipe: Pick<CookedFields, "cookedCount">): boolean {
  return recipe.cookedCount > 0;
}

/**
 * What the toast says. Written as whole sentences because `role="status"` reads
 * them aloud: "Cooked 3 times. Nice." is a sentence, "3×" is a glyph VoiceOver
 * pronounces as "multiplication sign".
 */
export function cookedToastText(count: number, action: "cooked" | "undone"): string {
  if (action === "cooked") return `Cooked ${count}×. Nice.`;
  return count === 0 ? "Undone — not cooked yet." : `Undone — cooked ${count}× now.`;
}

/** The label on the tappable "Cooked 3× · last yesterday" row in About.
 *  `relative` is passed in (already formatted by format.ts's `relativeTime`)
 *  rather than computed here, so this module stays free of the clock. */
export function cookedLine(count: number, relative: string): string {
  if (count <= 0) return "Not cooked yet";
  const when = relative.trim();
  return when ? `Cooked ${count}× · last ${when}` : `Cooked ${count}×`;
}

/** The accessible name for that row. The visible text says what IS; a button
 *  must say what it DOES, or a screen-reader user hears "Cooked 3 times,
 *  button" and has no idea that pressing it subtracts one. */
export function undoCookedLabel(count: number): string {
  return `Undo one cook — cooked ${count} time${count === 1 ? "" : "s"}`;
}
