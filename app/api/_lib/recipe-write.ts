// The writable surface of a Recipe, in one place, because `POST /api/recipes`
// (manual create) and `PATCH /api/recipes/:id` accept exactly the same fields
// per docs/API_SPEC.md §3 — two copies of this list would drift within a week.
import { ApiError, requireString } from "@/lib/http";
import { parseServingsCount } from "@/lib/scale";
import type { Ingredient } from "@/lib/types";
import { asBoolean, asNullableInt, asNullableString, asStringArray, assertAllowedKeys } from "./json";

export const WRITABLE_RECIPE_FIELDS = [
  "title", "description", "servings", "servingsCount", "totalMinutes",
  "ingredients", "steps", "notes", "tags", "favorite", "heroImagePath",
] as const;

/** Prisma-shaped: the array fields are already serialised to JSON TEXT, which is
 *  how the DB stores them (docs/ARCHITECTURE.md §4). */
export type RecipeWriteData = {
  title?: string;
  description?: string | null;
  servings?: string | null;
  servingsCount?: number | null;
  totalMinutes?: number | null;
  ingredients?: string;
  steps?: string;
  notes?: string | null;
  tags?: string;
  favorite?: boolean;
  heroImagePath?: string | null;
};

/** Ingredients are validated field by field rather than trusted: they are the
 *  one payload an LLM or a hand-written client can get structurally wrong, and a
 *  row with `item: null` would crash every read of the recipe afterwards. */
export function parseIngredients(v: unknown): Ingredient[] {
  if (!Array.isArray(v)) {
    throw new ApiError("bad_request", "`ingredients` must be an array of objects.");
  }
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ApiError("bad_request", `\`ingredients[${i}]\` must be an object.`);
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.item !== "string" || o.item.trim() === "") {
      throw new ApiError("bad_request", `\`ingredients[${i}].item\` must be a non-empty string.`);
    }
    const out: Ingredient = { item: o.item.trim() };
    for (const key of ["quantity", "unit", "note"] as const) {
      const val = o[key];
      if (val === undefined || val === null || val === "") continue;
      if (typeof val !== "string") {
        throw new ApiError("bad_request", `\`ingredients[${i}].${key}\` must be a string.`);
      }
      const trimmed = val.trim();
      if (trimmed) out[key] = trimmed;
    }
    return out;
  });
}

/**
 * Validate and translate a request body into Prisma `data`.
 * Only keys actually present are returned, so PATCH stays a genuine partial
 * update instead of nulling out everything the client did not send.
 */
export function parseRecipeWrite(
  body: Record<string, unknown>,
  opts: { requireTitle: boolean },
): RecipeWriteData {
  assertAllowedKeys(body, WRITABLE_RECIPE_FIELDS);

  const data: RecipeWriteData = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("title")) data.title = requireString(body.title, "title");
  else if (opts.requireTitle) throw new ApiError("bad_request", "`title` is required.");

  if (has("description")) data.description = asNullableString(body.description, "description");
  if (has("notes")) data.notes = asNullableString(body.notes, "notes");
  if (has("heroImagePath")) data.heroImagePath = asNullableString(body.heroImagePath, "heroImagePath");
  if (has("servings")) data.servings = asNullableString(body.servings, "servings");
  if (has("totalMinutes")) data.totalMinutes = asNullableInt(body.totalMinutes, "totalMinutes", { min: 0, max: 60 * 24 * 7 });
  if (has("favorite")) data.favorite = asBoolean(body.favorite, "favorite");
  if (has("ingredients")) data.ingredients = JSON.stringify(parseIngredients(body.ingredients));
  if (has("steps")) data.steps = JSON.stringify(asStringArray(body.steps, "steps"));
  if (has("tags")) data.tags = JSON.stringify(asStringArray(body.tags, "tags"));

  // `servingsCount` is derived from `servings` ("6-8 tacos" -> 6) and drives the
  // scaler, so it must be re-derived whenever `servings` changes — otherwise the
  // cook view silently scales against a stale base. An explicit servingsCount in
  // the same request still wins: the human correcting a bad parse outranks it.
  if (has("servingsCount")) {
    data.servingsCount = asNullableInt(body.servingsCount, "servingsCount", { min: 1, max: 999 });
  } else if (has("servings")) {
    data.servingsCount = parseServingsCount(data.servings ?? null);
  }

  return data;
}
