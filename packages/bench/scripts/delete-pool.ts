/**
 * Delete a Kernel browser pool by id (and force-terminate any leased browsers).
 *
 * Usage:
 *   tsx packages/bench/scripts/delete-pool.ts <pool-id>
 *
 * Idempotent: succeeds silently if the pool is already gone.
 */
import { loadEnv } from "../src/env";
loadEnv();
import Kernel from "@onkernel/sdk";

const id = process.argv[2];
if (!id) {
  console.error("Usage: tsx delete-pool.ts <pool-id>");
  process.exit(2);
}

const apiKey = process.env.KERNEL_API_KEY;
if (!apiKey) {
  console.error("KERNEL_API_KEY not set");
  process.exit(2);
}

const kernel = new Kernel({ apiKey });

(async () => {
  try {
    // force=true terminates any browsers still leased by stuck/aborted trials.
    await kernel.browserPools.delete(id, { force: true });
    console.error(`Deleted browser pool: ${id}`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes("not found") || msg.includes("404")) {
      console.error(`Pool ${id} already gone — nothing to do.`);
      return;
    }
    console.error(`delete-pool failed: ${msg}`);
    process.exit(1);
  }
})();
