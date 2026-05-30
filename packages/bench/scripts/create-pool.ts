/**
 * Create a Kernel browser pool for a high-concurrency bench run.
 *
 * Usage:
 *   tsx packages/bench/scripts/create-pool.ts [--size N] [--name STR]
 *
 * This script writes ONLY the pool id to stdout (all progress/error output
 * goes to stderr). HOWEVER, the project loads env via dotenvx, which prints
 * its own banner ("injected env (N) from .env ...") to stdout. So a naive
 * `POOL_ID=$(tsx ... create-pool.ts)` capture will include that banner line
 * ahead of the id. Extract the id by pattern instead, e.g.:
 *
 *   POOL_ID=$(tsx ... create-pool.ts --size 50 | grep -oE '^[a-z0-9]{20,30}$' | tail -1)
 *
 * (Suppress the banner entirely with DOTENV_CONFIG_QUIET / dotenvx --quiet if
 * your invocation supports it, but the grep is the robust default.)
 */
import { loadEnv } from "../src/env";
loadEnv();
import Kernel from "@onkernel/sdk";

const args = process.argv.slice(2);
let size = 50;
let name: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--size") size = parseInt(args[++i], 10);
  else if (args[i] === "--name") name = args[++i];
}

if (!Number.isFinite(size) || size < 1) {
  console.error(`Invalid --size: ${size}`);
  process.exit(2);
}

const apiKey = process.env.KERNEL_API_KEY;
if (!apiKey) {
  console.error("KERNEL_API_KEY not set");
  process.exit(2);
}

const kernel = new Kernel({ apiKey });

(async () => {
  console.error(`Creating Kernel browser pool (size=${size}${name ? `, name=${name}` : ""})...`);
  const pool = await kernel.browserPools.create({
    size,
    headless: false,
    stealth: true,
    // Default fill rate is 10%/min; bump higher (max 25%/min per Kernel)
    // so the pool warms up fast enough that a 50-trial bench wave doesn't
    // have to wait too long. At 25%/min, a size-50 pool is ~80% full after
    // ~3-4 minutes.
    fill_rate_per_minute: 25,
    // Match prior per-trial idle timeout (10 min). Browsers that sit idle
    // longer than this in the pool will be destroyed and recreated.
    timeout_seconds: 600,
    ...(name ? { name } : {}),
  });
  console.error(`Pool created: id=${pool.id}, target size=${pool.browser_pool_config.size}`);
  console.error(`Waiting for pool to warm up (poll until available_count >= 1)...`);

  // Poll until at least one browser is ready so the first acquire() call
  // doesn't immediately have to wait the full acquire_timeout.
  const startMs = Date.now();
  const TIMEOUT_MS = 5 * 60_000;
  while (true) {
    const fresh = await kernel.browserPools.retrieve(pool.id);
    process.stderr.write(
      `  available=${fresh.available_count}/${fresh.browser_pool_config.size}, acquired=${fresh.acquired_count}\r`,
    );
    if (fresh.available_count >= 1) break;
    if (Date.now() - startMs > TIMEOUT_MS) {
      console.error(`\nTimed out waiting for pool warm-up after ${TIMEOUT_MS}ms`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.error(`\nPool is warming. Proceeding with run.`);

  // Print ONLY the id to stdout — bash captures this.
  console.log(pool.id);
})().catch((err) => {
  console.error(`create-pool failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
