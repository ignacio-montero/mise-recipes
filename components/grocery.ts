// The grocery list's list-arithmetic, as pure functions over arrays.
//
// WHY THESE AREN'T JUST INLINE `setItems(items.map(...))` CALLS
// ------------------------------------------------------------
// Every one of them is half of an OPTIMISTIC UPDATE: the component paints the
// result before the server has agreed, and has to be able to paint the exact
// previous state again when the server disagrees. That makes "what the list
// looks like after ticking item X" a decision worth testing on its own, without
// a DOM, a fetch mock or a React renderer in the way — the same split
// `components/format.ts` and `components/importFlow.ts` make.
//
// All of these return NEW arrays and NEW item objects. React decides whether to
// re-render by comparing references (`Object.is`), so mutating `item.checked`
// in place and calling `setItems(items)` would change the data and change
// nothing on screen — the single most common "my state update did nothing" bug.

import type { GroceryItem } from "./types";

/** Unchecked first — the shopping order. The server already sorts this way
 *  (`app/api/grocery/route.ts`), but the client re-derives it after an
 *  optimistic tick so the item moves immediately instead of on the next load. */
export function splitByChecked(items: readonly GroceryItem[]): {
  open: GroceryItem[];
  done: GroceryItem[];
} {
  const open: GroceryItem[] = [];
  const done: GroceryItem[] = [];
  for (const item of items) (item.checked ? done : open).push(item);
  return { open, done };
}

/** Flip one item's `checked`. Used twice per tap: once optimistically, once
 *  more with the old value if the PATCH fails. */
export function applyChecked(
  items: readonly GroceryItem[],
  id: string,
  checked: boolean,
): GroceryItem[] {
  return items.map((item) => (item.id === id ? { ...item, checked } : item));
}

export function removeById(items: readonly GroceryItem[], id: string): GroceryItem[] {
  return items.filter((item) => item.id !== id);
}

/** Append a server-confirmed item, replacing any row that already has its id.
 *  The replace branch matters because `POST /api/grocery/from-recipe/:id`
 *  returns rows that may already be on screen. */
export function upsert(items: readonly GroceryItem[], item: GroceryItem): GroceryItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) return [...items, item];
  const next = [...items];
  next[i] = item;
  return next;
}

export function checkedCount(items: readonly GroceryItem[]): number {
  return items.reduce((n, item) => n + (item.checked ? 1 : 0), 0);
}

/** "4 of 11 in the basket" — the line under the heading. Written as a whole
 *  sentence rather than "4/11" because it is read aloud by VoiceOver too. */
export function progressLine(items: readonly GroceryItem[]): string {
  if (items.length === 0) return "";
  const done = checkedCount(items);
  return `${done} of ${items.length} in the basket`;
}

/** Where a line came from: "from Crispy Shrimp Tacos", or "" for a free-text
 *  item. `recipeTitle` is null once the recipe is deleted — API_SPEC §3 says
 *  grocery items are kept but unlinked — so this must tolerate an id with no
 *  title rather than rendering "from null". */
export function sourceLabel(item: Pick<GroceryItem, "recipeTitle">): string {
  const title = item.recipeTitle?.trim();
  return title ? `from ${title}` : "";
}

/**
 * The same label, but blank when the row above already said it.
 *
 * "Add to grocery list" appends a whole recipe at once, so every one of those
 * rows carried an identical "from Crispy Shrimp Tacos" — twelve repetitions of
 * one fact, which is noise that pushes the actual shopping list off the screen.
 * Printing it once per RUN keeps the provenance without the chatter, and reads
 * the way a person would write the list by hand.
 *
 * Pure and index-based so it stays testable without a renderer.
 */
export function sourceLabelAt(
  items: readonly Pick<GroceryItem, "recipeTitle">[],
  index: number,
): string {
  const item = items[index];
  if (!item) return "";
  const label = sourceLabel(item);
  if (!label) return "";
  const prev = index > 0 ? items[index - 1] : undefined;
  return prev && sourceLabel(prev) === label ? "" : label;
}

/** Trim and reject the empties before they reach the API. Returns null when
 *  there is nothing worth POSTing, so the caller can no-op silently instead of
 *  making the server say "`text` is required". */
export function cleanNewItem(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  return text ? text : null;
}
