import { Nav } from "@/components/landing/nav";
import { Footer } from "@/components/landing/footer";
import type { ReactNode } from "react";

export default function ChangelogLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-6 py-12">{children}</main>
      <Footer />
    </>
  );
}
