// Shared domain types. MUST stay in sync with docs/API_SPEC.md §0 and with
// components/types.ts (the client-side mirror).

export type Platform = "instagram" | "tiktok" | "youtube" | "web" | "manual";

export type Ingredient = {
  /** Kept as TEXT, never a float: real captions say "1/2", "1 1/2", "2-3",
   *  "a splash". Parsing to a number at ingest loses information. */
  quantity?: string;
  unit?: string;
  item: string;
  note?: string;
};

export type Extraction = {
  /** Ordered trace, e.g. ["tier1:instagram-embed", "tier3:gemini"]. */
  tiers: string[];
  model: string | null;
  confidence: number;
  rawText: string;
};

export type RecipeDTO = {
  id: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  sourcePlatform: Platform;
  sourceAuthor: string | null;
  heroImagePath: string | null;
  servings: string | null;
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

export type ImportJobDTO = {
  id: string;
  status: ImportStatus;
  stage: ImportStage | null;
  url: string;
  recipeId: string | null;
  recipe?: RecipeDTO;
  error: string | null;
  canRetryWithText: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FolderDTO = { id: string; name: string; emoji: string | null; recipeCount: number };

export type GroceryItemDTO = {
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

// ── The extraction pipeline's public surface (lib/extract/index.ts) ──────────

/** Text + metadata gathered before any structuring happens. */
export type Gathered = {
  platform: Platform;
  /** Everything worth feeding the model, already concatenated and cleaned. */
  text: string;
  author: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  canonicalUrl: string;
  tiers: string[];
  /** Set when Tier 0 (JSON-LD) produced a complete recipe with no LLM. */
  structured: ParsedRecipe | null;
};

/** What Tier 0 or Tier 3 produces, before it becomes a database row. */
export type ParsedRecipe = {
  isRecipe: boolean;
  confidence: number;
  title: string;
  description?: string | null;
  servings?: string | null;
  totalMinutes?: number | null;
  ingredients: Ingredient[];
  steps: string[];
  tags?: string[];
  notes?: string | null;
};
