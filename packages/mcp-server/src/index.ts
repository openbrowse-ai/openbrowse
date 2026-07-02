import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "./server";

/**
 * Resolved at module load from `package.json`. Kept as an export so
 * `--version` (bin wrapper) and any consumer that imports this module
 * can read the shipping version without duplicating the string across
 * source and package metadata.
 */
export const VERSION: string = (() => {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const LOCK_FILE = () => join(process.env.HOME ?? homedir(), ".openbrowse", "broker.lock");

/**
 * Attempt to atomically create the lock file with our PID. Returns
 * `true` on success. Throws for filesystem errors. Returns `false`
 * only when the file already exists (EEXIST from `wx` flag).
 */
function tryClaimLock(lf: string): boolean {
  try {
    const fd = openSync(lf, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Read the pid recorded in an existing lock file. Returns undefined
 * if the file is gone (race with another process cleaning it up) or
 * the contents are unparseable.
 */
function readLockPid(lf: string): number | undefined {
  let contents: string;
  try {
    contents = readFileSync(lf, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const pid = parseInt(contents.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export async function runServer(): Promise<void> {
  // Lock-file PID tracking: refuse to start a second broker, but step
  // over a stale lock left by a crashed prior process. The
  // implementation uses `openSync(..., 'wx')` for atomic exclusive
  // creation — this is a syscall that the OS serialises, eliminating
  // the read-then-write TOCTOU race that CodeQL flags for the naive
  // `existsSync + readFileSync + writeFileSync` pattern.
  //
  // Sequence:
  //   1. mkdir the ~/.openbrowse directory (recursive).
  //   2. Try tryClaimLock() — atomic wx create. If it succeeds we're
  //      the sole broker.
  //   3. If wx failed with EEXIST, read the pid; if it's live
  //      (process.kill(pid, 0) doesn't throw) refuse to start.
  //   4. If the pid is stale (ESRCH), unlink and retry claim ONCE.
  //      Any race between our unlink and a competing broker's write
  //      would fail on port bind anyway (single well-known port).
  const lf = LOCK_FILE();
  mkdirSync(join(process.env.HOME ?? homedir(), ".openbrowse"), { recursive: true });
  if (!tryClaimLock(lf)) {
    const existingPid = readLockPid(lf);
    if (existingPid !== undefined) {
      try {
        process.kill(existingPid, 0);
        console.error(`Broker already running (pid ${existingPid}).`);
        process.exit(1);
      } catch {
        // Stale lock — pid no longer alive. Remove and retry ONCE.
      }
    }
    try {
      unlinkSync(lf);
    } catch {
      /* already gone — race with another cleaner is fine */
    }
    if (!tryClaimLock(lf)) {
      // A third broker won the race after our unlink. Give up.
      console.error("Broker lock is contested; another instance won the race.");
      process.exit(1);
    }
  }
  const cleanup = (): void => {
    try {
      unlinkSync(lf);
    } catch {
      /* file already gone */
    }
  };
  process.on("exit", cleanup);

  const server = await startHttpServer();
  console.log(`\nOpenBrowse MCP broker ready on ${server.baseUrl}`);
  console.log(`Key fingerprint: ${server.keys.fingerprint}\n`);
  process.on("SIGINT", () =>
    server.close().then(() => {
      cleanup();
      process.exit(0);
    }),
  );
  process.on("SIGTERM", () =>
    server.close().then(() => {
      cleanup();
      process.exit(0);
    }),
  );
}

/**
 * Subcommand dispatcher. Called from:
 *   - `tsx src/index.ts <cmd>` (dev, `pnpm start`)
 *   - `openbrowse-mcp <cmd>` (installed, bin/openbrowse-mcp.mjs loads
 *     dist/index.js and invokes this)
 *
 * argv semantics are read directly from `process.argv` so both paths
 * behave identically.
 */
export async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "serve":
      await runServer();
      break;
    case "install": {
      const { installAutostart } = await import("./scripts/install-autostart");
      await installAutostart();
      break;
    }
    case "uninstall": {
      const { uninstallAutostart } = await import("./scripts/uninstall-autostart");
      await uninstallAutostart();
      break;
    }
    case "--rotate-keys": {
      const { rotateKeysCli } = await import("./scripts/rotate-keys");
      await rotateKeysCli();
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

// Also expose `main` as the default export so the bin wrapper's
// `mod.default ?? mod.main` fallback finds it regardless of bundler
// output shape.
export default main;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { startHttpServer };
