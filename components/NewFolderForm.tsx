"use client";

import { useState } from "react";
import { ApiClientError, apiPost, errorMessage } from "./api";
import { cleanEmoji, cleanFolderName, nameTaken } from "./folders";
import type { Folder } from "./types";

/**
 * "＋ New folder" — used from BOTH folder sheets.
 *
 * WHY ONE SHARED COMPONENT RATHER THAN A FORM IN EACH SHEET
 * --------------------------------------------------------
 * Creating a folder has four non-obvious behaviours — collapse the name, keep
 * only the first emoji glyph, catch the 409 for a duplicate name, and keep what
 * was typed when the request fails. Written twice, those drift; the second copy
 * ends up missing the 409 branch and the user sees "Request failed (409)".
 * The variation between the two call sites is only what happens AFTERWARDS, and
 * that is exactly what `onCreated` is for. (This is the "lift the difference
 * into a prop" move — the component owns the behaviour, the parent owns the
 * consequence.)
 *
 * NOT optimistic, on purpose, for the same reason the grocery list's "Add" is
 * not: a folder painted before the server answers has no id, so it cannot be
 * selected, renamed or deleted for those 200 ms — and in the picker the whole
 * point is that it gets selected the instant it exists.
 */
export default function NewFolderForm({
  folders,
  onCreated,
  submitLabel = "Create",
  placeholder = "Folder name (e.g. desserts)",
}: {
  /** The folders already known, for the local duplicate check. */
  folders: readonly Folder[];
  onCreated: (folder: Folder) => void;
  submitLabel?: string;
  placeholder?: string;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const clean = cleanFolderName(name);
  // The local duplicate check is a courtesy, not the guard: the server's UNIQUE
  // constraint is the only thing that can decide this without a race. It exists
  // so the common mistake is answered instantly instead of by a round trip.
  const duplicate = clean !== null && nameTaken(folders, clean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clean || duplicate || saving) return;
    setSaving(true);
    setError("");
    try {
      const { folder } = await apiPost<{ folder: Folder }>("/api/folders", {
        name: clean,
        // `emoji` is omitted rather than sent as null when empty — the API
        // treats an absent key and an explicit null the same, but sending only
        // what the user actually typed keeps the request honest.
        ...(cleanEmoji(emoji) ? { emoji: cleanEmoji(emoji) } : {}),
      });
      setName("");
      setEmoji("");
      onCreated(folder);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "conflict"
          ? "You already have a folder with that name."
          : errorMessage(err, "Couldn't create that folder."),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="folder-new" onSubmit={submit}>
      <div className="row">
        <input
          className="input input--emoji"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="🍰"
          aria-label="Folder emoji (optional)"
          maxLength={8}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          aria-label="New folder name"
          enterKeyHint="done"
          /* "Desserts", not "desserts" — a folder name is a label the user
             reads, so let the keyboard capitalise it like any other proper noun.
             (The emoji field keeps autoCapitalize="none"; it is not prose.) */
          autoCapitalize="sentences"
          disabled={saving}
        />
        <button
          type="submit"
          className="btn btn--primary"
          style={{ flex: "0 0 auto" }}
          disabled={saving || clean === null || duplicate}
        >
          {saving ? <span className="spinner" /> : submitLabel}
        </button>
      </div>
      {duplicate && (
        <p className="muted folder-new__hint">“{clean}” already exists.</p>
      )}
      {error && (
        <p className="notice notice--error folder-new__hint" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
