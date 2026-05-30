import { renderMarkdown } from "@/lib/markdown";
import { extractCompareUrl, shortCompareRange } from "@/lib/remark-github-links";
import snapshot from "@/content/changelog-snapshot.json";

const OWNER = "openbrowse-ai";
const REPO = "openbrowse";

export type Release = {
  tag: string;
  name: string;
  date: string; // ISO published_at
  isPrerelease: boolean;
  htmlUrl: string;
  bodyHtml: string; // sanitized HTML
  compareUrl?: string; // GitHub compare URL for this release, if present
  compareRange?: string; // shortened range, e.g. "0.4.1 → 0.4.2"
};

export const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string | null;
  created_at: string;
};

export async function fetchFromGitHub(): Promise<Release[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(`GitHub releases fetch failed: ${res.status}`);
  }

  const raw = (await res.json()) as GitHubRelease[];
  if (!Array.isArray(raw)) {
    throw new Error("GitHub releases response was not an array");
  }
  const published = raw.filter((r) => !r.draft);

  const releases = await Promise.all(
    published.map(async (r): Promise<Release> => {
      const body = r.body ?? "";
      const compareUrl = extractCompareUrl(body);
      return {
        tag: r.tag_name,
        name: r.name?.trim() || r.tag_name,
        date: r.published_at ?? r.created_at,
        isPrerelease: r.prerelease,
        htmlUrl: r.html_url,
        bodyHtml: await renderMarkdown(body),
        compareUrl,
        compareRange: compareUrl ? shortCompareRange(compareUrl) : undefined,
      };
    }),
  );

  releases.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return releases;
}

/**
 * Returns releases for the changelog page.
 * Fetches live from GitHub at build time; on any failure falls back to the
 * committed snapshot so the build never breaks.
 */
export async function getReleases(): Promise<Release[]> {
  try {
    const releases = await fetchFromGitHub();
    if (releases.length > 0) return releases;
    return snapshot as Release[];
  } catch (err) {
    console.warn(
      `[changelog] live fetch failed, using snapshot fallback:`,
      err instanceof Error ? err.message : err,
    );
    return snapshot as Release[];
  }
}
