import Kernel from '@onkernel/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PlaywrightDriver, type PlaywrightDriverOptions } from './playwright-driver';
import type { BrowserTabInfo, TabId } from '@agent/driver';

export interface KernelDriverOptions extends PlaywrightDriverOptions {
  apiKey?: string;
  stealth?: boolean;
  /**
   * If set, acquire a browser from this pre-existing Kernel browser pool
   * instead of creating a fresh per-trial browser. The pool must already be
   * created (and warmed) by the caller. Browsers are released back to the
   * pool on `close()` instead of being deleted, eliminating cold-start cost.
   *
   * Use this when running many trials at high concurrency to avoid Kernel's
   * burst-creation rate limit (which manifests as `page.goto` timeouts even
   * when the plan-level concurrent-browser limit is not reached).
   */
  poolId?: string;
  /**
   * Max seconds to wait for `browserPools.acquire()` to return a free browser.
   * Defaults to 120s.
   */
  acquireTimeoutSeconds?: number;
}

export class KernelDriver extends PlaywrightDriver {
  private kernel: Kernel;
  private kernelSessionId: string | null = null;
  public liveViewUrl: string | null = null;
  private currentReplayId: string | null = null;
  private poolId: string | null = null;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    kernel: Kernel,
    kernelSessionId: string,
    liveViewUrl: string,
    opts: KernelDriverOptions = {},
  ) {
    super(browser, context, opts.recordVideoDir);
    this.kernel = kernel;
    this.kernelSessionId = kernelSessionId;
    this.liveViewUrl = liveViewUrl;
    this.poolId = opts.poolId ?? null;
  }

  static async launch(opts: KernelDriverOptions = {}): Promise<KernelDriver> {
    const kernel = new Kernel(opts.apiKey ? { apiKey: opts.apiKey } : undefined);

    let cdpWsUrl: string;
    let sessionId: string;
    let liveViewUrl: string;

    if (opts.poolId) {
      // Acquire from a pre-warmed browser pool. The pool's browsers were
      // configured at pool-create time (headless/stealth/etc.), so the per-
      // trial opts.headless / opts.stealth are advisory only — actual values
      // come from the pool. The acquire call long-polls until a browser is
      // available; we cap the wait via acquire_timeout_seconds.
      const acquired = await kernel.browserPools.acquire(opts.poolId, {
        acquire_timeout_seconds: opts.acquireTimeoutSeconds ?? 120,
      });
      // 204 No Content (poll timed out) returns an empty body which the SDK
      // surfaces as a falsy / undefined-fields response — defend against it.
      if (!acquired || !acquired.cdp_ws_url || !acquired.session_id) {
        throw new Error(
          `KernelDriver: browserPools.acquire returned no browser within ${opts.acquireTimeoutSeconds ?? 120}s — pool may be exhausted`,
        );
      }
      cdpWsUrl = acquired.cdp_ws_url;
      sessionId = acquired.session_id;
      liveViewUrl = acquired.browser_live_view_url ?? "";
    } else {
      // Legacy path: create a fresh browser per trial.
      const created = await kernel.browsers.create({
        headless: opts.headless ?? false,
        stealth: opts.stealth ?? true,
      });
      cdpWsUrl = created.cdp_ws_url;
      sessionId = created.session_id;
      liveViewUrl = created.browser_live_view_url ?? "";
    }

    // From here on the Kernel session (acquired or freshly created) is live.
    // If Playwright connection / context / CDP setup fails before we hand back
    // a KernelDriver, the caller has no handle to clean up — so on ANY error
    // we must close the partial Playwright connection AND free the Kernel
    // session (release the pool slot, or delete the standalone browser),
    // otherwise we leak a browser / pool slot. Then rethrow so the caller still
    // sees the failure.
    let browser: Browser | undefined;
    try {
      // Connect Playwright over CDP.
      browser = await chromium.connectOverCDP(cdpWsUrl);

      // Context isolation policy:
      //   - Non-pool (fresh browser per trial): the default context is pristine,
      //     so reuse it.
      //   - Pool (warm browser reused across trials): the default context still
      //     holds the PREVIOUS trial's cookies / localStorage / sessionStorage /
      //     fingerprint state. Reusing it would leak state across trials and
      //     break the per-trial isolation guarantee the local driver provides.
      //     Create a FRESH BrowserContext instead — Chromium isolates cookies +
      //     storage per BrowserContext, and `super.close()` closes this context
      //     after each trial (so contexts don't accumulate while the pristine
      //     default context stays untouched).
      //
      // NOTE: `connectOverCDP` + `newContext()` storage isolation against
      // Kernel's REMOTE Chrome must be validated on a live pool. If the remote
      // rejects multiple contexts or shares storage across them, fall back to
      // explicit CDP storage clearing (Network.clearBrowserCookies +
      // Storage.clearDataForOrigin) on acquire. Not yet exercised end-to-end.
      const context = opts.poolId
        ? await browser.newContext()
        : browser.contexts()[0] || (await browser.newContext());
      // Bump default navigation timeout from Playwright's 30s default to 90s,
      // matching the local PlaywrightDriver. Kernel's stealth layer often auto-
      // solves CAPTCHAs / bot challenges that take 40-60s, and the 30s default
      // would cut the cord mid-solve and produce a spurious "page.goto Timeout"
      // infrastructure error.
      context.setDefaultNavigationTimeout(90_000);
      const page = context.pages()[0] || (await context.newPage());
      await context.newCDPSession(page);

      const driver = new KernelDriver(
        browser,
        context,
        kernel,
        sessionId,
        liveViewUrl,
        opts,
      );

      // If recording is requested, start a replay natively via Kernel.
      // Replays work with both fresh browsers and pool-acquired browsers — the
      // session_id is what matters.
      if (opts.recordVideoDir) {
        try {
          const replay = await kernel.browsers.replays.start(sessionId);
          driver.currentReplayId = replay.replay_id;
        } catch (err) {
          console.warn(
            `KernelDriver: failed to start replay recording: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return driver;
    } catch (err) {
      // Best-effort teardown so a failed init doesn't strand a Kernel browser.
      await browser?.close().catch(() => {});
      if (opts.poolId) {
        await kernel.browserPools
          .release(opts.poolId, { session_id: sessionId, reuse: false })
          .catch(() => {});
      } else {
        await kernel.browsers.deleteByID(sessionId).catch(() => {});
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await super.close();
    if (this.kernelSessionId) {
      const sessionId = this.kernelSessionId;
      this.kernelSessionId = null;
      if (this.poolId) {
        // Release back to the pool for reuse — the pool keeps the browser
        // warm for the next acquire(). reuse: true is the default but we
        // pass it explicitly for clarity.
        await this.kernel.browserPools
          .release(this.poolId, { session_id: sessionId, reuse: true })
          .catch((err) => {
            console.warn(
              `KernelDriver: pool release failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      } else {
        await this.kernel.browsers.deleteByID(sessionId).catch(() => {});
      }
    }
  }

  async closeAndSaveVideo(outputPath: string): Promise<string | null> {
    if (!this.kernelSessionId) {
      await this.close();
      return null;
    }

    // Claim ownership of this session and replay atomically so a concurrent
    // caller (e.g. the hard-timeout watchdog racing the normal finally block)
    // short-circuits above rather than double-stopping the same replay.
    const sessionId = this.kernelSessionId;
    const replayId = this.currentReplayId;
    this.kernelSessionId = null;
    this.currentReplayId = null;

    let savedPath: string | null = null;
    if (replayId && this.recordVideoDir) {
      try {
        await this.kernel.browsers.replays.stop(replayId, { id: sessionId });
        const response = await this.kernel.browsers.replays.download(replayId, { id: sessionId });
        const fs = await import("node:fs/promises");
        const buffer = await response.arrayBuffer();
        await fs.writeFile(outputPath, Buffer.from(buffer));
        savedPath = outputPath;
      } catch (err) {
        console.warn(`KernelDriver: failed to stop/download replay recording: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Close the Playwright browser and release/delete the Kernel session.
    // kernelSessionId is already nulled above so close() won't double-delete.
    await super.close();
    if (this.poolId) {
      await this.kernel.browserPools
        .release(this.poolId, { session_id: sessionId, reuse: true })
        .catch((err) => {
          console.warn(
            `KernelDriver: pool release failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    } else {
      await this.kernel.browsers.deleteByID(sessionId).catch(() => {});
    }

    return savedPath;
  }

  /**
   * Best-effort teardown for the hard-timeout watchdog.
   *
   * If the normal close path already claimed the session (kernelSessionId
   * nulled by `close()`/`closeAndSaveVideo()`), this is a no-op so we never
   * double-release. Otherwise:
   *   - Pooled browser: release with `reuse: false`. A trial that hit the
   *     hard timeout may have left the browser wedged (hung navigation, stuck
   *     dialog); returning it `reuse: true` would hand a bad browser to the
   *     next trial. `reuse: false` tells the pool to discard and re-warm.
   *   - Standalone browser: delete it.
   *
   * The previous watchdog path called `browsers.deleteByID` unconditionally,
   * which for a pooled browser deleted the browser WITHOUT releasing the pool
   * slot — leaking a slot (inflated acquired-count). This releases the slot.
   */
  async forceCleanup(): Promise<void> {
    const sessionId = this.kernelSessionId;
    if (!sessionId) return;
    this.kernelSessionId = null;
    if (this.poolId) {
      await this.kernel.browserPools
        .release(this.poolId, { session_id: sessionId, reuse: false })
        .catch(() => {});
    } else {
      await this.kernel.browsers.deleteByID(sessionId).catch(() => {});
    }
  }
}
