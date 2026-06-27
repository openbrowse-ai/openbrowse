/**
 * URL hash routing for `home.html`.
 *
 * The home page is a single static file (no server), so server-backed
 * History API routing isn't an option — a reloaded `/spaces/x` would 404.
 * The hash is the natural reload-safe channel for view state.
 *
 * Why the hash and not the query string: the background script rewrites
 * the home tab URL to a bare `home.html?space=<id>` whenever it repairs
 * the window anchor (`ensureHomeTab` / `focusOrCreateWindow`), which
 * would wipe any extra query params we put there. The hash is only ever
 * touched by the background to focus a conversation
 * (`...#<conversationId>`), which maps cleanly onto the chat route.
 *
 * Route grammar (the value after `#`):
 *   ""                  -> chat, no conversation
 *   "<conversationId>"  -> chat on that conversation (UUID)
 *   "scheduled"         -> Scheduled view
 *   "spaces"            -> Spaces list
 *
 * The legacy `spaces/<spaceId>` form is parsed back-compat (in case any
 * pre-rebase URL is still floating around) but normalises to the
 * argument-less spaces list — there is no longer a per-space detail
 * view; configuration lives inline on the chat LandingPage.
 *
 * Conversation ids are `crypto.randomUUID()` (always hyphenated v4
 * strings), so they can never collide with the reserved token
 * `scheduled` / `spaces`. The grammar is unambiguous.
 */

export type HomeRoute =
  | { view: "chat"; conversationId: string | null }
  | { view: "scheduled" }
  | { view: "spaces" }
  | { view: "library" };

const RESERVED_VIEW_TOKENS = new Set(["scheduled", "spaces", "library"]);

/**
 * Parse the hash portion of `window.location.hash` (with or without a
 * leading `#`) into a typed `HomeRoute`. Anything that isn't an
 * explicit reserved-token route is treated as a conversation id, so a
 * hash like `#abc-123` continues to mean "chat on conversation abc-123"
 * without the caller needing to special-case it.
 */
export function parseHomeRoute(hash: string): HomeRoute {
  const raw = (hash.startsWith("#") ? hash.slice(1) : hash).trim();
  if (raw === "") return { view: "chat", conversationId: null };

  if (raw === "scheduled") return { view: "scheduled" };
  if (raw === "spaces") return { view: "spaces" };
  if (raw === "library") return { view: "library" };

  // Back-compat: legacy `spaces/<spaceId>` URLs (from before the detail
  // view was removed) collapse to the argument-less spaces list. The
  // tail is intentionally ignored — there's no detail view to navigate
  // to anymore.
  if (raw.startsWith("spaces/")) {
    return { view: "spaces" };
  }

  // Anything else is a conversation id. Reserved tokens are excluded
  // above, and a non-reserved token (a UUID, in practice) maps to chat.
  // Defensive: if a future caller passes a literal reserved token without
  // the `spaces/` prefix that doesn't match, RESERVED_VIEW_TOKENS guards
  // against it being accidentally treated as a conversation id.
  if (RESERVED_VIEW_TOKENS.has(raw)) {
    return { view: "chat", conversationId: null };
  }

  return { view: "chat", conversationId: raw };
}

/**
 * Format a route into the hash portion of the URL (including the leading
 * `#`). Returns `""` for the canonical "empty chat" route so the caller
 * can pass that result straight to `history.replaceState(null, "", url)`
 * without leaving a dangling `#`.
 */
export function formatHomeRoute(route: HomeRoute): string {
  switch (route.view) {
    case "chat":
      return route.conversationId ? `#${route.conversationId}` : "";
    case "scheduled":
      return "#scheduled";
    case "spaces":
      return "#spaces";
    case "library":
      return "#library";
  }
}

/**
 * True when two routes refer to the same view (and the same target
 * within that view). Used by App.tsx to decide between `pushState`
 * (view transition — back-able) and `replaceState` (incidental same-view
 * sync, e.g. switching conversations within chat).
 */
export function sameView(a: HomeRoute, b: HomeRoute): boolean {
  if (a.view !== b.view) return false;
  return true;
}
