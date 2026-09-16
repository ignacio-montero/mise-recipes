"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation.
 *
 * WHY A BOTTOM TAB BAR ON PHONES
 * ------------------------------
 * Mise is used one-handed while cooking. The top of a 6" screen is out of thumb
 * reach for a one-handed grip; the bottom third is not. So the bar sits at the
 * bottom on phones and returns to the top at ≥720px, where a bottom bar is a
 * long mouse trip and the thumb argument no longer applies. That flip is one
 * CSS rule (`order`) in globals.css, not a second component.
 *
 * Discarded: a hamburger menu — it hides three destinations behind a tap and a
 * guess. With three, and with "Add" being the whole point of the app, hiding
 * them costs more than the 58px the bar takes.
 *
 * Icons are inline SVG rather than an icon font or a library: three glyphs do
 * not justify a dependency, and inline paths inherit `currentColor`, so the
 * active/inactive colour is a single CSS rule.
 *
 * This component is a CLIENT COMPONENT ("use client") for exactly one reason:
 * `usePathname()` needs the browser's routing state to decide which tab is
 * current. Everything else in the shell stays a server component.
 */

function IconBook() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 17.5z" />
        <path d="M12 6.8v12.2" />
      </g>
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 8.4v7.2M8.4 12h7.2" />
      </g>
    </svg>
  );
}

function IconBasket() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
        <path d="M3.4 9h17.2l-1.7 9.2a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6z" />
        <path d="M8.6 9l2.2-4.8M15.4 9l-2.2-4.8" />
      </g>
    </svg>
  );
}

const LINKS: { href: string; label: string; icon: () => React.ReactElement }[] = [
  { href: "/", label: "Recipes", icon: IconBook },
  { href: "/add", label: "Add", icon: IconPlus },
  { href: "/grocery", label: "Grocery", icon: IconBasket },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="tabbar" aria-label="Primary">
      {/* Visible only at ≥720px, where the bar is a header and has room for a
          wordmark. Hidden on phones by CSS, not by JS, so there is no layout
          shift on hydration. */}
      <span className="tabbar__brand" aria-hidden>
        Mise
      </span>
      {LINKS.map((link) => {
        // "/" must match exactly, or it would light up on every page; the
        // others match by prefix so /recipe/<id> keeps "Recipes" active.
        const active =
          link.href === "/"
            ? pathname === "/" || pathname.startsWith("/recipe")
            : pathname.startsWith(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className="tabbar__link"
            aria-current={active ? "page" : undefined}
          >
            <Icon />
            <span className="tabbar__label">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
