// @vitest-environment happy-dom
//
// The palette's height budget is what keeps its search input on screen: the
// host clamps the iframe to a fraction of its viewport, so the palette has to
// know that number to shrink its lists instead of overflowing the frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleOverlayHello,
  OVERLAY_HELLO_MESSAGE,
  OVERLAY_MAX_HEIGHT_RATIO,
  OVERLAY_VIEWPORT_MESSAGE,
  overlayMaxHeight,
  postOverlayViewport,
  watchOverlayViewport,
} from "./overlay-frame";

function fakeIframe(): { iframe: HTMLIFrameElement; posts: unknown[] } {
  const posts: unknown[] = [];
  const iframe = {
    contentWindow: {
      postMessage: (data: unknown) => {
        posts.push(data);
      },
    },
  } as unknown as HTMLIFrameElement;
  return { iframe, posts };
}

describe("overlayMaxHeight", () => {
  it("is the configured fraction of the host viewport", () => {
    expect(overlayMaxHeight(1000)).toBe(
      Math.floor(1000 * OVERLAY_MAX_HEIGHT_RATIO),
    );
  });

  it("floors so the budget never exceeds the hosts' max-height clamp", () => {
    // 807 * 0.7 = 564.9 — rounding up would put the palette a pixel past the
    // CSS clamp, which is exactly the clipping this fix removes.
    const viewport = 807;
    expect(overlayMaxHeight(viewport)).toBe(564);
    expect(overlayMaxHeight(viewport)).toBeLessThanOrEqual(
      viewport * OVERLAY_MAX_HEIGHT_RATIO,
    );
  });

  it("never returns a negative budget", () => {
    expect(overlayMaxHeight(0)).toBe(0);
    expect(overlayMaxHeight(-100)).toBe(0);
  });
});

describe("postOverlayViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the current budget to the iframe", () => {
    const { iframe, posts } = fakeIframe();
    vi.stubGlobal("window", { ...window, innerHeight: 1000 });
    postOverlayViewport(iframe);
    expect(posts).toEqual([
      { type: OVERLAY_VIEWPORT_MESSAGE, maxHeight: overlayMaxHeight(1000) },
    ]);
  });

  it("is a no-op when no overlay is mounted", () => {
    expect(() => postOverlayViewport(null)).not.toThrow();
    expect(() => postOverlayViewport(undefined)).not.toThrow();
    expect(() =>
      postOverlayViewport({
        contentWindow: null,
      } as unknown as HTMLIFrameElement),
    ).not.toThrow();
  });
});

describe("handleOverlayHello", () => {
  it("answers a palette HELLO with the budget", () => {
    const { iframe, posts } = fakeIframe();
    const handled = handleOverlayHello(
      { data: { type: OVERLAY_HELLO_MESSAGE } } as MessageEvent,
      iframe,
    );
    expect(handled).toBe(true);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { type: string }).type).toBe(OVERLAY_VIEWPORT_MESSAGE);
  });

  it("ignores unrelated messages", () => {
    const { iframe, posts } = fakeIframe();
    expect(
      handleOverlayHello(
        {
          data: { type: "OPENBROWSE_OVERLAY_RESIZE", height: 400 },
        } as MessageEvent,
        iframe,
      ),
    ).toBe(false);
    expect(handleOverlayHello({ data: null } as MessageEvent, iframe)).toBe(
      false,
    );
    expect(posts).toHaveLength(0);
  });
});

describe("watchOverlayViewport", () => {
  it("posts immediately, on host resize, and stops after teardown", () => {
    const { iframe, posts } = fakeIframe();
    const stop = watchOverlayViewport(() => iframe);
    expect(posts).toHaveLength(1);

    window.dispatchEvent(new Event("resize"));
    expect(posts).toHaveLength(2);

    stop();
    window.dispatchEvent(new Event("resize"));
    expect(posts).toHaveLength(2);
  });

  it("re-reads the iframe each time, so one watcher serves remounts", () => {
    const first = fakeIframe();
    const second = fakeIframe();
    let current: HTMLIFrameElement | null = null;
    const stop = watchOverlayViewport(() => current);

    // No overlay mounted yet — nothing posted, nothing thrown.
    expect(first.posts).toHaveLength(0);

    current = first.iframe;
    window.dispatchEvent(new Event("resize"));
    current = second.iframe;
    window.dispatchEvent(new Event("resize"));
    stop();

    expect(first.posts).toHaveLength(1);
    expect(second.posts).toHaveLength(1);
  });
});
