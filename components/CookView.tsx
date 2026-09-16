"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatIngredient, scaleIngredients } from "@/lib/scale";
import RecipeEditor from "./RecipeEditor";
import Thumb from "./Thumb";
import Toast from "./Toast";
import { ErrorState } from "./States";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "./api";
import { PLATFORM_LABEL, countsLine, formatMinutes, hostOf, relativeTime } from "./format";
import { useWakeLock } from "./useWakeLock";
import type { GroceryFromRecipeResponse, Recipe, RecipeResponse } from "./types";

/**
 * `/recipe/[id]` — the cook view. The screen the whole project exists for.
 *
 * LAYOUT DECISION: a FIXED FRAME with one scrolling pane, and ingredients /
 * steps behind a segmented control rather than stacked in one long column.
 * Success criterion S3 is "no page scroll needed to see the ingredient list on
 * an iPhone 11", and a hero + title + scaler + 9 ingredients does not fit in
 * 600px any other way. The cost is a tap to get from ingredients to steps; the
 * benefit is that neither list is ever half-hidden behind the other, and the
 * current step can be made big without pushing anything off screen.
 * Discarded: one continuous scroll (simpler, but fails S3), and a two-column
 * split (fine at ≥720px, unusable at 390px).
 *
 * EPHEMERAL vs PERSISTED STATE — the distinction this screen turns on:
 *   - which ingredients are ticked, which steps are done, and the servings
 *     scale are COOKING-SESSION state. They live in `useState` and die with the
 *     page, deliberately: coming back tomorrow to a recipe with half its
 *     ingredients crossed out would be a bug, not a feature.
 *   - favourite, cooked count and every edit are PERSISTED through the API.
 * Getting that line in the wrong place is the most common design mistake in
 * this kind of app.
 */

type Tab = "ingredients" | "steps" | "about";

export default function CookView({
  recipeId,
  initialEdit = false,
}: {
  recipeId: string;
  initialEdit?: boolean;
}) {
  const router = useRouter();

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<Tab>("ingredients");
  const [editing, setEditing] = useState(initialEdit);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState<"grocery" | "cooked" | "delete" | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  // Cooking-session state (see the note above).
  const [servings, setServings] = useState<number | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [doneSteps, setDoneSteps] = useState<ReadonlySet<number>>(new Set());

  // Keep the screen awake while the recipe is on screen, but not while the
  // editor has taken it over — at that point you're at a table, not a hob.
  const awake = useWakeLock(!loading && !editing && recipe !== null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { recipe: r } = await apiGet<RecipeResponse>(`/api/recipes/${recipeId}`);
      setRecipe(r);
      setServings(r.servingsCount);
      setLoadError("");
    } catch (e) {
      setLoadError(errorMessage(e, "Couldn't load that recipe."));
    } finally {
      setLoading(false);
    }
  }, [recipeId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The scale factor. `servingsCount` is the parsed base ("6-8 tacos" → 6); it
   * is null when the caption said something unparseable ("a crowd"), and in
   * that case the scaler is hidden entirely rather than shown disabled — a
   * disabled control invites a tap and explains nothing.
   */
  const base = recipe?.servingsCount ?? null;
  const factor = base && servings ? servings / base : 1;
  const scaled = useMemo(
    () => (recipe ? scaleIngredients(recipe.ingredients, factor) : []),
    // `useMemo` here is not a micro-optimisation: scaleIngredients returns NEW
    // objects every call, so without it every unrelated re-render (a tick, a
    // toast) would rebuild the array and re-render every row.
    [recipe, factor],
  );

  const toggleTick = (i: number) =>
    setTicked((set) => {
      const next = new Set(set);
      // A Set is replaced, never mutated: React compares by reference, so
      // `set.add(i); setTicked(set)` would change nothing on screen.
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const toggleStep = (i: number) =>
    setDoneSteps((set) => {
      const next = new Set(set);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  async function toggleFavorite() {
    if (!recipe) return;
    const next = !recipe.favorite;
    setRecipe({ ...recipe, favorite: next }); // optimistic
    try {
      const { recipe: saved } = await apiPatch<RecipeResponse>(`/api/recipes/${recipe.id}`, {
        favorite: next,
      });
      setRecipe(saved);
    } catch (e) {
      setRecipe((r) => (r ? { ...r, favorite: !next } : r)); // roll back, visibly
      setToast({ text: errorMessage(e, "Couldn't save that."), tone: "error" });
    }
  }

  async function addToGrocery() {
    if (!recipe) return;
    setBusy("grocery");
    try {
      // The CURRENT factor goes to the server so the shopping list matches the
      // numbers on screen. Both sides format through lib/scale.ts, which is
      // precisely why that module is shared rather than duplicated.
      const res = await apiPost<GroceryFromRecipeResponse>(
        `/api/grocery/from-recipe/${recipe.id}`,
        { scale: factor },
      );
      setToast({
        text: `Added ${res.added} item${res.added === 1 ? "" : "s"} to the grocery list.`,
        tone: "ok",
      });
    } catch (e) {
      setToast({ text: errorMessage(e, "Couldn't add those."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function markCooked() {
    if (!recipe) return;
    setBusy("cooked");
    try {
      const { recipe: saved } = await apiPost<RecipeResponse>(`/api/recipes/${recipe.id}/cooked`);
      setRecipe(saved);
      setToast({ text: `Cooked ${saved.cookedCount}×. Nice.`, tone: "ok" });
    } catch (e) {
      setToast({ text: errorMessage(e, "Couldn't record that."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function reallyDelete() {
    if (!recipe) return;
    setBusy("delete");
    try {
      await apiDelete(`/api/recipes/${recipe.id}`);
      // `refresh()` as well as `push()`: the list page caches its route segment,
      // and without this the deleted recipe reappears for one render.
      router.push("/");
      router.refresh();
    } catch (e) {
      setToast({ text: errorMessage(e, "Couldn't delete that."), tone: "error" });
      setBusy(null);
      setConfirmingDelete(false);
    }
  }

  // Escape closes the confirm dialog — the behaviour every modal owes you.
  useEffect(() => {
    if (!confirmingDelete) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setConfirmingDelete(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingDelete]);

  if (loading) {
    return (
      <div className="page stack" aria-busy="true">
        <div className="skeleton" style={{ height: 160 }} />
        <div className="skeleton" style={{ height: 28, width: "70%" }} />
        <div className="skeleton" style={{ height: 18, width: "45%" }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  if (loadError || !recipe) {
    return (
      <div className="page stack">
        <ErrorState message={loadError || "That recipe is gone."} onRetry={() => void load()} />
        <Link href="/" className="btn btn--block">
          Back to recipes
        </Link>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="cook">
        <RecipeEditor
          recipe={recipe}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setRecipe(saved);
            setServings(saved.servingsCount);
            // Ingredient/step indices may have moved, so the session ticks no
            // longer mean anything. Clearing them is the honest choice.
            setTicked(new Set());
            setDoneSteps(new Set());
            setEditing(false);
            setToast({ text: "Saved.", tone: "ok" });
          }}
        />
        <Toast message={toast?.text ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
      </div>
    );
  }

  const time = formatMinutes(recipe.totalMinutes);
  const host = hostOf(recipe.sourceUrl);
  const currentStep = recipe.steps.findIndex((_, i) => !doneSteps.has(i));

  return (
    <div className="cook">
      <div className="cook__hero">
        {recipe.heroImagePath ? (
          <Thumb src={recipe.heroImagePath} title={recipe.title} seed={recipe.id} variant="hero" />
        ) : (
          <Thumb src={null} title={recipe.title} seed={recipe.id} variant="hero" />
        )}
        <button
          type="button"
          className="cook__back"
          onClick={() => router.push("/")}
          aria-label="Back to recipes"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="cook__head">
        <h1 className="cook__title">{recipe.title}</h1>
        <div className="cook__meta">
          {[time && `⏱ ${time}`, countsLine(recipe)].filter(Boolean).join(" · ")}
          {awake && (
            <>
              {" "}
              <span className="awake-chip" title="The screen will stay on while you cook">
                ● screen on
              </span>
            </>
          )}
        </div>

        {recipe.sourceUrl && (
          <a
            className="cook__source"
            href={recipe.sourceUrl}
            /* Opens the original Reel in Instagram/TikTok. `rel=noreferrer`
               because `target=_blank` otherwise hands the opened page a
               `window.opener` handle back into this one. */
            target="_blank"
            rel="noreferrer noopener"
          >
            ↗ {recipe.sourceAuthor ? `@${recipe.sourceAuthor.replace(/^@/, "")}` : host || "source"}
            <span className="badge">{PLATFORM_LABEL[recipe.sourcePlatform]}</span>
          </a>
        )}

        {base !== null && servings !== null ? (
          <div className="scaler">
            <button
              type="button"
              className="scaler__btn"
              onClick={() => setServings((s) => Math.max(1, (s ?? base) - 1))}
              disabled={servings <= 1}
              aria-label="Fewer servings"
            >
              −
            </button>
            {/* aria-live so the new value is announced when the buttons are
                pressed — otherwise a screen-reader user hears nothing change. */}
            <div className="scaler__val" aria-live="polite">
              <div className="scaler__num">{servings}</div>
              <div className="scaler__unit">servings</div>
            </div>
            <button
              type="button"
              className="scaler__btn"
              onClick={() => setServings((s) => Math.min(99, (s ?? base) + 1))}
              disabled={servings >= 99}
              aria-label="More servings"
            >
              +
            </button>
            {factor !== 1 && (
              <>
                <span className="scaler__note">scaled from {base}</span>
                <button
                  type="button"
                  className="btn btn--sm scaler__reset"
                  onClick={() => setServings(base)}
                >
                  Reset
                </button>
              </>
            )}
          </div>
        ) : (
          recipe.servings && <div className="cook__meta">🍽 {recipe.servings}</div>
        )}

        {/* role="tablist" is the honest description of a segmented control, and
            it gives arrow-key semantics to assistive tech for free. */}
        <div className="segmented" role="tablist" aria-label="Recipe sections">
          {(
            [
              ["ingredients", `Ingredients ${recipe.ingredients.length}`],
              ["steps", `Steps ${doneSteps.size}/${recipe.steps.length}`],
              ["about", "About"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="segmented__btn"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="cook__panel">
        {tab === "ingredients" && (
          <>
            {scaled.length === 0 && (
              <p className="muted">
                No ingredients were extracted. Tap <strong>Edit</strong> under About to add them.
              </p>
            )}
            {scaled.map((ing, i) => {
              const head = [ing.quantity, ing.unit].filter(Boolean).join(" ");
              return (
                <button
                  key={i}
                  type="button"
                  className="tick-row"
                  aria-pressed={ticked.has(i)}
                  /* The accessible label uses lib/scale's canonical one-string
                     rendering — the same function the grocery list formats
                     with, so the two can never describe an ingredient
                     differently. */
                  aria-label={formatIngredient(ing, { withNote: true })}
                  onClick={() => toggleTick(i)}
                >
                  <span className="tick-box" aria-hidden>
                    ✓
                  </span>
                  <span className="tick-text">
                    {head && <strong>{head} </strong>}
                    {ing.item}
                    {ing.note && <span className="tick-note">{ing.note}</span>}
                  </span>
                </button>
              );
            })}
          </>
        )}

        {tab === "steps" && (
          <>
            {recipe.steps.length === 0 && <p className="muted">No steps were extracted.</p>}
            {recipe.steps.map((step, i) => (
              <button
                key={i}
                type="button"
                className={`tick-row step-row${i === currentStep ? " step-row--current" : ""}`}
                aria-pressed={doneSteps.has(i)}
                aria-current={i === currentStep ? "step" : undefined}
                onClick={() => toggleStep(i)}
              >
                <span className="step-num" aria-hidden>
                  {doneSteps.has(i) ? "✓" : i + 1}
                </span>
                <span className="tick-text">{step}</span>
              </button>
            ))}
          </>
        )}

        {tab === "about" && (
          <div className="stack">
            {recipe.description && <p style={{ margin: 0 }}>{recipe.description}</p>}

            {recipe.notes && (
              <div>
                <span className="section-title">Notes</span>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{recipe.notes}</p>
              </div>
            )}

            {recipe.tags.length > 0 && (
              <div className="row row--wrap">
                {recipe.tags.map((t) => (
                  <span key={t} className="badge">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.7 }}>
              {recipe.cookedCount > 0 && (
                <div>
                  Cooked {recipe.cookedCount}× · last {relativeTime(recipe.lastCookedAt)}
                </div>
              )}
              <div>Saved {relativeTime(recipe.createdAt)}</div>
              {/* PROVENANCE (PRD F13): which tier produced this, and how sure it
                  was. When a recipe looks wrong, this is the difference between
                  "the site published it as JSON-LD" and "a model guessed off a
                  noisy transcript". */}
              {recipe.extraction && (
                <div>
                  Extracted via {recipe.extraction.tiers.join(" → ") || "unknown"}
                  {recipe.extraction.model ? ` · ${recipe.extraction.model}` : ""}
                  {` · confidence ${Math.round(recipe.extraction.confidence * 100)}%`}
                </div>
              )}
            </div>

            <div className="row">
              <button type="button" className="btn btn--block" onClick={() => setEditing(true)}>
                ✎ Edit recipe
              </button>
            </div>
            <button
              type="button"
              className="btn btn--danger btn--block"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete recipe
            </button>
          </div>
        )}
      </div>

      <div className="cook__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={addToGrocery}
          disabled={busy !== null}
        >
          {busy === "grocery" ? <span className="spinner" /> : "🛒"} Add to list
        </button>
        <button type="button" className="btn" onClick={markCooked} disabled={busy !== null}>
          {busy === "cooked" ? <span className="spinner" /> : "🍳"} Cooked it
        </button>
        <button
          type="button"
          className="fav-btn fav-btn--inline btn btn--icon"
          aria-pressed={recipe.favorite}
          aria-label={recipe.favorite ? "Remove from favourites" : "Add to favourites"}
          onClick={toggleFavorite}
          style={{ flex: "0 0 44px" }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"
              fill={recipe.favorite ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {confirmingDelete && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-title"
          /* Tapping the backdrop cancels — but only the backdrop itself, not a
             click that bubbled up from inside the dialog. */
          onClick={(e) => e.target === e.currentTarget && setConfirmingDelete(false)}
        >
          <div className="modal stack">
            <h2 id="del-title" style={{ fontSize: 18 }}>
              Delete “{recipe.title}”?
            </h2>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              This can&apos;t be undone. The original {PLATFORM_LABEL[recipe.sourcePlatform]} post
              stays where it is.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn btn--block"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="btn btn--danger btn--block"
                onClick={reallyDelete}
                disabled={busy === "delete"}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast message={toast?.text ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </div>
  );
}
