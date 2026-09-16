/**
 * The three states every API-backed view owes the user besides "here is your
 * data": loading, empty, and error. They live in one file so no screen can
 * quietly skip one — the commonest bug in fetch-driven UI is a component that
 * renders `items.map(...)` over an empty array and shows a blank rectangle
 * with no explanation.
 */

/** Shape-of-the-answer placeholders, not a spinner: the layout doesn't jump
 *  when the real rows land (this is the "skeleton screen" pattern). */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="recipe-list" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice--error stack" role="alert">
      <div>{message}</div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  mark,
  title,
  children,
}: {
  mark: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden>
        {mark}
      </div>
      <div className="empty__title">{title}</div>
      <div className="empty__body">{children}</div>
    </div>
  );
}
