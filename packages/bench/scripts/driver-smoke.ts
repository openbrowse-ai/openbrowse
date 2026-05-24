/**
 * Standalone driver smoke test. Verifies:
 *  - Playwright launches Chromium
 *  - PlaywrightDriver constructs and navigates
 *  - CDP commands (Accessibility.getFullAXTree) flow through the driver
 *  - captureSnapshot from the agent core produces interactive refs
 *
 * No LLM, no agent loop — just the driver layer. Run with:
 *   pnpm --filter @openbrowse/bench tsx src/scripts/driver-smoke.ts
 */

import { captureSnapshot } from "@agent/snapshot-capture";
import { PlaywrightDriver } from "../src/drivers/playwright-driver";

async function main() {
  console.log("Launching Playwright (headless)…");
  const driver = await PlaywrightDriver.launch({ headless: true });

  try {
    console.log("Creating tab -> https://example.com");
    const tabId = await driver.createTab("https://example.com");
    await driver.setActiveTab(tabId);
    await driver.waitForLoad(tabId);

    const tab = await driver.getActiveTab();
    console.log(`Active tab: id=${tab.id} url=${tab.url} title="${tab.title}"`);

    console.log("Capturing accessibility snapshot...");
    const snap = await captureSnapshot(driver, tabId);
    console.log(`Refs: ${snap.refs.size}`);
    console.log(`Below-fold count: ${snap.belowFoldCount}`);
    console.log("Snapshot (first 300 chars):");
    console.log(snap.snapshotText.slice(0, 300));

    console.log("\nOK driver smoke test passed");
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error("FAIL smoke test failed:");
  console.error(err);
  process.exit(1);
});
