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
  const backdropRef = useRef<HTMLDivElement | null>(null);

  /**
   * Keep the sheet above the on-screen keyboard.
   *
   * ⚠️ THE BUG THIS FIXES: `dvh` does NOT account for the keyboard. It tracks
   * the browser's collapsing URL bar, nothing else. When iOS opens the keyboard
   * the LAYOUT viewport stays the same size and only the VISUAL viewport
   * shrinks — so a `position: fixed` sheet anchored to the bottom of the layout
   * viewport stays exactly where it was, i.e. underneath the keyboard. What you
   * see is a sheet cut off at the bottom whose "Create" button you cannot reach,
   * and scrolling the body does not help because the scrollable area itself is
   * off-screen.
   *
   * `window.visualViewport` is the only way to measure this. The inset is
   * whatever part of the layout viewport the visual viewport no longer covers:
   * `innerHeight - (visualViewport.height + visualViewport.offsetTop)`. We
   * publish it as a CSS variable and let the stylesheet both lift the sheet and
   * shrink its max-height, so the body stays scrollable instead of overflowing.
   *
   * The `scroll` listener is not optional: iOS scrolls the visual viewport when
   * focusing an input near the bottom, which changes `offsetTop` without firing
   * `resize`.
   */
  useEffect(() => {
    const vv = window.visualViewport;
    const el = backdropRef.current;
    if (!vv || !el) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.setProperty("--kb-inset", `${Math.round(inset)}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

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
      ref={backdropRef}
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
