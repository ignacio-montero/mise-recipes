"use client";

import Link from "next/link";
import Thumb from "./Thumb";
import { PLATFORM_LABEL, metaLine } from "./format";
import type { Recipe } from "./types";

/**
 * One row of the recipe list.
 *
 * STRUCTURE: a <div> containing a <Link> (the whole card body) and a sibling
 * <button> (the favourite star) laid over the right edge. NOT a <button> nested
 * inside an <a> — that is invalid HTML and browsers disagree about what a click
 * on the inner one means. Because the two targets don't overlap, there is no
 * need for `event.stopPropagation()` at all.
 *
 * CONCEPT — EVENT PROPAGATION, and why it's absent here. A click on a nested
 * element BUBBLES up through its ancestors, so a star inside the link would
 * fire the star's handler and then navigate. The usual fix is
 * `e.stopPropagation()` / `e.preventDefault()` in the inner handler — which
 * works, but leaves an invisible rule that breaks the moment someone adds a
 * third control. Laying the targets out side by side removes the class of bug
 * instead of patching it.
 *
 * `favorite` is rendered from the PARENT's state, not from local state: the
 * parent owns the optimistic update so that a failed request can roll the row
 * back. A card holding its own copy would drift from the list it lives in.
 */
export default function RecipeCard({
  recipe,
  onToggleFavorite,
}: {
  recipe: Recipe;
  onToggleFavorite: (recipe: Recipe) => void;
}) {
  const meta = metaLine(recipe);

  return (
    <article className="recipe-card">
      <Link className="recipe-card__link" href={`/recipe/${recipe.id}`}>
        <Thumb src={recipe.heroImagePath} title={recipe.title} seed={recipe.id} />
        <div className="recipe-card__body">
          <h2 className="recipe-card__title">{recipe.title}</h2>
          {meta && <div className="recipe-card__meta">{meta}</div>}
          <div className="recipe-card__tags">
            <span className={`badge badge--${recipe.sourcePlatform}`}>
              {PLATFORM_LABEL[recipe.sourcePlatform] ?? recipe.sourcePlatform}
            </span>
            {recipe.cookedCount > 0 && (
              <span className="badge">
                Cooked {recipe.cookedCount}×
              </span>
            )}
          </div>
        </div>
      </Link>

      <button
        type="button"
        className="fav-btn"
        aria-pressed={recipe.favorite}
        /* The accessible name says what the button DOES, not what it shows —
           "Favourite" alone would read identically in both states. */
        aria-label={recipe.favorite ? `Remove ${recipe.title} from favourites` : `Favourite ${recipe.title}`}
        onClick={() => onToggleFavorite(recipe)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false">
          <path
            d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"
            fill={recipe.favorite ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </article>
  );
}
