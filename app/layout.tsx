import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Mise",
  description: "Recipes from Reels and TikToks, clean and cookable.",
  applicationName: "Mise",
  // Home-screen install. WITHOUT `apple-touch-icon` iOS uses a SCREENSHOT of
  // the page as the Home Screen icon — here, a washed-out recipe list.
  icons: {
    icon: [{ url: "/icons/favicon.png", type: "image/png", sizes: "32x32" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,   // opens chromeless from the Home Screen
    title: "Mise",   // the label under the icon
    // "default" = dark status-bar text over the page background. NOT
    // "black-translucent", which draws the status text directly over the page
    // and would put white glyphs on the cream header.
    statusBarStyle: "default",
  },
  other: {
    // Next 15 emits `appleWebApp.capable` as the modern, unprefixed
    // <meta name="mobile-web-app-capable">. iOS before 17 only recognises the
    // Apple-prefixed spelling, and without it the Home Screen shortcut opens
    // inside Safari's chrome instead of standalone. Both tags cost two bytes.
    "apple-mobile-web-app-capable": "yes",
  },
  // Stops iOS turning "180 g" and stray numbers in a caption into phone links.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays ENABLED (no maximumScale): blocking it is an
  // accessibility regression for anyone enlarging an ingredient line.
  //
  // `viewport-fit: cover` lets the app paint into the notch / home-indicator
  // area; globals.css then uses env(safe-area-inset-*) to keep every control
  // clear of it.
  viewportFit: "cover",
  // Two entries so the iOS status bar and Android chrome match the actual
  // background in both themes — a single light value flashes white in dark mode.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf6f1" },
    { media: "(prefers-color-scheme: dark)", color: "#16130f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Skip link first, so a keyboard user's very first Tab offers a way
            past the navigation. It is the standard remedy for the fact that the
            tab bar sits at the BOTTOM visually on phones while coming FIRST in
            the DOM — CSS `order` moves pixels, never the focus sequence. */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app-shell">
          {/* Nav before main: the conventional landmark order. globals.css
              places it visually at the bottom on phones, at the top ≥720px. */}
          <Nav />
          <main className="app-main" id="main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
