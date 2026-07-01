import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startHttpServer } from "./server";

export const VERSION = "0.0.0";

const LOCK_FILE = () => join(process.env.HOME ?? homedir(), ".openbrowse", "broker.lock");

export async function runServer(): Promise<void> {
  // Lock-file PID tracking: refuse to start a second broker, but step over
  // a stale lock left by a crashed prior process. Detection uses
  // `process.kill(pid, 0)`, which throws ESRCH if the pid is gone — that
  // tells us the lock is stale and safe to overwrite. We don't try to be
  // clever about pid-recycling on long-uptime systems; in the worst case
  // the user gets a misleading "already running" message and runs `kill`
  // manually.
  const lf = LOCK_FILE();
  if (existsSync(lf)) {
    const pid = parseInt(readFileSync(lf, "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        console.error(`Broker already running (pid ${pid}).`);
        process.exit(1);
      } catch {
        // Stale lock — proceed and overwrite below.
      }
    }
  }
  mkdirSync(join(process.env.HOME ?? homedir(), ".openbrowse"), { recursive: true });
  writeFileSync(lf, String(process.pid));
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

async function main(): Promise<void> {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { startHttpServer };
