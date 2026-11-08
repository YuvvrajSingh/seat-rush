import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next, Big_Shoulders } from "next/font/google";
import type { ReactNode } from "react";
import { env } from "../env.js";
import "./globals.css";

// Neither family has metric overrides in next/font, so name the fallbacks explicitly.
const display = Big_Shoulders({
  subsets: ["latin"],
  variable: "--font-big-shoulders",
  display: "swap",
  fallback: ["Arial Narrow", "sans-serif"],
  adjustFontFallback: false,
});

const body = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-atkinson",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  adjustFontFallback: false,
});

const description =
  "1,000 simulated customers race for 100 cinema seats. A live view shows every seat ends up with exactly one owner.";

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: {
    default: "SeatRush",
    template: "%s | SeatRush",
  },
  description,
  openGraph: { type: "website", siteName: "SeatRush", title: "SeatRush", description },
  twitter: { card: "summary_large_image", title: "SeatRush", description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eceef4" },
    { media: "(prefers-color-scheme: dark)", color: "#12141c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
