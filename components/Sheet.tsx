"use client";

import { useEffect, useRef } from "react";

/**
 * A bottom sheet: the modal shape that belongs on a phone.
 *
 * WHY A SHEET AND NOT A CENTRED DIALOG (which this app already has, for delete)
 * ---------------------------------------------------------------------------
 * The delete confirm is one sentence and two buttons, so a small centred box is
 * fine. Picking folders is a LIST you scroll and tap repeatedly, and a centred
 * box puts that list in the middle of a 6" screen — out of thumb reach, exactly
 * the argument that put the tab bar at the bottom (see Nav.tsx). A sheet grows
 * upward from the bottom edge, so the rows nearest your thumb are the ones you
 * touch most. It reuses `.modal-backdrop` with one modifier class rather than a
 * second overlay system.
 *
 * ACCESSIBILITY, the three things a dialog owes you:
 *   1. `role="dialog"` + `aria-modal` + a labelled title, so it is announced as
 *      a dialog and not as "group".
 *   2. Escape closes it, and a tap on the BACKDROP closes it — but only when
 *      the tap landed on the backdrop itself. Without the
 *      `e.target === e.currentTarget` guard, a click inside the sheet BUBBLES up
 *      to the backdrop's handler and the sheet shuts under your finger.
 *      (CONCEPT — EVENT BUBBLING: a click fires on the deepest element, then on
 *      each ancestor in turn. `currentTarget` is the element whose handler is
 *      running; `target` is where the click actually landed.)
 *   3. Focus moves into the sheet on open, so a keyboard or VoiceOver user is
 *      not left behind on the button that opened it.
 *
 * NOT implemented: a focus TRAP (cycling Tab inside the sheet). It needs a
 * keydown handler over the tabbable set and `inert` on the rest of the page to
 * be done properly; on a one-user touch app it is the lowest-value 40 lines in
 * the file. Named here so it is a known gap rather than an oversight.
 */
export default function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // `preventScroll` so moving focus doesn't yank the page behind the sheet.
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className="modal-backdrop modal-backdrop--sheet"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="sheet__head">
          <span className="sheet__grip" aria-hidden />
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="btn btn--icon sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}
