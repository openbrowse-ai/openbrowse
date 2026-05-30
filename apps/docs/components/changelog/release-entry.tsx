import type { Release } from "@/lib/changelog";
import { GitCompare } from "lucide-react";

// Releases with notes longer than this (in rendered HTML chars) are collapsed
// behind an "Expand release" toggle to keep the timeline scannable.
const COLLAPSE_THRESHOLD = 1600;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function CompareButton({ release }: { release: Release }) {
  if (!release.compareUrl) return null;
  return (
    <a
      href={release.compareUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-4 inline-flex w-fit items-center gap-2 rounded-[0.125rem] border px-3 py-1.5 font-mono text-[0.8125rem] text-foreground transition-colors hover:border-muted-foreground hover:bg-muted"
    >
      <GitCompare className="size-3.5" />
      Full Changelog
      {release.compareRange && (
        <span className="text-muted-foreground">{release.compareRange}</span>
      )}
    </a>
  );
}

export function ReleaseEntry({ release }: { release: Release }) {
  const isLong = release.bodyHtml.length > COLLAPSE_THRESHOLD;

  return (
    <article
      data-collapsible={isLong ? "" : undefined}
      className="changelog-entry border-t border-dashed py-10 first:border-t-0 first:pt-0"
    >
      <header className="changelog-sticky-header sticky top-14 z-10 -mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/60 bg-background pt-2 pb-2">
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${release.name} release notes on GitHub (opens in new tab)`}
          className="font-mono text-2xl font-bold tracking-tight text-foreground transition-colors hover:text-primary"
        >
          {release.name}
        </a>
        <time
          dateTime={release.date}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatDate(release.date)}
        </time>
        {release.isPrerelease && (
          <span className="inline-flex rounded-[0.125rem] border px-1.5 py-0.5 text-xs text-muted-foreground">
            Pre-release
          </span>
        )}
      </header>

      <div className="changelog-body-wrap relative mt-5">
        <div className="changelog-prose-clip">
          <div
            className="changelog-prose max-w-none"
            dangerouslySetInnerHTML={{ __html: release.bodyHtml }}
          />
          <CompareButton release={release} />
        </div>
        {isLong && (
          <details className="changelog-toggle">
            {/* Visible label is supplied via CSS ::after; this gives screen
                readers an accessible name without duplicating it visually. */}
            <summary>
              <span className="sr-only">Toggle release details</span>
            </summary>
          </details>
        )}
      </div>
    </article>
  );
}
