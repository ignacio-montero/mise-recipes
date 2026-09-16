import AddView from "@/components/AddView";

/**
 * `/add` — import a recipe from a pasted link, or start one by hand.
 *
 * The page itself is a server component that renders one client component, the
 * convention this app follows everywhere (`app/page.tsx` → `RecipeList`). Two
 * things fall out of that split: `export const metadata` is possible here and
 * would be a build error inside a `"use client"` file, and the page's own code
 * never reaches the browser bundle — only `AddView` and what it imports does.
 */
export const metadata = { title: "Add · Mise" };

export default function AddPage() {
  return <AddView />;
}
