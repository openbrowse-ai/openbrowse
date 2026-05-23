import Kernel from '@onkernel/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { PlaywrightDriver, type PlaywrightDriverOptions } from './playwright-driver';
import type { BrowserTabInfo, TabId } from '@agent/driver';

export interface KernelDriverOptions extends PlaywrightDriverOptions {
  apiKey?: string;
  stealth?: boolean;
}

export class KernelDriver extends PlaywrightDriver {
  private kernel: Kernel;
  private kernelSessionId: string | null = null;
  public liveViewUrl: string | null = null;
  private currentReplayId: string | null = null;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    kernel: Kernel,
    kernelSessionId: string,
    liveViewUrl: string,
    opts: KernelDriverOptions = {}
  ) {
    super(browser, context, opts.recordVideoDir);
    this.kernel = kernel;
    this.kernelSessionId = kernelSessionId;
    this.liveViewUrl = liveViewUrl;
  }

  static async launch(opts: KernelDriverOptions = {}): Promise<KernelDriver> {
    const kernel = new Kernel(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
    
    // Create Kernel browser
    const kernelBrowser = await kernel.browsers.create({
      headless: opts.headless ?? false,
      stealth: opts.stealth ?? true,
    });
    
    // Connect Playwright over CDP
    const browser = await chromium.connectOverCDP(kernelBrowser.cdp_ws_url);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    const cdpSession = await context.newCDPSession(page);

    const driver = new KernelDriver(
      browser,
      context,
      kernel,
      kernelBrowser.session_id,
      kernelBrowser.browser_live_view_url ?? "",
      opts
    );

    // If recording is requested, start a replay natively via Kernel
    if (opts.recordVideoDir) {
      try {
        const replay = await kernel.browsers.replays.start(kernelBrowser.session_id);
        driver.currentReplayId = replay.replay_id;
      } catch (err) {
        console.warn(`KernelDriver: failed to start replay recording: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return driver;
  }

  async close(): Promise<void> {
    await super.close();
    if (this.kernelSessionId) {
      await this.kernel.browsers.deleteByID(this.kernelSessionId).catch(() => {});
      this.kernelSessionId = null;
    }
  }

  async closeAndSaveVideo(outputPath: string): Promise<string | null> {
    if (!this.kernelSessionId) {
      await this.close();
      return null;
    }
    
    let savedPath: string | null = null;
    if (this.currentReplayId && this.recordVideoDir) {
      try {
        await this.kernel.browsers.replays.stop(this.currentReplayId, { id: this.kernelSessionId });
        // Download the replay
        const response = await this.kernel.browsers.replays.download(this.currentReplayId, { id: this.kernelSessionId });
        const fs = await import("node:fs/promises");
        // Using response.arrayBuffer() directly since it returns a Response object
        const buffer = await response.arrayBuffer();
        await fs.writeFile(outputPath, Buffer.from(buffer));
        savedPath = outputPath;
      } catch (err) {
        console.warn(`KernelDriver: failed to stop/download replay recording: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    await this.close();
    return savedPath;
  }
}
