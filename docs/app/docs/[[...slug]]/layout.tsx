import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { Logo } from "@/components/logo";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="flex items-center gap-2">
            <Logo className="h-5 w-5" />
            OpenBrowse
          </span>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
