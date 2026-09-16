"use client";

import { useState } from "react";
import Sheet from "./Sheet";
import NewFolderForm from "./NewFolderForm";
import { ApiClientError, apiDelete, apiPatch, errorMessage } from "./api";
import {
  cleanEmoji,
  cleanFolderName,
  deleteFolderWarning,
  folderLabel,
  nameTaken,
  removeFolderById,
  upsertFolder,
} from "./folders";
import type { Folder } from "./types";

/**
 * Create / rename / delete folders. Opened from the “⚙ Folders” chip at the end
 * of the home screen's filter row.
 *
 * WHY HERE AND NOT ON A /folders ROUTE WITH ITS OWN TAB
 * ----------------------------------------------------
 * Management lives where the thing being managed is visible: the chips ARE the
 * folders, so the control that edits them sits at the end of that row. A fourth
 * tab would spend permanent bottom-bar real estate — the most valuable space in
 * a phone app — on a screen you visit twice a year, and push "Add", which is
 * the whole point of Mise, off-centre. Discarded also: long-press on a chip,
 * which is invisible, has no hover hint, and on iOS fights the text-selection
 * callout.
 *
 * CONTROLLED FROM THE PARENT: this sheet does not own the folder list, it
 * receives it and reports changes back through `onChanged`. The chips behind
 * the sheet are rendered from that same list, so a rename shows up on them
 * immediately — if this component kept a private copy, the two would drift and
 * the screen would need a reload to agree with itself. (This is the
 * "lifting state up" pattern; the owner is the component that has to render it
 * in more than one place.)
 */
export default function FolderManager({
  folders,
  onClose,
  onChanged,
}: {
  folders: Folder[];
  onClose: () => void;
  onChanged: (folders: Folder[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftEmoji, setDraftEmoji] = useState("");
  /** Two-tap confirm rather than a nested dialog — a modal on top of a modal is
   *  where focus management goes to die, and the grocery list already uses this
   *  idiom for "Clear checked". */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function startEdit(folder: Folder) {
    setEditingId(folder.id);
    setDraftName(folder.name);
    setDraftEmoji(folder.emoji ?? "");
    setConfirmingId(null);
    setError("");
  }

  async function saveRename(folder: Folder) {
    const name = cleanFolderName(draftName);
    if (!name) return;
    const emoji = cleanEmoji(draftEmoji);
    // Nothing actually changed — close the editor without touching the network.
    if (name === folder.name && emoji === (folder.emoji ?? null)) {
      setEditingId(null);
      return;
    }
    setBusyId(folder.id);
    setError("");
    try {
      const { folder: saved } = await apiPatch<{ folder: Folder }>(`/api/folders/${folder.id}`, {
        name,
        emoji,
      });
      onChanged(upsertFolder(folders, saved));
      setEditingId(null);
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.code === "conflict"
          ? "You already have a folder with that name."
          : errorMessage(e, "Couldn't rename that folder."),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function remove(folder: Folder) {
    setBusyId(folder.id);
    setError("");
    try {
      await apiDelete(`/api/folders/${folder.id}`);
      onChanged(removeFolderById(folders, folder.id));
      setConfirmingId(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't delete that folder."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Sheet title="Folders" onClose={onClose}>
      <div className="folder-new-wrap folder-new-wrap--top">
        <span className="section-title">＋ New folder</span>
        <NewFolderForm folders={folders} onCreated={(f) => onChanged(upsertFolder(folders, f))} />
      </div>

      {folders.length === 0 ? (
        <p className="muted">
          No folders yet. They're just labels — a recipe can sit in several, and deleting a
          folder never deletes what's in it.
        </p>
      ) : (
        <ul className="folder-manage">
          {folders.map((folder) => {
            const busy = busyId === folder.id;
            const editing = editingId === folder.id;
            const cleaned = cleanFolderName(draftName);
            const duplicate = cleaned !== null && nameTaken(folders, cleaned, folder.id);

            return (
              <li key={folder.id} className="folder-manage__row">
                {editing ? (
                  <div className="stack-sm" style={{ width: "100%" }}>
                    <div className="row">
                      <input
                        className="input input--emoji"
                        value={draftEmoji}
                        onChange={(e) => setDraftEmoji(e.target.value)}
                        aria-label={`Emoji for ${folder.name}`}
                        placeholder="🍰"
                        maxLength={8}
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                      <input
                        className="input"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        aria-label={`Rename ${folder.name}`}
                        enterKeyHint="done"
                        autoCapitalize="none"
                        /* autoFocus is right here and nowhere else in this app:
                           the field appeared BECAUSE the user asked to rename,
                           so the keyboard is what they want next. On page load
                           it would be a hijack. */
                        autoFocus
                        disabled={busy}
                      />
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--sm btn--block"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary btn--block"
                        onClick={() => void saveRename(folder)}
                        disabled={busy || cleaned === null || duplicate}
                      >
                        {busy ? <span className="spinner" /> : null}
                        {duplicate ? "Name taken" : "Save"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="folder-manage__name"
                      onClick={() => startEdit(folder)}
                      aria-label={`Rename ${folder.name}`}
                    >
                      <span className="folder-manage__label">{folderLabel(folder)}</span>
                      <span className="muted folder-manage__count">
                        {folder.recipeCount} recipe{folder.recipeCount === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={confirmingId === folder.id ? "btn btn--sm btn--danger" : "btn btn--sm"}
                      onClick={() =>
                        confirmingId === folder.id ? void remove(folder) : setConfirmingId(folder.id)
                      }
                      disabled={busy}
                      /* The two taps say different things, so they need
                         different accessible names. */
                      aria-label={
                        confirmingId === folder.id
                          ? deleteFolderWarning(folder)
                          : `Delete the folder ${folder.name}`
                      }
                    >
                      {busy ? <span className="spinner" /> : confirmingId === folder.id ? "Really?" : "Delete"}
                    </button>
                  </>
                )}

                {confirmingId === folder.id && !editing && (
                  /* The warning is spelled out, not implied: "delete folder"
                     reads like "delete the recipes in it" to anyone who has met
                     a filesystem. `aria-live` so it is announced when it
                     appears, since it appears without focus moving. */
                  <p className="folder-manage__warn" aria-live="polite">
                    {deleteFolderWarning(folder)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
