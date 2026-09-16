"use client";

import { useCallback, useEffect, useState } from "react";
import Toast from "./Toast";
import { EmptyState, ErrorState, SkeletonList } from "./States";
import { apiDelete, apiGet, apiPatch, apiPost, errorMessage } from "./api";
import {
  applyChecked,
  checkedCount,
  cleanNewItem,
  progressLine,
  removeById,
  sourceLabel,
  splitByChecked,
} from "./grocery";
import type {
  GroceryClearResponse,
  GroceryItem,
  GroceryItemResponse,
  GroceryListResponse,
} from "./types";

/**
 * `/grocery` — the shopping list (PRD F11).
 *
 * WHERE THE OPTIMISM IS, AND WHERE IT DELIBERATELY ISN'T
 * -----------------------------------------------------
 * Ticking an item is OPTIMISTIC: the box fills the instant your thumb lands,
 * and the PATCH catches up afterwards. That is the right call because the
 * action is idempotent, trivially reversible, and performed once per item while
 * standing in an aisle — a 200 ms round trip per tap would make the list feel
 * broken.
 *
 * Adding an item is NOT optimistic, on purpose. A row painted before the server
 * answers has no `id`, so for those 200 ms it cannot be checked or deleted —
 * you would have created a row that ignores taps. The honest alternative is a
 * disabled button and a spinner, which is what this does. (The usual fix is a
 * temporary client-side id reconciled on response; that is real complexity to
 * buy 200 ms on the one action where the user is already typing.)
 *
 * Deleting IS optimistic, with a snapshot: the whole previous array is kept in
 * a local and restored wholesale if the DELETE fails, which puts the row back
 * at its original index rather than on the end.
 *
 * CONCEPT — OPTIMISTIC UI. The interface renders the expected result before the
 * server confirms it, then reconciles. It buys perceived speed; it costs you a
 * rollback path, and a rollback the user can't see is worse than no optimism at
 * all — which is what `Toast` is for. Every optimistic branch below has a
 * matching `setItems(previous)` + toast.
 */

type Status = "loading" | "ready" | "error";

export default function GroceryList() {
  const [items, setItems] = useState<GroceryItem[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  /** Two-tap confirm for "Clear checked" — cheaper than a modal, and enough
   *  friction that a mis-tap in a pocket can't wipe the list. */
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const { items: fresh } = await apiGet<GroceryListResponse>("/api/grocery");
      setItems(fresh ?? []);
      setStatus("ready");
    } catch (e) {
      setError(errorMessage(e, "Couldn't load the grocery list."));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Tick / untick ─────────────────────────────────────────────────────────
  async function toggle(item: GroceryItem) {
    const next = !item.checked;
    const previous = items;
    setItems((current) => applyChecked(current, item.id, next)); // optimistic
    try {
      const { item: saved } = await apiPatch<GroceryItemResponse>(`/api/grocery/${item.id}`, {
        checked: next,
      });
      // Re-apply from the server's copy rather than trusting the optimistic
      // one: `updatedAt` and any server-side text normalisation land here.
      setItems((current) => current.map((x) => (x.id === saved.id ? saved : x)));
    } catch (e) {
      setItems(previous); // roll back…
      setToast({ text: errorMessage(e, "Couldn't save that."), tone: "error" }); // …visibly
    }
  }

  // ── Add a free-text line ──────────────────────────────────────────────────
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const text = cleanNewItem(draft);
    if (!text) return;
    setAdding(true);
    try {
      const { item } = await apiPost<GroceryItemResponse>("/api/grocery", { text });
      // Unchecked items sort oldest-first, so a new one belongs at the end of
      // the open group — which is exactly where appending puts it once
      // `splitByChecked` runs.
      setItems((current) => [...current, item]);
      setDraft("");
    } catch (err) {
      // The text stays in the field: losing what someone just typed because the
      // network hiccuped is the least forgivable kind of data loss.
      setToast({ text: errorMessage(err, "Couldn't add that."), tone: "error" });
    } finally {
      setAdding(false);
    }
  }

  // ── Delete one ────────────────────────────────────────────────────────────
  async function remove(item: GroceryItem) {
    const previous = items;
    setItems((current) => removeById(current, item.id)); // optimistic
    try {
      await apiDelete(`/api/grocery/${item.id}`);
    } catch (e) {
      setItems(previous);
      setToast({ text: errorMessage(e, "Couldn't delete that."), tone: "error" });
    }
  }

  // ── Clear checked ─────────────────────────────────────────────────────────
  async function clearChecked() {
    const previous = items;
    setClearing(true);
    setItems((current) => current.filter((x) => !x.checked)); // optimistic
    try {
      // `?checked=true` is required by the API, not a default: a bare DELETE
      // that wiped the whole list would be one typo away.
      const { deleted } = await apiDelete<GroceryClearResponse>("/api/grocery?checked=true");
      setToast({
        text: `Cleared ${deleted} item${deleted === 1 ? "" : "s"}.`,
        tone: "ok",
      });
    } catch (e) {
      setItems(previous);
      setToast({ text: errorMessage(e, "Couldn't clear those."), tone: "error" });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  }

  const { open, done } = splitByChecked(items);
  const doneCount = checkedCount(items);

  return (
    <>
      {/* The add form lives in the sticky header, not in the scrolling body:
          it is the one control you reach for repeatedly while the list is long,
          and it must not scroll away. */}
      <div className="sticky-head">
        <form className="search-row" onSubmit={add}>
          <input
            className="input"
            style={{ paddingLeft: 12 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item…"
            aria-label="Add a grocery item"
            enterKeyHint="done"
            autoCapitalize="sentences"
            disabled={adding}
          />
          <button
            type="submit"
            className="btn btn--primary"
            disabled={adding || cleanNewItem(draft) === null}
            style={{ flex: "0 0 auto" }}
          >
            {adding ? <span className="spinner" /> : "Add"}
          </button>
        </form>
        {items.length > 0 && (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }} aria-live="polite">
            {progressLine(items)}
          </div>
        )}
      </div>

      <div className="page">
        {status === "loading" && <SkeletonList rows={5} />}

        {status === "error" && <ErrorState message={error} onRetry={() => void load()} />}

        {status === "ready" && items.length === 0 && (
          <EmptyState mark="🧺" title="Nothing on the list">
            Add something above, or open a recipe and tap <strong>Add to list</strong> to push all
            its ingredients here at once.
          </EmptyState>
        )}

        {status === "ready" && items.length > 0 && (
          <>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {open.map((item) => (
                <Row key={item.id} item={item} onToggle={toggle} onDelete={remove} />
              ))}
            </ul>

            {done.length > 0 && (
              <>
                <div
                  className="row"
                  style={{ alignItems: "center", marginTop: 18, marginBottom: 2 }}
                >
                  <span className="section-title" style={{ flex: 1 }}>
                    In the basket · {doneCount}
                  </span>
                  <button
                    type="button"
                    className={confirmClear ? "btn btn--sm btn--danger" : "btn btn--sm"}
                    onClick={() => (confirmClear ? void clearChecked() : setConfirmClear(true))}
                    onBlur={() => setConfirmClear(false)}
                    disabled={clearing}
                  >
                    {clearing ? <span className="spinner" /> : null}
                    {confirmClear ? "Really clear?" : "Clear checked"}
                  </button>
                </div>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {done.map((item) => (
                    <Row key={item.id} item={item} onToggle={toggle} onDelete={remove} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <Toast message={toast?.text ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
    </>
  );
}

/**
 * One line of the list: a big tick target, and a separate delete button.
 *
 * WHY THE SOURCE IS A <span> AND NOT A <Link> TO THE RECIPE
 * --------------------------------------------------------
 * It sits inside the tick <button>, and nesting interactive content inside a
 * button is invalid HTML: browsers recover from it unpredictably, the inner
 * link is unreachable by keyboard, and a tap lands on whichever the browser
 * feels like. The provenance is still shown, just as text. (The same rule is
 * why `RecipeCard` is a div containing a link rather than a giant <a> wrapping
 * the favourite button.)
 */
function Row({
  item,
  onToggle,
  onDelete,
}: {
  item: GroceryItem;
  onToggle: (item: GroceryItem) => void;
  onDelete: (item: GroceryItem) => void;
}) {
  const source = sourceLabel(item);
  return (
    <li className="gro-row">
      <button
        type="button"
        className="tick-row"
        aria-pressed={item.checked}
        onClick={() => onToggle(item)}
      >
        <span className="tick-box" aria-hidden>
          ✓
        </span>
        <span className="tick-text">
          {item.text}
          {source && <span className="gro-src">{source}</span>}
        </span>
      </button>
      <button
        type="button"
        className="gro-del"
        /* The visible label is "×", which a screen reader announces as
           "multiplication sign" or skips entirely — so the real label names the
           item it would remove. */
        aria-label={`Remove ${item.text}`}
        onClick={() => onDelete(item)}
      >
        ×
      </button>
    </li>
  );
}
