import RecipeList from "@/components/RecipeList";

/**
 * `/` — the recipe list.
 *
 * This page component is a SERVER COMPONENT that renders one client component.
 * That is the "client boundary as low as possible" rule: the page itself ships
 * no JavaScript to the browser, and only the interactive subtree (search,
 * chips, optimistic stars) does.
 *
 * CONCEPT — SERVER vs CLIENT COMPONENTS. In the App Router every component is a
 * server component by default: it runs only during the request, its code never
 * reaches the browser bundle, and it can't use state or event handlers.
 * `"use client"` marks the boundary where a component (and everything it
 * imports) is also shipped to the browser and HYDRATED — React re-attaching
 * event listeners to the server-rendered HTML. Keeping the boundary low means a
 * smaller bundle; keeping it too low means prop-drilling through it.
 */
export const metadata = { title: "Recipes · Mise" };

export default function HomePage() {
  return <RecipeList />;
}
