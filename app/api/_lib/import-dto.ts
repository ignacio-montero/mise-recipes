// ImportJob row -> the shape docs/API_SPEC.md §2 promises. Kept next to the
// routes (not in lib/serialize.ts, which the architect owns) because it is only
// ever needed by these two endpoints.
import type { ImportJobDTO, ImportStage, ImportStatus, RecipeDTO } from "@/lib/types";

type JobRow = {
  id: string; status: string; stage: string | null; url: string;
  recipeId: string | null; error: string | null;
  createdAt: Date; updatedAt: Date;
};

export function toImportJobDTO(row: JobRow, recipe?: RecipeDTO | null): ImportJobDTO {
  const status = row.status as ImportStatus;
  return {
    id: row.id,
    status,
    stage: (row.stage as ImportStage | null) ?? null,
    url: row.url,
    recipeId: row.recipeId,
    // The manual-caption fallback (PRD F4) only makes sense once the automatic
    // path has given up; offering it while the job is still running would invite
    // the user to race the worker.
    canRetryWithText: status === "failed" || status === "not_recipe",
    error: row.error,
    ...(recipe ? { recipe } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
