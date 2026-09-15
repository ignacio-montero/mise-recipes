// Row → DTO. The DB stores ingredients/steps/tags/extraction as JSON TEXT
// (see docs/ARCHITECTURE.md §4); the API contract says they are real arrays.
// This is the ONLY place that conversion happens, in both directions.
import type { Extraction, FolderDTO, GroceryItemDTO, Ingredient, Platform, RecipeDTO } from "./types";

/** Parse a JSON column defensively: a malformed row must not 500 the list endpoint. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

type RecipeRow = {
  id: string; title: string; description: string | null;
  sourceUrl: string | null; sourcePlatform: string; sourceAuthor: string | null;
  heroImagePath: string | null; servings: string | null; servingsCount: number | null;
  totalMinutes: number | null; ingredients: string; steps: string; notes: string | null;
  tags: string; extraction: string | null; favorite: boolean; cookedCount: number;
  lastCookedAt: Date | null; createdAt: Date; updatedAt: Date;
  folders?: { folderId: string }[];
};

export function toRecipeDTO(row: RecipeRow): RecipeDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourceUrl: row.sourceUrl,
    sourcePlatform: row.sourcePlatform as Platform,
    sourceAuthor: row.sourceAuthor,
    heroImagePath: row.heroImagePath,
    servings: row.servings,
    servingsCount: row.servingsCount,
    totalMinutes: row.totalMinutes,
    ingredients: parseJson<Ingredient[]>(row.ingredients, []),
    steps: parseJson<string[]>(row.steps, []),
    notes: row.notes,
    tags: parseJson<string[]>(row.tags, []),
    folderIds: (row.folders ?? []).map((f) => f.folderId),
    favorite: row.favorite,
    cookedCount: row.cookedCount,
    lastCookedAt: row.lastCookedAt ? row.lastCookedAt.toISOString() : null,
    extraction: parseJson<Extraction | null>(row.extraction, null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Include clause every recipe read must use so folderIds is populated. */
export const recipeInclude = { folders: { select: { folderId: true } } } as const;

export function toFolderDTO(row: {
  id: string; name: string; emoji: string | null; _count?: { recipes: number };
}): FolderDTO {
  return { id: row.id, name: row.name, emoji: row.emoji, recipeCount: row._count?.recipes ?? 0 };
}

export function toGroceryDTO(row: {
  id: string; text: string; checked: boolean; recipeId: string | null;
  createdAt: Date; recipe?: { title: string } | null;
}): GroceryItemDTO {
  return {
    id: row.id, text: row.text, checked: row.checked, recipeId: row.recipeId,
    recipeTitle: row.recipe?.title ?? null, createdAt: row.createdAt.toISOString(),
  };
}
