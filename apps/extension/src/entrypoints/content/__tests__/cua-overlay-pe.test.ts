import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression test for the click-pipeline bug fixed in `debug/cua-click-diagnostics`:
 *
 * `.ob-cua-root` is the full-viewport (`position:fixed; inset:0`) wrapper
 * inside the CUA "working" shadow DOM. The browser's hit-testing for trusted
 * CDP `Input.dispatchMouseEvent` events climbs to it when descendants are
 * `pointer-events: none`. If `.ob-cua-root` itself has the implicit default
 * `pointer-events: auto`, every agent click is silently eaten by the root
 * — even when `.ob-cua-shield` is correctly toggled to `pe:none` via the
 * `.ob-passthrough` class.
 *
 * Symptoms when this regresses:
 *   - Service-worker logs: `[click-diag] :pre OVERLAY-INTERCEPT
 *     top=div#openbrowse-cua-working-host shieldPE=none ...`
 *   - Page-side: clicks land but visibly do nothing (FAQ accordions stay
 *     `expanded=false`, theme toggles don't flip, etc.).
 *
 * Per the CSS pointer-events spec, setting `pe:none` on the parent does NOT
 * disable descendants with explicit `pe:auto`, so `.ob-cua-shield` (default
 * `pe:auto`) and `.ob-cua-stop` (explicit `pe:auto`) keep working as
 * hit-test targets when the agent isn't dispatching.
 *
 * We assert against the source string (not a JSDOM render) because the
 * failure mode this regresses is "someone removed the pe:none rule" — a
 * source-level change that a string match catches reliably without
 * spinning up shadow DOM in a test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_INDEX = resolve(HERE, "../index.ts");

function contentSource(): string {
  return readFileSync(CONTENT_INDEX, "utf-8");
}

/** Extract the body of a CSS rule named `selector` from the content script's
 *  inline `style.textContent = \`...\``. Returns null when the rule is missing. */
function extractCssRuleBody(src: string, selector: string): string | null {
  // Escape regex meta characters in the selector (e.g. `.`).
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(src);
  return m ? m[1] : null;
}

describe("CUA working-overlay shadow CSS pointer-events", () => {
  it(".ob-cua-root has pointer-events: none — without it, the root's default pe:auto eats CDP clicks even when the shield is pe:none", () => {
    const body = extractCssRuleBody(contentSource(), ".ob-cua-root");
    expect(
      body,
      ".ob-cua-root rule not found in content/index.ts — overlay CSS shape changed?",
    ).not.toBeNull();
    expect(body).toMatch(/pointer-events\s*:\s*none\s*;/);
  });

  it(".ob-cua-shield default pointer-events is 'auto' (catches user clicks while idle)", () => {
    const body = extractCssRuleBody(contentSource(), ".ob-cua-shield");
    expect(
      body,
      ".ob-cua-shield rule not found in content/index.ts — overlay CSS shape changed?",
    ).not.toBeNull();
    expect(body).toMatch(/pointer-events\s*:\s*auto\s*;/);
  });

  it(".ob-cua-shield.ob-passthrough switches pointer-events to 'none' (lets CDP clicks through during agent dispatch)", () => {
    const body = extractCssRuleBody(
      contentSource(),
      ".ob-cua-shield.ob-passthrough",
    );
    expect(
      body,
      ".ob-cua-shield.ob-passthrough rule not found in content/index.ts — passthrough toggle removed?",
    ).not.toBeNull();
    expect(body).toMatch(/pointer-events\s*:\s*none\s*;/);
  });

  it(".ob-cua-stop button keeps explicit pointer-events: auto so the user can still click Stop while the root is pe:none", () => {
    const body = extractCssRuleBody(contentSource(), ".ob-cua-stop");
    expect(
      body,
      ".ob-cua-stop rule not found in content/index.ts — Stop button moved?",
    ).not.toBeNull();
    expect(body).toMatch(/pointer-events\s*:\s*auto\s*;/);
  });
});
