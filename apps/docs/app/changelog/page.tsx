import type { Metadata } from "next";
import { getReleases, RELEASES_URL } from "@/lib/changelog";
import { ReleaseEntry } from "@/components/changelog/release-entry";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every release shipped to OpenBrowse, straight from GitHub.",
};

// Re-fetch GitHub releases hourly at runtime so new releases appear without a
// redeploy. Matches the ISR cadence used by lib/models-dev.ts.
export const revalidate = 3600; // 1 hour

export default async function ChangelogPage() {
  const releases = await getReleases();
  const latest = releases[0];

  return (
    <div className="mx-auto max-w-3xl">
      <header className="border-b pb-10">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-muted-foreground">
          Every release shipped to OpenBrowse, straight from GitHub.
        </p>
        <div className="mt-4 flex items-center gap-3 text-sm">
          {latest && (
            <span className="inline-flex items-center gap-1.5 rounded-[0.125rem] border px-2 py-1 font-mono">
              Latest <span className="text-primary">{latest.name}</span>
            </span>
          )}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub Releases →
          </a>
        </div>
      </header>

      {releases.length > 0 ? (
        <div className="mt-10 flex flex-col">
          {releases.map((release) => (
            <ReleaseEntry key={release.tag} release={release} />
          ))}
        </div>
      ) : (
        <p className="py-16 text-muted-foreground">
          No releases yet.{" "}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Follow along on GitHub
          </a>
          .
        </p>
      )}
    </div>
  );
}
