#!/usr/bin/env node
// Entry point for `@openbrowse/mcp-server` when installed via npm/Homebrew.
//
// Layout after `pnpm build`:
//   bin/openbrowse-mcp.mjs   ← you are here (executable, in package `bin`)
//   dist/index.js            ← bundled ESM module exporting runServer + subcommand handlers
//
// This wrapper handles the tiny set of subcommands that DO NOT need the
// server runtime (--version / --help — cheap enough to answer without
// loading dist/) and delegates everything else (`serve`, `install`,
// `uninstall`, `--rotate-keys`) to the bundled module.
//
// Delegating via a direct import (not spawn) keeps the process tree flat,
// which matters for autostart handlers (launchd expects the invoked
// binary to be the process it monitors — no daemonising).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const cmd = args[0];

// Cheap commands: answer without loading the bundle.
if (cmd === "--version" || cmd === "-v") {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (cmd === "--help" || cmd === "-h") {
  console.log(`openbrowse-mcp <command>

Commands:
  serve              Start the MCP broker (default)
  install            Install autostart for this user
  uninstall          Remove autostart
  --rotate-keys      Backup the current broker key and generate a new one
  --version, -v      Print version
  --help, -h         Print this help
`);
  process.exit(0);
}

// Everything else: hand off to the bundled entrypoint. The bundle
// re-exports the same `main()` function used by `tsx src/index.ts`, so
// argv semantics are identical between dev (`pnpm start`) and installed
// (`openbrowse-mcp`).
const bundle = join(here, "..", "dist", "index.js");
const mod = await import(bundle);
// `main` is the default async runner; it inspects process.argv itself.
// Fall back to a named export if consumers restructure the entry later.
const main = mod.default ?? mod.main ?? mod.runFromCli;
if (typeof main !== "function") {
  console.error(
    "[openbrowse-mcp] internal error: bundled entry did not expose a callable main().",
  );
  process.exit(2);
}
try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
