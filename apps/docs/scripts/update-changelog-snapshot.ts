/**
 * Refreshes content/changelog-snapshot.json from live GitHub Releases.
 * Run intentionally via: pnpm --filter openbrowse-docs changelog:snapshot
 * The Next.js build never writes this file; this script is the only writer.
 *
 * Uses fetchFromGitHub (not getReleases) so a failed fetch surfaces as a
 * non-zero exit instead of silently re-writing the existing snapshot.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchFromGitHub } from "../lib/changelog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "content", "changelog-snapshot.json");

async function main() {
  const releases = await fetchFromGitHub();
  if (releases.length === 0) {
    console.error(
      "[changelog] refusing to write empty snapshot. Aborting.",
    );
    process.exit(1);
  }
  await writeFile(OUT, JSON.stringify(releases, null, 2) + "\n", "utf8");
  console.log(`[changelog] wrote ${releases.length} releases to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
