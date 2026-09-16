"use client";

import { useCallback, useEffect, useState } from "react";
import Sheet from "./Sheet";
import NewFolderForm from "./NewFolderForm";
import { ErrorState } from "./States";
import { apiGet, apiPut, errorMessage } from "./api";
import { folderLabel, knownIds, sameIdSet, sortFolders, toggleFolderId } from "./folders";
import type { Folder, FolderListResponse, Recipe, RecipeResponse } from "./types";

/**
 * "Which folders is this recipe in?" — opened from the cook view's About tab.
 *
 * A MULTI-SELECT, because the data model is many-to-many: "chocolate mousse" is
 * both a dessert and something you batch-cook. Rows reuse `.tick-row` with
 * `aria-pressed`, the same control the ingredient checklist uses — a folder row
 * is the same gesture (tap to toggle) and should not look like a new idea.
 *
 * WHY THIS FETCHES ITS OWN FOLDER LIST
 * ------------------------------------
 * The cook view has no reason to know about folders until you open this sheet,
 * and fetching them with the recipe would put a second request on the critical
 * path of the screen the whole app exists for. So the fetch is deferred to the
 * moment the sheet mounts. (The home screen is the opposite case: its chips ARE
 * folders, so `RecipeList` loads them up front and passes them down to the
 * manager sheet.)
 *
 * WHY SAVE IS NOT OPTIMISTIC, when nearly everything else here is
 * ---------------------------------------------------------------
 * `PUT /api/recipes/:id/folders` replaces the whole set behind an explicit Save
 * button. The user has already committed to waiting by pressing it, the result
 * is not visible behind the sheet, and the response carries the authoritative
 * recipe the parent needs. Optimism buys nothing and would need a rollback path
 * through a sheet that has already closed. Ticking a row IS instant — that part
 * is local draft state, not a write.
 */
export default function FolderPicker({
  recipeId,
  folderIds,
  onClose,
  onSaved,
}: {
  recipeId: string;
  /** The recipe's current folders, from the already-loaded recipe. */
  folderIds: readonly string[];
  onClose: () => void;
  /** Handed the server's updated recipe plus the folder list as this sheet last
   *  saw it, so the caller can refresh both without a second round trip. */
  onSaved: (recipe: Recipe, folders: Folder[]) => void;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  /** DRAFT STATE: the sheet's own copy, thrown away on Cancel. The recipe is
   *  only changed by the PUT, so closing without saving cannot leave the screen
   *  behind it disagreeing with the database. */
  const [selected, setSelected] = useState<string[]>([...folderIds]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const { folders: fresh } = await apiGet<FolderListResponse>("/api/folders");
      const list = sortFolders(fresh ?? []);
      setFolders(list);
      // Drop ids for folders deleted since this recipe was loaded — the PUT
      // rejects unknown ids with a 400, and the user did nothing wrong.
      setSelected((cur) => knownIds(cur, list));
      setStatus("ready");
    } catch (e) {
      setError(errorMessage(e, "Couldn't load your folders."));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = !sameIdSet(selected, folderIds);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const { recipe } = await apiPut<RecipeResponse>(`/api/recipes/${recipeId}/folders`, {
        folderIds: selected,
      });
      onSaved(recipe, folders);
    } catch (e) {
      setError(errorMessage(e, "Couldn't save that."));
      setSaving(false);
    }
  }

  return (
    <Sheet
      title="Folders"
      onClose={onClose}
      footer={
        <div className="row">
          <button type="button" className="btn btn--block" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void save()}
            disabled={saving || !dirty || status !== "ready"}
          >
            {saving ? <span className="spinner" /> : null}
            {dirty ? "Save" : "Saved"}
          </button>
        </div>
      }
    >
      {status === "loading" && (
        <div className="stack" aria-busy="true">
          <span className="visually-hidden">Loading folders…</span>
          <div className="skeleton" style={{ height: 44 }} />
          <div className="skeleton" style={{ height: 44 }} />
        </div>
      )}

      {status === "error" && <ErrorState message={error} onRetry={() => void load()} />}

      {status === "ready" && (
        <>
          {folders.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>
              No folders yet. Make one — “desserts”, “batch-cooking”, whatever you actually
              reach for — and this recipe goes straight into it.
            </p>
          ) : (
            <div className="folder-pick">
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="tick-row"
                  aria-pressed={selected.includes(f.id)}
                  onClick={() => setSelected((cur) => toggleFolderId(cur, f.id))}
                >
                  <span className="tick-box" aria-hidden>
                    ✓
                  </span>
                  <span className="tick-text">{folderLabel(f)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="folder-new-wrap">
            <span className="section-title">＋ New folder</span>
            <NewFolderForm
              folders={folders}
              submitLabel="Add"
              onCreated={(folder) => {
                setFolders((cur) => sortFolders([...cur, folder]));
                // Created FROM this recipe, so it is obviously meant for it:
                // selecting it saves a second tap and matches "create and
                // assign in one go". Still a draft — Save is what writes it.
                setSelected((cur) => toggleFolderId(cur, folder.id));
              }}
            />
          </div>

          {error && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
