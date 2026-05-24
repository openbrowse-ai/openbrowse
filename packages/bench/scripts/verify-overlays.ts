/**
 * Deterministic verification that VisualizingDriver injects click rings and
 * typing toasts correctly. Bypasses the agent entirely:
 *
 *   1. Launch Playwright + PlaywrightDriver, wrap with VisualizingDriver
 *   2. Open a page with a known search box
 *   3. Send `Input.dispatchMouseEvent` (mousePressed) at fixed coords
 *   4. Send `Input.insertText` with a fixed string
 *   5. Take a screenshot WHILE the overlay animations are mid-flight
 *   6. Save screenshot to `.bench/overlay-verify-<ts>.png`
 *
 * Run: pnpm exec tsx scripts/verify-overlays.ts
 *
 * Expected output: one PNG showing the click ring near the input AND a
 * dark pill toast at the bottom-center of the viewport. If either is
 * missing, the injection broke.
 */

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { PlaywrightDriver } from "../src/drivers/playwright-driver";
import { VisualizingDriver } from "../src/drivers/visualizing-driver";
import { benchRoot } from "../src/paths";

async function main() {
  const verifyDir = resolve(benchRoot(), "verify");
  mkdirSync(verifyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const screenshotPath = resolve(verifyDir, `overlays-${stamp}.png`);

  console.log("Launching headed Playwright...");
  const inner = await PlaywrightDriver.launch({ headless: false });
  const driver = new VisualizingDriver(inner, { enabled: true });

  try {
    console.log("Opening test page...");
    const tabId = await inner.createTab(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html>
<html><head><title>Overlay Verification</title>
<style>
  body { font: 16px ui-sans-serif; padding: 80px; background: #f3f4f6; }
  h1 { color: #1f2937; }
  input { font-size: 18px; padding: 12px 16px; width: 320px;
          border: 2px solid #d1d5db; border-radius: 6px; }
</style></head>
<body>
  <h1>Visualization driver verification</h1>
  <p>Look for: a blue ring near the input, and a typing tooltip above it.</p>
  <input type="text" id="q" placeholder="Search..." autofocus>
</body></html>`),
    );
    await inner.setActiveTab(tabId);
    await inner.waitForLoad(tabId);

    console.log("Triggering click ring at (260, 220)...");
    await driver.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 260,
      y: 220,
      button: "left",
      clickCount: 1,
    });

    // Focus the input so the typing tooltip has somewhere to anchor.
    await inner.sendCommand(tabId, "Runtime.evaluate", {
      expression: "document.getElementById('q')?.focus()",
      returnByValue: true,
    });

    console.log('Triggering type tooltip with "hello world"...');
    await driver.sendCommand(tabId, "Input.insertText", {
      text: "hello world",
    });

    // Capture immediately so the click ring (800ms anim) and the typing tip
    // (2200ms anim) are both still on screen.
    console.log("Capturing screenshot mid-animation (250ms in)...");
    await new Promise((r) => setTimeout(r, 250));

    const result = await inner.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      { format: "png" },
    );
    const buf = Buffer.from(result.data, "base64");
    await import("node:fs/promises").then((m) =>
      m.writeFile(screenshotPath, buf),
    );

    console.log(`\nScreenshot saved: ${screenshotPath}`);
    console.log("\nOpen with:");
    console.log(`  open ${screenshotPath}`);
    console.log("\nExpected: a blue 40px ring near (260, 220) AND a dark");
    console.log('pill-shaped toast at the bottom-center reading "⌨ hello world".');
  } finally {
    await inner.close();
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
