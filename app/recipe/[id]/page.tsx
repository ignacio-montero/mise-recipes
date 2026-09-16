import CookView from "@/components/CookView";

/**
 * `/recipe/[id]` — the cook view route.
 *
 * A thin SERVER COMPONENT over a client one, the same shape as `app/page.tsx`:
 * this file ships no JavaScript to the browser, it only resolves the route's
 * parameters and hands them to the interactive subtree.
 *
 * CONCEPT — WHY `params` IS A PROMISE IN NEXT 15. In the App Router, `params`
 * and `searchParams` are only knowable once the request is being handled. Next
 * 15 made them async so a page can start rendering its static shell (and stream
 * it to the browser) BEFORE the dynamic parts are resolved — reading them
 * synchronously would force the whole route to block. The practical consequence
 * is the `await` below; forgetting it gives you a Promise where you expected a
 * string, and a URL like `/recipe/[object%20Promise]`.
 *
 * `?edit=1` opens straight into the editor. That is what `/add`'s "write one
 * myself" path uses: POST /api/recipes creates an empty titled recipe, then
 * redirects here, so the single PATCH-based `RecipeEditor` serves both creating
 * by hand and correcting an extraction. The alternative — a second, create-mode
 * form on `/add` — would be a duplicate of a 300-line component that must then
 * be kept in step with it forever.
 */

export const metadata = { title: "Recipe · Mise" };

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;

  return <CookView recipeId={id} initialEdit={edit === "1"} />;
}
