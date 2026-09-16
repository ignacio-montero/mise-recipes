"use client";

import { useEffect, useRef } from "react";

/**
 * The visible half of optimistic UI.
 *
 * An optimistic update is a LIE the UI tells for ~40 ms: it paints the new
 * state before the server has agreed. That lie is only acceptable if it is
 * retracted loudly when the server disagrees — otherwise the app quietly
 * disagrees with the database and the user finds out on the next reload. Every
 * rollback in this app surfaces here.
 *
 * `role="alert"` makes assistive tech announce it without needing focus.
 *
 * `tone` defaults to "error" because that is the case this component exists
 * for. The success variant ("Added 9 items to the grocery list") is the same
 * furniture in green, and it gets `role="status"` instead: "alert" is
 * ASSERTIVE — it interrupts a screen reader mid-sentence — which is right for a
 * failed save and rude for a confirmation.
 *
 * `action` (added for "Cooked it" → Undo) is an OPTIONAL affordance rather than
 * a second component, deliberately: an undo toast is the same furniture with a
 * button in it, and a `ToastWithAction` would immediately need every prop this
 * one has plus the same timer, the same tones and the same anchoring above the
 * tab bar. The pattern this implements is "action toast" / "snackbar with
 * action" — the standard alternative to a confirm dialog for a reversible
 * action: don't ask "are you sure?", just do it and offer the way back.
 */
export default function Toast({
  message,
  tone = "error",
  onDismiss,
  action,
  ms = 4000,
}: {
  message: string | null;
  tone?: "ok" | "error";
  onDismiss: () => void;
  /** An undo-style affordance. `onAction` should dismiss the toast itself if it
   *  wants it gone — the button does not assume. */
  action?: { label: string; onAction: () => void } | null;
  ms?: number;
}) {
  /**
   * CONCEPT — THE LATEST-CALLBACK REF. `onDismiss` is almost always an inline
   * arrow (`() => setToast(null)`), which is a NEW function object on every
   * render of the parent. Listing it in the dependency array — as this
   * component used to — meant the effect tore down and re-armed the timer on
   * every unrelated re-render, so "4 seconds" silently became "4 seconds after
   * whatever happened last". Holding the callback in a ref that is refreshed
   * each render keeps the effect depending only on things that should really
   * restart the countdown (the message and the duration), while the timer still
   * calls the *current* callback rather than a stale closure over the first one.
   */
  const dismissRef = useRef(onDismiss);
  // Refreshed in an effect rather than during render: writing to a ref while
  // rendering is a side effect, and React is allowed to render a component
  // twice (StrictMode) or abandon a render half-way (concurrent features).
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => dismissRef.current(), ms);
    return () => clearTimeout(id);
  }, [message, ms]);

  if (!message) return null;
  return (
    <div
      className={tone === "ok" ? "toast toast--ok" : "toast"}
      role={tone === "ok" ? "status" : "alert"}
    >
      <span className="toast__text">{message}</span>
      {action && (
        <button type="button" className="toast__action" onClick={action.onAction}>
          {action.label}
        </button>
      )}
    </div>
  );
}
