"use client";

import { useEffect } from "react";

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
 */
export default function Toast({
  message,
  onDismiss,
  ms = 4000,
}: {
  message: string | null;
  onDismiss: () => void;
  ms?: number;
}) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDismiss, ms);
    return () => clearTimeout(id);
  }, [message, ms, onDismiss]);

  if (!message) return null;
  return (
    <div className="toast" role="alert">
      {message}
    </div>
  );
}
