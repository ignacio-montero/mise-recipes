"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RecipeCard from "./RecipeCard";
import FolderManager from "./FolderManager";
import Toast from "./Toast";
import { EmptyState, ErrorState, SkeletonList } from "./States";
import { apiGet, apiPatch, errorMessage, isAbort, withQuery } from "./api";
import {
  ALL,
  UNFILED,
  filterByFolder,
  folderLabel,
  folderQueryParam,
  sameFilter,
  sortFolders,
  toggleFilter,
  type FolderFilter,
} from "./folders";
import { useDebouncedQuery } from "./useDebouncedValue";
import type { Folder, FolderListResponse, Recipe, RecipeListResponse, RecipeResponse } from "./types";

/**
 * The home screen: search + filters + the list.
 *
 * WHY THIS IS A CLIENT COMPONENT AND NOT A SERVER COMPONENT
 * ---------------------------------------------------------
 * Search, folder chips and the favourites toggle all change the query on every
 * tap, and the favourite star needs an instant optimistic flip. Rendering that
 * on the server would mean a server round-trip and a full re-render per
 * keystroke. The natural server-component case is "data that is fixed for the
 * life of the page"; this screen is the opposite.
 *
 * Discarded: fetching the first page in a server component and hydrating the
 * client list with it. It is a real win for first paint, but a server component
 * cannot call its own `/api` route with a relative URL — it would need an
 * absolute origin reconstructed from request headers, or a direct Prisma import
 * that bypasses the API contract this app is built around. On a tailnet, with
 * one user, that complexity buys ~80 ms. See docs note in the report.
 */

type Status = "loading" | "ready" | "error";

export default function RecipeList() {
  const [rawQuery, setRawQuery] = useState("");
  const query = useDebouncedQuery(rawQuery, 250);

  const [filter, setFilter] = useState<FolderFilter>(ALL);
  const [favOnly, setFavOnly] = useState(false);
  const [managing, setManaging] = useState(false);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Folders change rarely, so they get their own one-shot fetch instead of
  // riding along with every search. A failure here is non-fatal: the list still
  // works, you just don't get chips.
  useEffect(() => {
    let alive = true;
    apiGet<FolderListResponse>("/api/folders")
      .then((d) => alive && setFolders(sortFolders(d.folders ?? [])))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The folder sheet hands back the whole new list. Two consequences have to be
   * handled here rather than in the sheet, because they are about THIS screen:
   * a filter pointing at a folder that no longer exists has to fall back to
   * All, and a delete changes which recipes match, so the list is re-fetched.
   */
  const applyFolderChange = useCallback((next: Folder[]) => {
    setFolders(sortFolders(next));
    setFilter((cur) => (cur.kind === "folder" && !next.some((f) => f.id === cur.id) ? ALL : cur));
    setReloadKey((k) => k + 1);
  }, []);

  /**
   * CONCEPT — THE STALE-RESPONSE RACE. Type "shr" then "shrimp": two requests
   * are in flight and nothing guarantees they come back in order. If "shr"
   * lands second, the screen shows results for a query the box no longer
   * contains. Debouncing reduces how often this happens; it cannot prevent it.
   * The fix is CANCELLATION: each run aborts the previous request's
   * AbortController, so a superseded response never reaches setState. The
   * cleanup function returned from useEffect is where that abort goes — React
   * calls it before the next effect run and on unmount.
   */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus((s) => (s === "ready" ? "ready" : "loading"));

    apiGet<RecipeListResponse>(
      withQuery("/api/recipes", {
        q: query,
        // `null` for All and for Unfiled — the API has no "not in any folder"
        // filter, so Unfiled is finished on the client below. See the known-gap
        // note in docs/API_SPEC.md §4.
        folder: folderQueryParam(filter),
        favorite: favOnly,
        limit: 100,
      }),
      ctrl.signal,
    )
      .then((data) => {
        setRecipes(data.recipes ?? []);
        setStatus("ready");
        setError("");
      })
      .catch((e) => {
        if (isAbort(e)) return; // superseded, not a failure
        setError(errorMessage(e, "Couldn't load your recipes."));
        setStatus("error");
      });

    return () => ctrl.abort();
  }, [query, filter, favOnly, reloadKey]);

  /** What the list actually renders: the server's page, minus the one filter the
   *  server can't express. `useMemo` because `filterByFolder` returns a new
   *  array every call, which would re-render every card on every keystroke. */
  const visible = useMemo(() => filterByFolder(recipes, filter), [recipes, filter]);

  /**
   * OPTIMISTIC UI: flip the star now, tell the server after, put it back if the
   * server says no. A checkbox that waits for a round trip feels broken even
   * when the round trip is 20 ms, because the delay is between the finger and
   * the pixel. The rollback is the non-negotiable half — see Toast.tsx.
   */
  const toggleFavorite = useCallback(async (recipe: Recipe) => {
    const next = !recipe.favorite;
    setRecipes((list) => list.map((r) => (r.id === recipe.id ? { ...r, favorite: next } : r)));
    try {
      const { recipe: saved } = await apiPatch<RecipeResponse>(`/api/recipes/${recipe.id}`, {
        favorite: next,
      });
      // Reconcile with the server's copy: it is the authority, and it may have
      // changed `updatedAt` or other fields.
      setRecipes((list) => list.map((r) => (r.id === saved.id ? saved : r)));
    } catch (e) {
      setRecipes((list) => list.map((r) => (r.id === recipe.id ? { ...r, favorite: !next } : r)));
      setToast(errorMessage(e, "Couldn't save that."));
    }
  }, []);

  const filtering = query !== "" || filter.kind !== "all" || favOnly;

  return (
    <>
      <div className="sticky-head">
        <div className="search-row">
          <span className="search-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.5 15.5L20 20" />
              </g>
            </svg>
          </span>
          {/* A CONTROLLED COMPONENT: React state is the single source of truth
              for the value, which is what makes the clear button and the
              debounced query derive from one place. */}
          <input
            className="input"
            type="search"
            inputMode="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search recipes, ingredients, tags"
            aria-label="Search recipes"
          />
          {rawQuery && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setRawQuery("")}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="chip-row" role="group" aria-label="Filters">
          <button
            type="button"
            className="chip"
            aria-pressed={favOnly}
            onClick={() => setFavOnly((v) => !v)}
          >
            ★ Favourites
          </button>

          {/* The folder chips are ONE group with one answer: All, Unfiled, or a
              folder. They are still `aria-pressed` buttons rather than radios,
              because the favourites chip beside them really is a toggle and a
              row that mixes the two roles is harder to explain than a row that
              looks uniform and is documented. Tapping the active one returns to
              All, so the filter is always escapable. */}
          {folders.length > 0 && (
            <>
              <button
                type="button"
                className="chip"
                aria-pressed={filter.kind === "all"}
                onClick={() => setFilter(ALL)}
              >
                All
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={filter.kind === "unfiled"}
                onClick={() => setFilter((cur) => toggleFilter(cur, UNFILED))}
                /* No count: the server doesn't report one, and a number derived
                   from the loaded page would be a guess presented as a fact. */
                title="Recipes that aren't in any folder"
              >
                Unfiled
              </button>
              {folders.map((f) => {
                const chipFilter: FolderFilter = { kind: "folder", id: f.id };
                return (
                  <button
                    key={f.id}
                    type="button"
                    className="chip"
                    aria-pressed={sameFilter(filter, chipFilter)}
                    onClick={() => setFilter((cur) => toggleFilter(cur, chipFilter))}
                  >
                    {folderLabel(f)}
                    <span className="chip__count">{f.recipeCount}</span>
                  </button>
                );
              })}
            </>
          )}

          <button
            type="button"
            className="chip chip--action"
            onClick={() => setManaging(true)}
            aria-haspopup="dialog"
          >
            {folders.length > 0 ? "⚙ Folders" : "＋ New folder"}
          </button>
        </div>
      </div>

      <div className="page">
        {status === "loading" && <SkeletonList />}

        {status === "error" && (
          <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
        )}

        {status === "ready" && visible.length === 0 && !filtering && (
          <EmptyState mark="🍲" title="No recipes yet">
            Mise fills up from your phone&apos;s share sheet.
            <ol className="empty__steps">
              <li>
                In Instagram or TikTok, tap <strong>Share → Telegram → your Mise bot</strong>.
              </li>
              <li>The bot replies with the recipe seconds later.</li>
              <li>
                Or copy the link and <Link href="/add" className="link-btn">paste it here</Link>.
              </li>
            </ol>
          </EmptyState>
        )}

        {status === "ready" && visible.length === 0 && filtering && (
          <EmptyState mark="🔍" title="Nothing matches">
            {query ? (
              <>
                No recipe mentions <strong>{query}</strong>.
              </>
            ) : filter.kind === "unfiled" ? (
              <>Every recipe is in a folder. Tidy.</>
            ) : (
              <>No recipes in that filter yet.</>
            )}
          </EmptyState>
        )}

        {status !== "loading" && visible.length > 0 && (
          <div className="recipe-list">
            {visible.map((r) => (
              <RecipeCard key={r.id} recipe={r} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        )}
      </div>

      {managing && (
        <FolderManager
          folders={folders}
          onClose={() => setManaging(false)}
          onChanged={applyFolderChange}
        />
      )}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
