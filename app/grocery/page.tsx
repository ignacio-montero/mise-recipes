import GroceryList from "@/components/GroceryList";

/**
 * `/grocery` — the shopping list (PRD F11).
 *
 * Server shell, client body — see the note in `app/add/page.tsx`. The list is
 * unavoidably a client component: every row is an optimistic toggle, and the
 * whole point of the screen is that a tap paints instantly while standing in a
 * supermarket aisle on a bad connection.
 */
export const metadata = { title: "Grocery · Mise" };

export default function GroceryPage() {
  return <GroceryList />;
}
