import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { CompatibilityGrid } from "@/components/landing/compatibility-grid";
import { ConnectorsGrid } from "@/components/landing/connectors-grid";
import { TabsScene } from "@/components/landing/scenes/tabs/TabsScene";
import { TrustStrip } from "@/components/landing/trust-strip";
import { FAQ } from "@/components/landing/faq";
import { Footer } from "@/components/landing/footer";

export default function LandingPage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <CompatibilityGrid />
        <ConnectorsGrid />
        <section className="mx-auto max-w-6xl px-6 py-24 border-t">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div className="flex flex-col gap-4">
              <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
                Stay organized effortlessly.
              </h2>
              <p className="text-lg text-muted-foreground">
                Hit ⌥K from any tab to pull up the command palette. Search tabs, history, and bookmarks instantly, or let the agent tidy up your messy tabs into themed spaces.
              </p>
            </div>
            <TabsScene />
          </div>
        </section>
        <TrustStrip />
        <FAQ />
      </main>
      <Footer />
    </>
  );
}
