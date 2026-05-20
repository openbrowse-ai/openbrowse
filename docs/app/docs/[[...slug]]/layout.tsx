import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
import { Wordmark } from "@/components/logo";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: <Wordmark className="h-5" />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
