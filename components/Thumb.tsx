import { monogram } from "./monogram";

/**
 * A recipe's picture — or, when there isn't one, a generated tile.
 *
 * `heroImagePath` is null for a large share of imports (a caption scrape often
 * yields no usable thumbnail), so the no-image case is the COMMON case, not the
 * edge case, and it gets designed rather than defaulted. See monogram.ts.
 *
 * A plain <img>, not next/image: the images are served by our own
 * `/api/images/:file` route off the Docker volume (API_SPEC §6), and next/image
 * would want to proxy and re-encode them through the optimiser — extra CPU on
 * an N95 for files we already sized at ingest.
 */
export default function Thumb({
  src,
  title,
  seed,
  variant = "card",
}: {
  src: string | null;
  title: string;
  /** Stable id so the colour never changes when the title is edited. */
  seed?: string;
  variant?: "card" | "hero";
}) {
  const cls = variant === "hero" ? "monogram monogram--hero" : "monogram";

  if (src) {
    return (
      <img
        className={variant === "hero" ? "" : "recipe-card__thumb"}
        src={src}
        alt=""
        /* alt="" deliberately: the title is right next to it in the DOM, so
           announcing the image too would just repeat it. Decorative, not
           informative. */
        loading="lazy"
        decoding="async"
      />
    );
  }

  const m = monogram(title, seed);
  return (
    <div className={cls} style={{ background: m.color }} aria-hidden>
      {m.initials}
    </div>
  );
}
