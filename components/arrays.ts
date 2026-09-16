// Immutable list edits, used by the recipe editor (add / remove / reorder
// ingredients and steps).
//
// WHY THESE ARE PURE FUNCTIONS IN THEIR OWN FILE
// ----------------------------------------------
// React state must be replaced, never mutated: `list.splice(i, 1); setList(list)`
// hands React the same array reference it already has, `Object.is` says nothing
// changed, and the component doesn't re-render. That bug is invisible in review
// and obvious in a unit test — so the array surgery lives here, returns new
// arrays, and can be tested without a renderer.

/** A copy of `list` with index `from` moved to index `to`. Out-of-range moves
 *  return the list unchanged, so the caller's up/down buttons don't need
 *  boundary logic beyond disabling themselves. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list;
  if (from < 0 || from >= list.length) return list;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function removeAt<T>(list: T[], index: number): T[] {
  if (index < 0 || index >= list.length) return list;
  return list.slice(0, index).concat(list.slice(index + 1));
}

export function replaceAt<T>(list: T[], index: number, value: T): T[] {
  if (index < 0 || index >= list.length) return list;
  const next = list.slice();
  next[index] = value;
  return next;
}

export function insertAt<T>(list: T[], index: number, value: T): T[] {
  const i = Math.max(0, Math.min(index, list.length));
  return list.slice(0, i).concat(value, list.slice(i));
}

/** "taco, weeknight , taco" -> ["taco", "weeknight"]. The editor takes tags as
 *  one comma-separated line (a tag chip editor is a lot of UI for a field that
 *  is edited twice a year), so the parsing rule lives here and is tested. */
export function parseTagList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Splits a pasted block of steps into one step per non-empty line, stripping
 *  any leading "1." / "1)" / "- " the source used. */
export function splitSteps(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, "").trim())
    .filter(Boolean);
}
