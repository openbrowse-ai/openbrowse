import "./globals.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import { IBM_Plex_Sans, Young_Serif } from "next/font/google";
import localFont from "next/font/local";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const lilex = localFont({
  src: "./fonts/lilex-latin-400-normal.woff2",
  variable: "--font-mono",
  display: "swap",
  weight: "400",
});

const youngSerif = Young_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    template: "%s | OpenBrowse",
    default: "OpenBrowse — The open source browser agent",
  },
  description:
    "A free, model-agnostic alternative to Claude for Chrome, Gemini in Chrome, and Perplexity Comet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable} ${lilex.variable} ${youngSerif.variable}`}
    >
      <head>
        <link rel="icon" href="/icon/logo.svg" type="image/svg+xml" media="(prefers-color-scheme: light)" />
        <link rel="icon" href="/icon/logo-dark.svg" type="image/svg+xml" media="(prefers-color-scheme: dark)" />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
