import { Nav } from "@/components/landing/nav";
import { Hero } from "@/components/landing/hero";
import { Screenshot } from "@/components/landing/screenshot";
import { Features } from "@/components/landing/features";
import { Providers } from "@/components/landing/providers";
import { AgentTools } from "@/components/landing/agent-tools";
import { FAQ } from "@/components/landing/faq";
import { Footer } from "@/components/landing/footer";

export default function LandingPage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Screenshot />
        <Features />
        <Providers />
        <AgentTools />
        <FAQ />
      </main>
      <Footer />
    </>
  );
}
