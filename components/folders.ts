// Folder logic, as pure functions over arrays. No React, no fetch, no DOM.
//
// Same split as components/grocery.ts and components/format.ts: the components
// keep the effects (fetching, sheets, focus), everything that is a *decision*
// lives here where a test can call it directly. The decisions worth testing
// turn out to be: what counts as a valid folder name, which recipes a filter
// selection should show, and how a local list is kept in step with the server
// after a create/rename/delete — all three are places where a wrong answer is
// silent rather than loud.

import type { Folder, Recipe } from "./types";

/**
 * Which folder filter the home screen is showing.
 *
 * A DISCRIMINATED UNION rather than `string | null` with a magic "unfiled"
 * sentinel: the sentinel would be a string that must never collide with a cuid,
 * and every call site would have to remember that rule. With a union, the
 * compiler refuses to let you forget a case in a switch, and "all", "unfiled"
 * and "one specific folder" are visibly three different things.
 */
export type FolderFilter =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; id: string };

export const ALL: FolderFilter = { kind: "all" };
export const UNFILED: FolderFilter = { kind: "unfiled" };

export function sameFilter(a: FolderFilter, b: FolderFilter): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "folder" && b.kind === "folder" ? a.id === b.id : true;
}

/** Tapping the chip that is already on returns to "All" — a filter you cannot
 *  switch off is a trap. (RecipeList had this behaviour for folder chips
 *  already; this keeps it, and extends it to Unfiled.) */
export function toggleFilter(current: FolderFilter, tapped: FolderFilter): FolderFilter {
  return sameFilter(current, tapped) ? ALL : tapped;
}

/** What to put in `?folder=` — `null` means "don't send the param at all".
 *  Unfiled sends nothing and is resolved on the client; see the known-gap note
 *  in docs/API_SPEC.md §4. */
export function folderQueryParam(filter: FolderFilter): string | null {
  // "none" is a reserved value the recipes endpoint understands as "filed
  // nowhere" — see app/api/recipes/route.ts. Pushing this to the server matters
  // because the alternative (filtering client-side) can only ever see the page
  // already loaded, so "Unfiled" would quietly go wrong once the list paginates.
  if (filter.kind === "unfiled") return "none";
  return filter.kind === "folder" ? filter.id : null;
}

/** True when the server could not do the whole job and the client must finish
 *  it. Nothing needs this since `?folder=none` moved the Unfiled case to the
 *  server; kept as the seam to hang the next such case on, and so the rule stays
 *  stated in one place rather than inferred from its absence. */
export function needsClientFilter(_filter: FolderFilter): boolean {
  return false;
}

export function filterByFolder<T extends Pick<Recipe, "folderIds">>(
  recipes: readonly T[],
  filter: FolderFilter,
): T[] {
  if (!needsClientFilter(filter)) return [...recipes];
  return recipes.filter((r) => (r.folderIds ?? []).length === 0);
}

// ── Names and emoji ─────────────────────────────────────────────────────────

/** The API's own limit is "non-empty string"; this is the client's politeness
 *  layer: collapse whitespace, cap the length so a chip row cannot be blown out
 *  by a paste, and return null when there is nothing worth POSTing so the
 *  caller can disable the button instead of letting the server say
 *  "`name` must be a non-empty string". */
export const MAX_FOLDER_NAME = 40;

export function cleanFolderName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_FOLDER_NAME);
  return name ? name : null;
}

/**
 * Keep the first glyph of whatever was typed, or null.
 *
 * `Array.from` rather than `raw[0]`: a JS string is indexed by UTF-16 code
 * UNITS, and most emoji are two of them (a surrogate pair), so `"🍰"[0]` is
 * half a character that renders as "�". `Array.from` iterates by code POINT.
 * It still splits ZWJ sequences like "👩‍🍳" — the fully correct tool is
 * `Intl.Segmenter`, which is deliberately not used here: it is not in older iOS
 * Safari and a one-glyph-too-many emoji is a cosmetic miss, not a bug.
 */
export function cleanEmoji(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const glyphs = Array.from(trimmed);
  // A variation selector / skin-tone modifier belongs to the glyph before it.
  let out = glyphs[0];
  for (let i = 1; i < glyphs.length; i++) {
    const cp = glyphs[i].codePointAt(0) ?? 0;
    const isModifier =
      cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0x20d0 && cp <= 0x20ff);
    const joinedByZwj = (glyphs[i - 1].codePointAt(0) ?? 0) === 0x200d;
    if (!isModifier && !joinedByZwj) break;
    out += glyphs[i];
  }
  return out;
}

/** "🍰 desserts" / "desserts". One function so the chip, the sheet row and the
 *  cook view can never disagree about the spacing. */
export function folderLabel(folder: Pick<Folder, "name" | "emoji">): string {
  return folder.emoji ? `${folder.emoji} ${folder.name}` : folder.name;
}

/** Case-insensitive by name. The API sorts with SQLite's `ORDER BY name ASC`,
 *  which is *byte* order — so "Desserts" would sort before "batch-cooking".
 *  Re-sorting on the client is one line and matches what a human expects. */
export function sortFolders<T extends Pick<Folder, "name">>(folders: readonly T[]): T[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Local duplicate guard so the create button can be disabled instead of
 *  bouncing off a 409. The server is still the authority — this check races and
 *  is allowed to be wrong; the 409 handler is what makes it safe. */
export function nameTaken(
  folders: readonly Pick<Folder, "id" | "name">[],
  name: string,
  exceptId?: string,
): boolean {
  const needle = name.trim().toLowerCase();
  return folders.some((f) => f.id !== exceptId && f.name.trim().toLowerCase() === needle);
}

// ── Selection ───────────────────────────────────────────────────────────────

/** Add or remove one id, returning a NEW array. A recipe can be in several
 *  folders, so the picker is a multi-select, not a radio group. */
export function toggleFolderId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Order-insensitive set equality — `PUT /api/recipes/:id/folders` replaces the
 *  whole set, so "has anything actually changed?" is a set question. Used to
 *  keep Save disabled until there is something to save. */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/** Drop ids whose folder no longer exists. A recipe loaded before a folder was
 *  deleted in another tab would otherwise send a stale id and get a 400 from
 *  the PUT ("Unknown folder id(s)"). */
export function knownIds(ids: readonly string[], folders: readonly Pick<Folder, "id">[]): string[] {
  const live = new Set(folders.map((f) => f.id));
  return ids.filter((id) => live.has(id));
}

/** "🍰 desserts · batch-cooking", or "" when the recipe is in none. */
export function folderSummary(
  folders: readonly Folder[],
  ids: readonly string[],
): string {
  const chosen = sortFolders(folders.filter((f) => ids.includes(f.id)));
  return chosen.map(folderLabel).join(" · ");
}

// ── Keeping a local folder list in step with the server ─────────────────────

/** Insert or replace by id, then re-sort. Used after POST (create) and PATCH
 *  (rename), so the chips update without a second GET /api/folders. */
export function upsertFolder(folders: readonly Folder[], folder: Folder): Folder[] {
  const i = folders.findIndex((f) => f.id === folder.id);
  const next = i === -1 ? [...folders, folder] : folders.map((f) => (f.id === folder.id ? folder : f));
  return sortFolders(next);
}

export function removeFolderById(folders: readonly Folder[], id: string): Folder[] {
  return folders.filter((f) => f.id !== id);
}

/**
 * After a recipe's folder set changes from `before` to `after`, adjust the
 * counts the chips display.
 *
 * Without this the count on a chip is stale until the next full reload, which
 * on a screen that shows "desserts 3" next to exactly 4 recipes looks like a
 * bug in the database. Counts never go below 0 — if the local copy has drifted,
 * a wrong-but-sane number beats "-1".
 */
export function applyFolderCountDelta(
  folders: readonly Folder[],
  before: readonly string[],
  after: readonly string[],
): Folder[] {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  return folders.map((f) => {
    if (added.includes(f.id)) return { ...f, recipeCount: f.recipeCount + 1 };
    if (removed.includes(f.id)) return { ...f, recipeCount: Math.max(0, f.recipeCount - 1) };
    return f;
  });
}

/** Deleting a folder must never read as "deleting the recipes in it". The copy
 *  is generated from the count so it can be specific about what survives. */
export function deleteFolderWarning(folder: Pick<Folder, "name" | "recipeCount">): string {
  const n = folder.recipeCount;
  if (n === 0) return `Delete “${folder.name}”? It's empty.`;
  if (n === 1) return `Delete “${folder.name}”? The recipe in it stays — only the folder goes.`;
  return `Delete “${folder.name}”? The ${n} recipes in it stay — only the folder goes.`;
}
