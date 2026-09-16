"use client";

import { useState } from "react";
import { parseServingsCount } from "@/lib/scale";
import { insertAt, moveItem, parseTagList, removeAt, replaceAt } from "./arrays";
import { apiPatch, errorMessage } from "./api";
import type { Ingredient, Recipe, RecipePatch, RecipeResponse } from "./types";

/**
 * Inline editing of an extracted recipe.
 *
 * WHY THIS IS A FIRST-CLASS SCREEN AND NOT A BURIED "advanced" DIALOG
 * ------------------------------------------------------------------
 * PRD F9: "extraction is a draft, not gospel." An LLM reading a caption will
 * occasionally merge two ingredients or invent a step, and the fix has to be
 * cheaper than re-typing the recipe or the user stops trusting the app. So the
 * editor is one tap from the cook view and edits every field in place.
 *
 * STATE: a DRAFT COPY, committed on Save.
 * The form holds its own working copy and only tells the parent about it when
 * the PATCH succeeds. That is what makes Cancel free — abandoning the draft is
 * just unmounting this component — and it keeps a half-typed servings field
 * from rescaling the ingredient list under the user's fingers. The discarded
 * alternative, editing the parent's recipe object directly on every keystroke,
 * needs an explicit "original" snapshot to restore on cancel, which is the same
 * copy, kept in a less obvious place.
 *
 * Reordering is up/down BUTTONS, not drag-and-drop: HTML5 drag events don't
 * fire on touch at all, so real mobile drag means pointer-event bookkeeping or
 * a library — and the requirement is "no new dependencies". Two 34px buttons
 * are also more precise with wet hands than a drag ever is.
 */

const EMPTY_INGREDIENT: Ingredient = { quantity: "", unit: "", item: "", note: "" };

export default function RecipeEditor({
  recipe,
  onCancel,
  onSaved,
}: {
  recipe: Recipe;
  onCancel: () => void;
  onSaved: (r: Recipe) => void;
}) {
  const [title, setTitle] = useState(recipe.title);
  const [description, setDescription] = useState(recipe.description ?? "");
  const [servings, setServings] = useState(recipe.servings ?? "");
  const [minutes, setMinutes] = useState(recipe.totalMinutes ? String(recipe.totalMinutes) : "");
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    recipe.ingredients.length ? recipe.ingredients : [EMPTY_INGREDIENT],
  );
  const [steps, setSteps] = useState<string[]>(recipe.steps.length ? recipe.steps : [""]);
  const [notes, setNotes] = useState(recipe.notes ?? "");
  const [tags, setTags] = useState(recipe.tags.join(", "));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("A recipe needs a title.");
      return;
    }
    setSaving(true);
    setError("");

    const parsedMinutes = minutes.trim() === "" ? null : Number.parseInt(minutes, 10);

    // Only the keys API_SPEC §3 lists as writable — the endpoint rejects
    // unknown keys with `bad_request`, so this object is typed as `RecipePatch`
    // rather than as a `Recipe` with fields deleted.
    const patch: RecipePatch = {
      title: cleanTitle,
      description: description.trim() || null,
      servings: servings.trim() || null,
      // Kept in step with the text: the scaler reads `servingsCount`, so if the
      // user edits "6-8 tacos" to "12 tacos" and the count stayed 6, the −/+
      // buttons would silently scale from the wrong base.
      servingsCount: parseServingsCount(servings.trim() || null),
      totalMinutes:
        parsedMinutes !== null && Number.isFinite(parsedMinutes) && parsedMinutes > 0
          ? parsedMinutes
          : null,
      ingredients: ingredients
        .map((i) => ({
          quantity: i.quantity?.trim() || undefined,
          unit: i.unit?.trim() || undefined,
          item: i.item.trim(),
          note: i.note?.trim() || undefined,
        }))
        // A blank row is how you add one; it must not survive the save.
        .filter((i) => i.item !== ""),
      steps: steps.map((s) => s.trim()).filter(Boolean),
      notes: notes.trim() || null,
      tags: parseTagList(tags),
    };

    try {
      const { recipe: saved } = await apiPatch<RecipeResponse>(`/api/recipes/${recipe.id}`, patch);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e, "Couldn't save those changes."));
      setSaving(false);
    }
  }

  const setIng = (i: number, patch: Partial<Ingredient>) =>
    setIngredients((list) => replaceAt(list, i, { ...list[i], ...patch }));

  return (
    <div className="editor">
      <div className="editor__body stack">
        {error && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}

        <label className="field">
          <span className="field__label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="field-grid">
          <label className="field">
            <span className="field__label">Servings</span>
            <input
              className="input"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
              placeholder="6-8 tacos"
            />
          </label>
          <label className="field">
            <span className="field__label">Minutes</span>
            <input
              className="input"
              /* inputMode rather than type="number": a numeric keypad without
                 the spinner arrows, the leading-zero weirdness, or the scroll
                 wheel changing the value by accident. */
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="25"
            />
          </label>
        </div>

        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            className="textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div>
          <span className="section-title">Ingredients</span>
          {ingredients.map((ing, i) => (
            <div className="ed-row" key={i}>
              <div className="ed-row__fields">
                <input
                  className="input input--qty"
                  value={ing.quantity ?? ""}
                  onChange={(e) => setIng(i, { quantity: e.target.value })}
                  placeholder="1 1/2"
                  aria-label={`Quantity for ingredient ${i + 1}`}
                />
                <input
                  className="input input--unit"
                  value={ing.unit ?? ""}
                  onChange={(e) => setIng(i, { unit: e.target.value })}
                  placeholder="cup"
                  aria-label={`Unit for ingredient ${i + 1}`}
                />
                <input
                  className="input input--item"
                  value={ing.item}
                  onChange={(e) => setIng(i, { item: e.target.value })}
                  placeholder="shrimp"
                  aria-label={`Ingredient ${i + 1}`}
                />
                <input
                  className="input"
                  value={ing.note ?? ""}
                  onChange={(e) => setIng(i, { note: e.target.value })}
                  placeholder="note (diced small)"
                  aria-label={`Note for ingredient ${i + 1}`}
                />
              </div>
              <div className="ed-row__btns">
                <button
                  type="button"
                  className="ed-move"
                  disabled={i === 0}
                  onClick={() => setIngredients((l) => moveItem(l, i, i - 1))}
                  aria-label={`Move ingredient ${i + 1} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="ed-move"
                  disabled={i === ingredients.length - 1}
                  onClick={() => setIngredients((l) => moveItem(l, i, i + 1))}
                  aria-label={`Move ingredient ${i + 1} down`}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="ed-move"
                  onClick={() => setIngredients((l) => removeAt(l, i))}
                  aria-label={`Remove ingredient ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginTop: 10 }}
            onClick={() => setIngredients((l) => insertAt(l, l.length, { ...EMPTY_INGREDIENT }))}
          >
            + Add ingredient
          </button>
        </div>

        <div>
          <span className="section-title">Steps</span>
          {steps.map((step, i) => (
            <div className="ed-row" key={i}>
              <div className="ed-row__fields">
                <textarea
                  className="textarea"
                  rows={2}
                  value={step}
                  onChange={(e) => setSteps((l) => replaceAt(l, i, e.target.value))}
                  aria-label={`Step ${i + 1}`}
                />
              </div>
              <div className="ed-row__btns">
                <button
                  type="button"
                  className="ed-move"
                  disabled={i === 0}
                  onClick={() => setSteps((l) => moveItem(l, i, i - 1))}
                  aria-label={`Move step ${i + 1} up`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="ed-move"
                  disabled={i === steps.length - 1}
                  onClick={() => setSteps((l) => moveItem(l, i, i + 1))}
                  aria-label={`Move step ${i + 1} down`}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="ed-move"
                  onClick={() => setSteps((l) => removeAt(l, i))}
                  aria-label={`Remove step ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--sm"
            style={{ marginTop: 10 }}
            onClick={() => setSteps((l) => insertAt(l, l.length, ""))}
          >
            + Add step
          </button>
        </div>

        <label className="field">
          <span className="field__label">Notes</span>
          <textarea
            className="textarea"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Tags (comma separated)</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
      </div>

      <div className="cook__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : null}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
