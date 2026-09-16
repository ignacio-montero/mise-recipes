// Client-side mirror of the DTOs in docs/API_SPEC.md §0.
//
// WHY A MIRROR INSTEAD OF IMPORTING `lib/types.ts`
// -----------------------------------------------
// `lib/` is the server's half of the app: it imports Prisma, `node:fs`,
// `process.env`. TypeScript types themselves are erased at build time, but a
// single accidental value import from a file in `lib/` drags a server-only
// module into the browser bundle — and the failure shows up as a cryptic build
// error, not an obvious one. Keeping a client-owned copy makes the boundary a
// physical one rather than a convention. The price is that these two files must
// agree; API_SPEC.md §0 is the referee. (Blue Plaques does the same thing in
// its own `components/types.ts`.)
//
// `lib/scale.ts` IS imported directly by client code, deliberately: it is pure,
// dependency-free arithmetic and it is shared with the grocery-list endpoint on
// purpose, so a scaled list can never disagree with what the screen showed.

export type Platform = "instagram" | "tiktok" | "youtube" | "web" | "manual";

export type Ingredient = {
  /** TEXT, never a float: captions say "1/2", "1 1/2", "2-3", "a splash". */
  quantity?: string;
  unit?: string;
  item: string;
  note?: string;
};

export type Extraction = {
  tiers: string[];
  model: string | null;
  confidence: number;
  rawText: string;
};

export type Recipe = {
  id: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  sourcePlatform: Platform;
  sourceAuthor: string | null;
  /** A URL ("/api/images/<file>"), not a disk path. Null for most imports. */
  heroImagePath: string | null;
  servings: string | null;
  /** Parsed count that drives the scaler; null when unparseable ("a crowd"). */
  servingsCount: number | null;
  totalMinutes: number | null;
  ingredients: Ingredient[];
  steps: string[];
  notes: string | null;
  tags: string[];
  folderIds: string[];
  favorite: boolean;
  cookedCount: number;
  lastCookedAt: string | null;
  extraction: Extraction | null;
  createdAt: string;
  updatedAt: string;
};

export type ImportStatus = "pending" | "running" | "done" | "failed" | "not_recipe";
export type ImportStage = "fetching" | "transcribing" | "structuring";

export type ImportJob = {
  id: string;
  status: ImportStatus;
  stage: ImportStage | null;
  url: string;
  recipeId: string | null;
  recipe?: Recipe;
  error: string | null;
  canRetryWithText: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Folder = { id: string; name: string; emoji: string | null; recipeCount: number };

export type GroceryItem = {
  id: string;
  text: string;
  checked: boolean;
  recipeId: string | null;
  recipeTitle: string | null;
  createdAt: string;
};

export type ApiErrorCode =
  | "bad_request" | "unauthorized" | "not_found" | "conflict"
  | "unsupported_source" | "extraction_failed" | "not_a_recipe"
  | "rate_limited" | "internal";

// ── Response envelopes (API_SPEC §2–§5) ─────────────────────────────────────

export type RecipeListResponse = { recipes: Recipe[]; nextCursor: string | null };
export type RecipeResponse = { recipe: Recipe };
export type FolderListResponse = { folders: Folder[] };

/** `GET /api/imports` — the key is `jobs`, NOT `imports`. Verified against
 *  `app/api/imports/route.ts`; an earlier draft of this file guessed wrong and
 *  would have rendered an empty "Recent imports" strip forever, silently,
 *  because `undefined ?? []` is not a type error. Done jobs carry their whole
 *  `recipe` inline, so the strip needs no follow-up `/api/recipes/:id` calls. */
export type ImportListResponse = { jobs: ImportJob[] };

/** `POST /api/imports` — 202, before any extraction has happened. */
export type ImportEnqueueResponse = { id: string; status: ImportStatus };

export type GroceryListResponse = { items: GroceryItem[] };
export type GroceryItemResponse = { item: GroceryItem };

/** `POST /api/grocery/from-recipe/:id` returns the WHOLE refreshed list, not
 *  just the new rows: merging ("2 lb shrimp" + "1 lb shrimp" → "3 lb shrimp")
 *  rewrites existing items too, so appending `added` rows would leave the
 *  client's copy stale. Always re-render from `items`. */
export type GroceryFromRecipeResponse = { added: number; items: GroceryItem[] };

export type GroceryClearResponse = { deleted: number };

/** The fields `PATCH /api/recipes/:id` accepts. Anything else is a 400, so the
 *  editor is typed against this rather than against `Recipe`. */
export type RecipePatch = Partial<
  Pick<
    Recipe,
    | "title" | "description" | "servings" | "servingsCount" | "totalMinutes"
    | "ingredients" | "steps" | "notes" | "tags" | "favorite" | "heroImagePath"
  >
>;
