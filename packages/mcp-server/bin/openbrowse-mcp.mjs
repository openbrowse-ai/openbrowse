#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexTs = join(here, "..", "src", "index.ts");

const args = process.argv.slice(2);
const cmd = args[0];

// Built-in subcommands that don't need the runtime: --version, --help
if (cmd === "--version" || cmd === "-v") {
  const { readFileSync } = await import("node:fs");
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

// For everything else, delegate to tsx-loaded src/index.ts
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", indexTs, ...args],
  { stdio: "inherit" },
);
process.exit(result.status ?? 0);
