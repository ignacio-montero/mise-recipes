import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at /manifest.webmanifest.
 *
 * A Next FILE CONVENTION (app/manifest.ts) rather than a static
 * public/manifest.json, deliberately: Next serves this with the correct
 * `application/manifest+json` content type. A manifest served as text/plain is
 * silently ignored — the failure mode is "Add to Home Screen just doesn't
 * behave like an app", with nothing in the console to explain why.
 *
 * `display: "standalone"` is the single line that removes the address bar and
 * makes the shortcut open like an app (PRD F12). `start_url: "/"` means it
 * always opens on the recipe list — the screen you want when you pick the phone
 * up mid-cook — rather than wherever it was last backgrounded.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mise — recipes from Reels",
    short_name: "Mise",
    description: "Recipes saved from Instagram Reels and TikToks, clean and cookable.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf6f1",
    theme_color: "#c04f28",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      // `maskable` lets Android crop the artwork to its launcher's shape. Safe
      // to declare because the bowl sits inside the inner-80% safe zone (see
      // scripts/make-icons.mjs) — a cropped corner loses only flat paprika.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // App shortcuts: a long-press on the Home Screen icon jumps straight to the
    // paste box. Android honours these today; iOS ignores them harmlessly.
    shortcuts: [
      { name: "Add a recipe", short_name: "Add", url: "/add" },
      { name: "Grocery list", short_name: "Grocery", url: "/grocery" },
    ],
  };
}
