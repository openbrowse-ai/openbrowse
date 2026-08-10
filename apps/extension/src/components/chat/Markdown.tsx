import {
  CHATLINK_HREF_PREFIX,
  WIKILINK_HREF_PREFIX,
} from "@/lib/memory/linkify";
import { cn } from "@/lib/utils";
import { useMemo, type ComponentPropsWithoutRef } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import "./markdown.css";
import { codePlugin } from "./shiki-streamdown-plugin";

// Disable per-word stagger to work around streamdown#482: the shared stagger
// counter resets per block, so new sections animate concurrently with earlier
// still-animating ones ("slow"/"parallel" reveal). With stagger 0, only newly
// streamed words fade in (150ms), without overlapping prior sections.
// Module-level constant keeps a stable identity across renders.
// Revisit/remove once streamdown PR #493 ships in a published release.
const ANIMATE_OPTIONS = { stagger: 0 } as const;

/** Stable identity so the scoped instance doesn't re-render on every pass. */
const DISABLED_LINK_SAFETY = { enabled: false } as const;

/** Shared styling for the in-app (fragment-href) link variants. */
const IN_APP_LINK_CLASS =
  "cursor-pointer text-primary underline underline-offset-2 decoration-primary/40 hover:decoration-primary";

interface MarkdownProps {
  source: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * When provided, anchors whose href starts with the wikilink prefix
   * (`#wl-<name>`) render as in-app links: clicking one calls this with the
   * decoded name instead of navigating or showing the renderer's external-link
   * dialog. Non-wikilink anchors open in a new tab. Only affects instances that
   * pass this — every other Markdown keeps Streamdown's default link handling.
   */
  onWikiLink?: (name: string) => void;
  /**
   * When provided, anchors whose href starts with the chat-link prefix
   * (`#chat-<conversationId>`) render as in-app links: clicking one calls this
   * with the decoded conversation id. Used by the memory viewer to navigate to
   * the conversation a remembered fact came from. Without this handler such
   * anchors render as inert text rather than as a link to a dead fragment.
   */
  onChatLink?: (conversationId: string) => void;
}

/** Loose shape of the props Streamdown/react-markdown passes to `a`. */
type AnchorRenderProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

/** What an anchor's href resolves to: an in-app action, inert text, or a URL. */
type AnchorAction = { run: () => void } | { inert: true } | null;

function inAppLinkComponents(
  onWikiLink?: (name: string) => void,
  onChatLink?: (conversationId: string) => void,
) {
  // Memory markdown is hand-authorable, so a fragment href can carry a
  // malformed escape (`#wl-%`) that makes `decodeURIComponent` throw. `resolve`
  // runs during the anchor's render, so throwing would take down the whole
  // document — treat an undecodable target as inert instead.
  const decode = (raw: string): string | null => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  };

  const resolve = (href: string): AnchorAction => {
    if (href.startsWith(WIKILINK_HREF_PREFIX)) {
      if (!onWikiLink) return { inert: true };
      const name = decode(href.slice(WIKILINK_HREF_PREFIX.length));
      if (name === null) return { inert: true };
      return { run: () => onWikiLink(name) };
    }
    if (href.startsWith(CHATLINK_HREF_PREFIX)) {
      if (!onChatLink) return { inert: true };
      const id = decode(href.slice(CHATLINK_HREF_PREFIX.length));
      if (id === null) return { inert: true };
      return { run: () => onChatLink(id) };
    }
    return null;
  };

  return {
    a: ({ href, children, node: _node, ...rest }: AnchorRenderProps) => {
      const action = typeof href === "string" ? resolve(href) : null;

      // A fragment link whose handler wasn't wired for this instance. Rendering
      // it as an anchor would either navigate to a dead fragment or (via the
      // external branch below) open a duplicate tab, so drop the link
      // affordance and keep the text.
      if (action && "inert" in action) return <>{children}</>;

      if (action) {
        return (
          <a
            role="button"
            tabIndex={0}
            className={IN_APP_LINK_CLASS}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              action.run();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                action.run();
              }
            }}
          >
            {children}
          </a>
        );
      }

      // Real external/other links: open in a new tab safely, bypassing the
      // renderer's built-in link dialog for this scoped instance.
      return (
        <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
  };
}

export function Markdown({
  source,
  className,
  isStreaming = false,
  onWikiLink,
  onChatLink,
}: MarkdownProps) {
  // Any in-app link handler means this instance owns anchor rendering entirely.
  const ownsLinks = Boolean(onWikiLink || onChatLink);
  const components = useMemo(
    () =>
      onWikiLink || onChatLink
        ? inAppLinkComponents(onWikiLink, onChatLink)
        : undefined,
    [onWikiLink, onChatLink],
  );
  return (
    <Streamdown
      className={cn(
        "prose prose-sm dark:prose-invert prose-p:text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground max-w-none",
        className,
      )}
      animated={ANIMATE_OPTIONS}
      isAnimating={isStreaming}
      caret={isStreaming ? "circle" : undefined}
      plugins={{ code: codePlugin }}
      components={components}
      // In the in-app-link instances we own anchor rendering entirely
      // (wikilinks and chat links navigate in-app; other links open in a new
      // tab with noopener/noreferrer), so the built-in external-link dialog
      // must not also intercept clicks. Untouched for every other Markdown
      // instance.
      linkSafety={ownsLinks ? DISABLED_LINK_SAFETY : undefined}
    >
      {source}
    </Streamdown>
  );
}
