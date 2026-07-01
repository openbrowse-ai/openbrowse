import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rotateKeyPair } from "../keys/store";

const LOCK_FILE = (): string => join(process.env.HOME ?? homedir(), ".openbrowse", "broker.lock");

/**
 * CLI entrypoint for `openbrowse-mcp --rotate-keys`.
 *
 * The flow:
 *   1. Refuse if a broker is currently running (lock file present and pid alive).
 *      Rotating a key out from under a live broker would leave the broker
 *      serving the old key from memory while the on-disk key is new, so MCP
 *      hosts and the extension would both fail to verify.
 *   2. Print what rotation invalidates (host tokens, extension TOFU) and read
 *      a `YES` confirmation from stdin. Anything else aborts.
 *   3. Backup + regenerate via `rotateKeyPair`. Print the new fingerprint so
 *      the user can compare it against the extension's re-TOFU prompt.
 *
 * Exits with code 1 on abort or refusal; 0 on success.
 */
export async function rotateKeysCli(): Promise<void> {
  const lockPath = LOCK_FILE();
  if (existsSync(lockPath)) {
    const pid = readFileSync(lockPath, "utf8").trim();
    console.error(
      `Broker is running (pid ${pid}). Stop it first with 'launchctl unload', 'systemctl stop', or kill the process manually.`,
    );
    process.exit(1);
  }

  console.log("Key rotation will:");
  console.log("  1. Backup the current key to broker-key.previous.json");
  console.log("  2. Generate a new Ed25519 keypair");
  console.log("  3. Invalidate all existing access tokens (\u22641h TTL).");
  console.log(
    "     Hosts with active refresh tokens silently roll over without user interaction.",
  );
  console.log(
    "     If you intend to revoke compromised hosts, also delete ~/.openbrowse/refresh-tokens.json.",
  );
  console.log(
    "  4. Invalidate the extension's pinned fingerprint — you must re-TOFU in the extension's MCP Bridge settings",
  );
  console.log("");
  console.log("Type YES to confirm, anything else to abort.");
  process.stdout.write("> ");

  const line = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim()));
  });
  if (line !== "YES") {
    console.log("Aborted.");
    process.exit(1);
  }

  const kp = await rotateKeyPair();
  console.log("");
  console.log(`Rotation complete. New key fingerprint: ${kp.fingerprint}`);
  console.log("Start the broker, then re-TOFU in the extension's MCP Bridge settings.");
}
