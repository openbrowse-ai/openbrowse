/**
 * Surface tag for the shared HomeApp shell. The two extension entrypoints
 * that render HomeApp pass this prop to gate the small set of behaviors
 * that differ between the durable pinned home tab and the ephemeral
 * Chrome new-tab page.
 *
 * Keep the gated set small. If a divergence grows beyond the three
 * helpers in this file, that's a signal the two surfaces should be
 * pulled apart again rather than continuing to fork inside HomeApp.
 */
export type Surface = "home" | "newtab";

/**
 * Only the pinned home tab hosts scheduled runs. The newtab page is
 * ephemeral (closes when the user navigates) and unsuitable as a
 * background-run host. See lib/agent/scheduled-run.ts:ensureHomePage.
 */
export function shouldHostScheduledRuns(surface: Surface): boolean {
  return surface === "home";
}

interface SpaceLike {
  id: string;
  windowId?: number | null;
}

/**
 * Resolve which space the surface should bind to on first mount.
 *
 * Resolution order:
 *  1. (home only) `?space=<id>` URL param, if it matches a known space.
 *     Newtab ignores this param — it's an ephemeral surface that the
 *     user can't bookmark/restore to a specific space, and Chrome
 *     resets the URL on each Cmd-T anyway.
 *  2. The space whose `windowId` matches the current chrome window.
 *  3. null. Space-less conversations are first-class; we don't fall
 *     back to "the first space" because that would silently capture a
 *     newly-opened window into an unrelated space.
 */
export function resolveInitialSpaceId(args: {
  surface: Surface;
  urlSearch: string;
  currentWindowId: number | undefined;
  spaces: readonly SpaceLike[];
}): string | null {
  const { surface, urlSearch, currentWindowId, spaces } = args;
  if (spaces.length === 0) return null;

  if (surface === "home") {
    const param = new URLSearchParams(urlSearch).get("space");
    if (param && spaces.some((s) => s.id === param)) return param;
  }

  if (currentWindowId != null) {
    const byWindow = spaces.find((s) => s.windowId === currentWindowId);
    if (byWindow) return byWindow.id;
  }

  return null;
}

/**
 * `document.title` for the surface.
 *
 *  - On `newtab`, an active conversation title takes precedence: tabs in
 *    Chrome's strip identify by conversation, since Cmd-T users typically
 *    have several NTPs open at once and need to tell them apart.
 *  - On `home`, the title always reflects the space (space is the durable
 *    identity of the home tab; the conversation is shown in the in-page
 *    header). The `chatTitle` arg is ignored on home.
 *  - Without an active space or chat, both surfaces fall back to the bare
 *    extension name.
 *
 * `chatTitle` is treated as absent when it is null, undefined, or empty
 * after trimming, so a conversation that hasn't been auto-titled yet
 * gracefully falls back to the space name.
 */
export function formatDocumentTitle(
  surface: Surface,
  spaceName: string | null,
  chatTitle?: string | null,
): string {
  if (surface === "newtab") {
    const trimmed = chatTitle?.trim();
    if (trimmed) return `${trimmed} — OpenBrowse`;
  }
  if (spaceName) return `${spaceName} — OpenBrowse`;
  return "OpenBrowse";
}
