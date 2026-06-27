// apps/extension/src/entrypoints/artifact/Host.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { toast as sonnerToast } from "sonner";
import { loadArtifact, recordOpened, recordInstalled, renameArtifact, setFavorite, setArtifactIcon } from "@/lib/artifacts/registry";
import { buildIframeDoc } from "./build-iframe-doc";
import { kvGet, kvSet, kvDelete, kvKeys } from "@/lib/artifacts/kv";
import { isHostAllowed } from "@/lib/artifacts/network-allowlist";
import type { BackgroundResponse, ArtifactError } from "@/lib/artifacts/rpc";
import type { SavedArtifact } from "@/lib/artifacts/registry";
import { buildErrorFixPrompt } from "@/lib/artifacts/seed-prompt";
import { setPendingFixRequest } from "@/lib/artifacts/pending-fix-request";
import { recordConsole, recordError, recordRendered, clearDiagnostics } from "@/lib/artifacts/diagnostics";
import { WriteApprovalDialog } from "@/components/artifacts/WriteApprovalDialog";
import { ArtifactPermissions } from "@/components/artifacts/ArtifactPermissions";
import { Star, Pin, PinOff, Pencil, ShieldCheck, Code2, Eye, AlertTriangle, X, Terminal, Trash2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";
import { CodeViewer } from "@/components/chat/CodeViewer";
import { CompactEmojiPicker } from "@/components/spaces/SpacePickers";


type DiagnosticEntry = { level: "log" | "info" | "warn" | "error"; text: string; ts: number };

/** Default emoji used when an older artifact has no icon set. */
const DEFAULT_ARTIFACT_ICON = "📦";

/**
 * Paint a single emoji into a 64x64 canvas and return a `data:` PNG URL. Used
 * to render the artifact's emoji as the standalone tab's favicon — the same
 * approach Spaces uses for its emoji favicons in HomeApp. Returns null if a
 * 2D context can't be acquired (e.g. JSDOM in unit tests), in which case the
 * caller leaves the static fallback in place.
 */
function emojiToFaviconDataUrl(emoji: string): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = "52px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, 32, 36);
  return canvas.toDataURL("image/png");
}

/**
 * Emoji-icon picker shown in the standalone tab header. Renders the current
 * icon as a small button; clicking opens the same frimousse-based emoji
 * picker used by Spaces' icon picker. Selecting an emoji calls back so the
 * Host can persist it (registry + favicon update).
 */
function ArtifactIconPicker({
  icon,
  onChange,
}: {
  icon: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Change artifact icon"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input/30 bg-muted text-lg hover:bg-accent transition-colors"
            >
              {icon}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Change icon</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-auto p-0 overflow-hidden">
        <CompactEmojiPicker
          onSelect={(emoji) => {
            onChange(emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The forwarded-console panel, with a smooth open/close. Animates height +
 * opacity via AnimatePresence so toggling it doesn't snap. `overflow-hidden`
 * on the animating wrapper clips the fixed-height inner panel as it grows/
 * shrinks. Shared by the tab and embed (in-panel viewer) layouts.
 */
function DiagnosticsPanel({
  open,
  entries,
  onClear,
  onHide,
}: {
  open: boolean;
  entries: DiagnosticEntry[];
  onClear: () => void;
  onHide: () => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="diagnostics"
          className="shrink-0 overflow-hidden border-t bg-muted/30"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 192, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <div className="flex h-48 flex-col">
            <div className="flex items-center justify-between border-b px-3 py-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                Artifact console
              </span>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      aria-label="Clear console"
                      onClick={onClear}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Clear</TooltipContent>
                </Tooltip>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label="Hide console"
                  onClick={onHide}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto px-3 py-1.5 font-mono text-xs leading-relaxed">
              {entries.length === 0 ? (
                <div className="text-muted-foreground">
                  No console output yet. console.log/info/warn/error from the artifact appears here.
                </div>
              ) : (
                entries.map((d, i) => (
                  <div
                    key={i}
                    className={
                      d.level === "error"
                        ? "text-destructive"
                        : d.level === "warn"
                          ? "text-yellow-600 dark:text-yellow-500"
                          : d.level === "info"
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-foreground"
                    }
                  >
                    <span className="select-none text-muted-foreground">
                      {new Date(d.ts).toLocaleTimeString()} {d.level}{" "}
                    </span>
                    <span className="whitespace-pre-wrap break-words">{d.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// "tab"   — full-screen artifact tab with the complete header/toolbar chrome.
// "card"  — chrome-less inline card (fixed, setCardHeight-driven height).
// "embed" — fills its container height (100%); used by the in-panel
//           ArtifactViewer. Renders a SINGLE header bar containing the
//           rendered/source toggle + console button, into which the embedder
//           injects its own title (embedHeaderLeft) and actions like open-tab/
//           close (embedHeaderRight). The artifact still sees itself as "card"
//           mode (compact layout).
interface HostProps {
  artifactId: string;
  mode: "tab" | "card" | "embed";
  /** embed only: content shown at the start of the single header bar (title). */
  embedHeaderLeft?: React.ReactNode;
  /** embed only: content shown at the end of the header bar (open-tab/close). */
  embedHeaderRight?: React.ReactNode;
}

type ArtifactState = SavedArtifact | null | "missing";

export function Host({ artifactId, mode, embedHeaderLeft, embedHeaderRight }: HostProps) {
  const [artifact, setArtifact] = useState<ArtifactState>(null);
  const [cardHeight, setCardHeight] = useState(360);
  const [titleInput, setTitleInput] = useState("");
  const [pinned, setPinned] = useState(false);
  const [tabId, setTabId] = useState<number | null>(null);
  // Toggle between the rendered iframe and the raw HTML source.
  const [view, setView] = useState<"rendered" | "code">("rendered");
  // Latest error reported by the artifact (toast error or uncaught runtime
  // error). Drives the persistent "Fix with OpenBrowse" banner. Session-only:
  // dismissing clears it; a new error replaces it.
  const [lastError, setLastError] = useState<ArtifactError | null>(null);
  // Rolling buffer of console output forwarded from the sandboxed artifact
  // iframe (whose own console isn't otherwise visible to the developer).
  // Powers the dev-only diagnostics panel.
  const [diagnostics, setDiagnostics] = useState<
    { level: "log" | "info" | "warn" | "error"; text: string; ts: number }[]
  >([]);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  // Set while a write tool is awaiting one-time approval. Resolving the promise
  // (approve) or rejecting it (cancel) is wired up by handleRpc below.
  const [pendingApproval, setPendingApproval] = useState<{
    resolve: () => void;
    reject: () => void;
  } | null>(null);
  // Live approved-writes list. handleRpc closes over the artifact snapshot from
  // its effect, so we read approvals through this ref to avoid a stale closure
  // after the user approves mid-session.
  const approvedWritesRef = useRef<string[]>([]);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    // A fresh mount means a fresh run: discard any diagnostics from a previous
    // run of this artifact so the agent's read_artifact_diagnostics only ever
    // reflects the current load. (Re-key on update_artifact remounts this.)
    void clearDiagnostics(artifactId);
    (async () => {
      const a = await loadArtifact(artifactId);
      if (!alive) return;
      if (!a) { setArtifact("missing"); return; }
      approvedWritesRef.current = a.sidecar.approvedWrites ?? [];
      setArtifact(a);
      setTitleInput(a.manifest.title);
      void recordOpened(artifactId);
    })();
    return () => { alive = false; };
  }, [artifactId]);

  useEffect(() => {
    if (mode === "tab") {
      chrome.tabs.getCurrent().then(tab => {
        if (tab?.id) {
          setTabId(tab.id);
          setPinned(tab.pinned);
        }
      });
    }
  }, [mode]);

  useEffect(() => {
    // Only own the document title when we ARE the document (tab mode). In
    // card/embed mode the Host is mounted inside another page (chat card,
    // in-panel viewer) and must not clobber that page's title.
    if (mode !== "tab") return;
    if (artifact && artifact !== "missing") {
      document.title = artifact.manifest.title;
    }
  }, [artifact, mode]);

  // In tab mode, paint the artifact's emoji icon into the page favicon so the
  // tab strip shows the same glyph the user sees in the header. Same canvas
  // pattern HomeApp uses for Spaces. Older artifacts (no icon) fall back to
  // a default emoji rather than the static 32.png so the tab is still
  // recognisable as an artifact.
  useEffect(() => {
    if (mode !== "tab") return;
    if (!artifact || artifact === "missing") return;
    const icon = artifact.manifest.icon ?? DEFAULT_ARTIFACT_ICON;
    const href = emojiToFaviconDataUrl(icon);
    if (!href) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = href;
  }, [artifact, mode]);

  const iframeDoc = useMemo(() => {
    if (!artifact || artifact === "missing") return null;
    return buildIframeDoc(artifact.html, artifact.manifest);
  }, [artifact]);

  // The artifact runs inside artifact-sandbox.html, which is declared in
  // manifest.sandbox.pages — Chrome therefore loads it at an OPAQUE origin with
  // no access to chrome.* APIs or extension storage. THAT is the trust boundary,
  // which is why the three <iframe src={sandboxUrl}> sites below deliberately
  // OMIT a `sandbox=` attribute (the outer frame wraps a trusted page and only
  // relays postMessage). Do NOT repoint these iframes at an extension-origin
  // HTML file: without the manifest sandbox page, untrusted artifact code would
  // run with full extension privileges. If you ever change the src, re-add an
  // explicit `sandbox="allow-scripts"` (without allow-same-origin).
  const sandboxUrl = useMemo(() => chrome.runtime.getURL("artifact-sandbox.html"), []);

  // Bridge: receive postMessage from the iframe, dispatch.
  useEffect(() => {
    if (!artifact || artifact === "missing") return;
    const a = artifact;

    function handler(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object") return;
      // When the sandbox signals readiness, hand it the built document.
      if (m.type === "ART_SANDBOX_READY") {
        if (iframeDoc) {
          iframeRef.current?.contentWindow?.postMessage({ type: "ART_DOC", html: iframeDoc }, "*");
        }
        return;
      }
      // The injected bridge shim signals once window.openbrowse is installed;
      // only then is it safe to deliver theme + identity.
      if (m.type === "ART_SHIM_READY") {
        sendInit();
        return;
      }
      // Uncaught error / unhandled rejection inside the iframe.
      if (m.type === "ART_RUNTIME_ERROR") {
        const message = String(m.message ?? "Unknown error");
        const stack = typeof m.stack === "string" ? m.stack : undefined;
        const sourceFile = typeof m.sourceFile === "string" ? m.sourceFile : undefined;
        const recentConsole = Array.isArray(m.recentConsole) ? m.recentConsole : undefined;
        setLastError({ source: "runtime", message, stack, sourceFile, recentConsole });
        // Persist for the agent's read_artifact_diagnostics.
        void recordError(a.manifest.id, {
          message,
          stack,
          sourceFile,
          recentConsole,
          ts: Date.now(),
        });
        return;
      }
      // One-shot signal that the artifact finished its initial render without
      // throwing. Lets the agent distinguish "loaded fine" from "script never
      // ran / threw before painting".
      if (m.type === "ART_RENDERED") {
        void recordRendered(a.manifest.id, {
          childCount: Number(m.childCount) || 0,
          bodyTextSample: String(m.bodyTextSample ?? "").slice(0, 200),
          ts: Date.now(),
        });
        return;
      }
      // Console output forwarded from the sandboxed iframe. Echo it to the
      // host console (prefixed) and keep a bounded buffer for the diagnostics
      // panel. The iframe is opaque-origin, so this is the only way its logs
      // reach a developer.
      if (m.type === "ART_CONSOLE") {
        const level: "log" | "info" | "warn" | "error" =
          m.level === "info" || m.level === "warn" || m.level === "error" ? m.level : "log";
        const text = String(m.text ?? "");
        const fn = console[level] ?? console.log;
        fn(`[artifact:${a.manifest.id}]`, text);
        const ts = Date.now();
        setDiagnostics((prev) => {
          const next = [...prev, { level, text, ts }];
          return next.length > 100 ? next.slice(next.length - 100) : next;
        });
        // Persist for the agent's read_artifact_diagnostics.
        void recordConsole(a.manifest.id, { level, text, ts });
        return;
      }
      if (m.type !== "ART_RPC") return;
      handleRpc(m).then(
        (result) => iframeRef.current?.contentWindow?.postMessage({ type: "ART_RPC_OK", reqId: m.reqId, result }, "*"),
        (err: unknown) => iframeRef.current?.contentWindow?.postMessage({ type: "ART_RPC_ERR", reqId: m.reqId, error: err instanceof Error ? err.message : String(err) }, "*"),
      );
    }

    // Snapshot the current theme: mode from the authoritative <html>.dark class
    // (set by useTheme from the app's themeMode, not just the OS), and a set of
    // CSS custom properties resolved from the host page so the artifact can
    // match the app's palette.
    function currentTheme() {
      const styles = getComputedStyle(document.documentElement);
      // getPropertyValue returns the property's declared value already in its
      // final color form (e.g. "oklch(0.24 0.01 75)"). It must be used as-is —
      // do NOT wrap it (e.g. `hsl(${v})`), which produced invalid
      // "hsl(oklch(...))" and silently fell back to light defaults.
      const getVar = (name: string, fallback: string) => {
        const v = styles.getPropertyValue(name).trim();
        return v || fallback;
      };
      const dark = document.documentElement.classList.contains("dark");
      return {
        mode: (dark ? "dark" : "light") as "dark" | "light",
        vars: {
          "--ob-bg": getVar("--background", dark ? "#0a0a0a" : "#ffffff"),
          "--ob-fg": getVar("--foreground", dark ? "#fafafa" : "#0a0a0a"),
          "--ob-muted": getVar("--muted-foreground", dark ? "#a1a1aa" : "#71717a"),
          "--ob-accent": getVar("--primary", dark ? "#fafafa" : "#18181b"),
          "--ob-border": getVar("--border", dark ? "#27272a" : "#e4e4e7"),
          "--ob-card": getVar("--card", dark ? "#18181b" : "#f4f4f5"),
        },
      };
    }

    function sendInit() {
      // The artifact only distinguishes "tab" vs "card" layouts; "embed" is a
      // host-side rendering detail, so report it to the artifact as "card".
      const artifactMode = mode === "tab" ? "tab" : "card";
      iframeRef.current?.contentWindow?.postMessage({
        type: "ART_INIT",
        theme: currentTheme(),
        identity: { id: a.manifest.id, title: a.manifest.title, mode: artifactMode },
      }, "*");
    }

    function sendTheme() {
      iframeRef.current?.contentWindow?.postMessage({
        type: "ART_THEME",
        theme: currentTheme(),
      }, "*");
    }

    // Gate a tool call: it must be declared, and write tools must be approved.
    // The first time an unapproved write is attempted we surface a one-time
    // approval dialog; approving grants ALL declared writes (and network) for
    // the life of the artifact, mirroring the original install-time consent.
    async function ensureToolAllowed(toolName: string): Promise<void> {
      const entry = a.manifest.tools.find((t) => t.name === toolName);
      if (!entry) throw new Error(`tool '${toolName}' not declared in artifact manifest`);
      if (entry.mode !== "write") return;
      if (approvedWritesRef.current.includes(toolName)) return;

      await new Promise<void>((resolve, reject) => {
        setPendingApproval({
          resolve: () => {
            const approvedWrites = a.manifest.tools
              .filter((t) => t.mode === "write")
              .map((t) => t.name);
            const approvedNetwork = a.manifest.network ?? [];
            // Persist BEFORE resolving: the background worker re-reads the
            // sidecar per RPC for defence-in-depth, so the write must land
            // before the gated call is dispatched.
            recordInstalled(a.manifest.id, { approvedWrites, approvedNetwork })
              .then(() => {
                approvedWritesRef.current = approvedWrites;
                setPendingApproval(null);
                resolve();
              })
              .catch((err) => {
                setPendingApproval(null);
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          },
          reject: () => {
            setPendingApproval(null);
            reject(new Error(`write tool '${toolName}' not approved by user`));
          },
        });
      });
    }

    async function handleRpc(m: { method: string; reqId: number; [k: string]: unknown }): Promise<unknown> {
      switch (m.method) {
        case "callMcpTool": {
          await ensureToolAllowed(String(m.name));
          const resp = (await chrome.runtime.sendMessage({
            type: "ARTIFACT_RPC_CALL_MCP",
            artifactId: a.manifest.id,
            toolName: String(m.name),
            args: m.args ?? {},
          })) as BackgroundResponse | undefined;
          if (resp === undefined) {
            throw new Error("callMcpTool: no response from background (handler not registered?)");
          }
          if (!resp.ok) throw new Error(resp.error || "rpc failed");
          return resp.result;
        }
        case "runTool": {
          await ensureToolAllowed(String(m.name));
          const resp = (await chrome.runtime.sendMessage({
            type: "ARTIFACT_RPC_RUN_TOOL",
            artifactId: a.manifest.id,
            toolName: String(m.name),
            args: m.args ?? {},
          })) as BackgroundResponse | undefined;
          if (resp === undefined) {
            throw new Error("runTool: no response from background (handler not registered?)");
          }
          if (!resp.ok) throw new Error(resp.error || "rpc failed");
          return resp.result;
        }
        case "network.fetch": {
          const url = String(m.url ?? "");
          // Fast-fail pre-check; the background re-validates against the
          // persisted manifest as the authoritative gate.
          let host: string;
          try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error("network.fetch: only http(s) URLs allowed");
            }
            host = u.host;
          } catch (e) {
            throw e instanceof Error ? e : new Error("network.fetch: invalid URL");
          }
          if (!isHostAllowed(host, a.manifest.network ?? [])) {
            throw new Error(`network.fetch: host '${host}' is not in the artifact's network allowlist`);
          }
          const resp = (await chrome.runtime.sendMessage({
            type: "ARTIFACT_RPC_NETWORK_FETCH",
            artifactId: a.manifest.id,
            url,
            init: m.init ?? {},
          })) as BackgroundResponse | undefined;
          if (resp === undefined) {
            // No listener replied — chrome closed the channel. Almost always a
            // routing miss (message type not dispatched in the background).
            throw new Error("network.fetch: no response from background (handler not registered?)");
          }
          if (!resp.ok) throw new Error(resp.error || "network.fetch failed");
          return resp.result;
        }
        case "kv.get":    return kvGet(a.manifest.id, String(m.key));
        case "kv.set":    return kvSet(a.manifest.id, String(m.key), m.value);
        case "kv.delete": return kvDelete(a.manifest.id, String(m.key));
        case "kv.keys":   return kvKeys(a.manifest.id);
        case "setCardHeight": {
          const px = Math.max(120, Math.min(480, Number(m.px) || 0));
          setCardHeight(px);
          return null;
        }
        case "toast": {
          const msg = String(m.message ?? "");
          const lvl = m.level as "info"|"success"|"error"|undefined;
          if (lvl === "error") {
            sonnerToast.error(msg);
            setLastError({
              source: "toast",
              message: msg,
              recentConsole: Array.isArray(m.recentConsole) ? (m.recentConsole as string[]) : undefined,
            });
          }
          else if (lvl === "success") sonnerToast.success(msg);
          else sonnerToast(msg);
          return null;
        }
        default: throw new Error(`unknown method '${String(m.method)}'`);
      }
    }
    window.addEventListener("message", handler);
    // Re-push the theme into the iframe whenever the app flips light/dark
    // (useTheme toggles <html>.dark). Keeps the artifact in sync live.
    const themeObserver = new MutationObserver(() => sendTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("message", handler);
      themeObserver.disconnect();
    };
  }, [artifact, iframeDoc, mode]);

  if (artifact === null) return <div className="p-6">Loading…</div>;
  if (artifact === "missing") return <div className="p-6">Artifact not found.</div>;

  if (mode === "card" || mode === "embed") {
    const embed = mode === "embed";

    // "card": chrome-less, artifact-driven height (setCardHeight, default 360).
    if (!embed) {
      return (
        <div style={{ width: "100%" }}>
          {/* No sandbox= attr by design — see sandboxUrl definition above. */}
          <iframe
            ref={iframeRef}
            src={sandboxUrl}
            title={artifact.manifest.title}
            style={{ width: "100%", height: cardHeight, border: 0, background: "var(--background)" }}
          />
          <WriteApprovalDialog
            open={pendingApproval !== null}
            manifest={artifact.manifest}
            onApprove={() => pendingApproval?.resolve()}
            onCancel={() => pendingApproval?.reject()}
          />
        </div>
      );
    }

    // "embed": fills the container and renders a SINGLE header bar. The
    // embedder injects its title (embedHeaderLeft) and actions like open-tab/
    // close (embedHeaderRight); Host adds the rendered/source toggle + console
    // button between them, so there's one unified header instead of two.
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
          {embedHeaderLeft != null && (
            <div className="flex min-w-0 flex-1 items-center gap-2">{embedHeaderLeft}</div>
          )}
          <div className={`flex items-center gap-1 ${embedHeaderLeft != null ? "shrink-0" : "flex-1 justify-end"}`}>
            <SegmentedToggle
              value={view}
              onChange={setView}
              options={[
                { value: "rendered", icon: Eye, label: "Rendered" },
                { value: "code", icon: Code2, label: "Source" },
              ]}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showDiagnostics ? "secondary" : "ghost"}
                  size="icon"
                  className="relative h-8 w-8"
                  aria-pressed={showDiagnostics}
                  onClick={() => setShowDiagnostics((v) => !v)}
                >
                  <Terminal className="h-4 w-4" />
                  {diagnostics.length > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Artifact console ({diagnostics.length})</TooltipContent>
            </Tooltip>
            {embedHeaderRight}
          </div>
        </div>
        {lastError && (
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-destructive/10 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-foreground" title={lastError.message}>
              The artifact reported an error: {lastError.message}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  aria-label="Dismiss error"
                  onClick={() => setLastError(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Dismiss</TooltipContent>
            </Tooltip>
          </div>
        )}
        {/* No sandbox= attr by design — see sandboxUrl definition above. */}
        <iframe
          ref={iframeRef}
          src={sandboxUrl}
          title={artifact.manifest.title}
          className="flex-1 w-full border-0 bg-background"
          style={{ display: view === "rendered" ? "block" : "none" }}
        />
        {view === "code" && (
          <div className="flex-1 overflow-auto bg-background">
            <CodeViewer
              code={artifact.html}
              language="html"
              lineNumbers
              className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
            />
          </div>
        )}
        <DiagnosticsPanel
          open={showDiagnostics}
          entries={diagnostics}
          onClear={() => setDiagnostics([])}
          onHide={() => setShowDiagnostics(false)}
        />
        <WriteApprovalDialog
          open={pendingApproval !== null}
          manifest={artifact.manifest}
          onApprove={() => pendingApproval?.resolve()}
          onCancel={() => pendingApproval?.reject()}
        />
      </div>
    );
  }

  const handleRenameSubmit = async () => {
    const newTitle = titleInput.trim();
    if (newTitle && newTitle !== artifact.manifest.title) {
      await renameArtifact(artifact.manifest.id, newTitle);
      setArtifact({ ...artifact, manifest: { ...artifact.manifest, title: newTitle } });
      document.title = newTitle;
    } else {
      setTitleInput(artifact.manifest.title);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setTitleInput(artifact.manifest.title);
      e.currentTarget.blur();
    }
  };

  const toggleFavorite = async () => {
    const current = !!artifact.sidecar.favorite;
    await setFavorite(artifact.manifest.id, !current);
    setArtifact({ ...artifact, sidecar: { ...artifact.sidecar, favorite: !current } });
  };

  /**
   * Persist a user-chosen emoji to the artifact and reflect it in local state
   * so both the header button and the favicon effect update immediately. We
   * don't await the save before updating the UI because the picker has
   * already closed; on rejection we revert.
   */
  const handleIconChange = async (next: string) => {
    const prev = artifact.manifest.icon;
    setArtifact({ ...artifact, manifest: { ...artifact.manifest, icon: next } });
    try {
      const saved = await setArtifactIcon(artifact.manifest.id, next);
      setArtifact(saved);
    } catch (err) {
      sonnerToast.error(err instanceof Error ? err.message : "Couldn't save icon");
      setArtifact({ ...artifact, manifest: { ...artifact.manifest, icon: prev } });
    }
  };

  const togglePin = async () => {
    if (tabId === null) return;
    await chrome.tabs.update(tabId, { pinned: !pinned });
    setPinned(!pinned);
  };

  // Open the side panel in edit mode for this artifact, pre-seeded with a
  // fix prompt built from the captured error, and auto-submit it.
  const openFixChat = (error: ArtifactError) => {
    if (tabId == null) return;
    const prompt = buildErrorFixPrompt(artifact.manifest.title, error);
    // The prompt (stack + console output) is too large for the sidePanel
    // setOptions({ path }) querystring, which silently drops it. Hand it off
    // via chrome.storage.session (survives SW eviction, shared across the
    // artifact tab and side panel) and keep only editArtifactId in the URL.
    setPendingFixRequest({
      artifactId: artifact.manifest.id,
      prompt,
      autoSubmit: true,
      requestedAt: Date.now(),
    }).catch(() => {});
    const url = `sidepanel.html?editArtifactId=${encodeURIComponent(artifact.manifest.id)}`;
    chrome.sidePanel.setOptions({ tabId, path: url, enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => {});
  };

  return (
    <div className="flex flex-col h-screen">
      <header className="flex items-center gap-2 px-3 py-2 border-b">
        <ArtifactIconPicker
          icon={artifact.manifest.icon ?? DEFAULT_ARTIFACT_ICON}
          onChange={handleIconChange}
        />
        <input
          value={titleInput}
          onChange={(e) => setTitleInput(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleRenameKeyDown}
          className="flex-1 bg-transparent text-sm font-medium outline-none focus:border-b focus:border-primary/50"
        />
        
        <div className="flex items-center gap-1">
          <SegmentedToggle
            value={view}
            onChange={setView}
            options={[
              { value: "rendered", icon: Eye, label: "Rendered" },
              { value: "code", icon: Code2, label: "Source" },
            ]}
          />

          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <ShieldCheck className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Permissions</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-72 p-4">
              <ArtifactPermissions manifest={artifact.manifest} />
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showDiagnostics ? "secondary" : "ghost"}
                size="icon"
                className="relative h-8 w-8"
                aria-pressed={showDiagnostics}
                onClick={() => setShowDiagnostics((v) => !v)}
              >
                <Terminal className="h-4 w-4" />
                {diagnostics.length > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Artifact console ({diagnostics.length})</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => {
                if (tabId != null) {
                  const url = `sidepanel.html?editArtifactId=${encodeURIComponent(artifact.manifest.id)}`;
                  chrome.sidePanel.setOptions({ tabId, path: url, enabled: true }).catch(() => {});
                  chrome.sidePanel.open({ tabId }).catch(() => {});
                }
              }}>
                <Pencil className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Make edits</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleFavorite}>
                <Star className="h-4 w-4" fill={artifact.sidecar.favorite ? "currentColor" : "none"} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{artifact.sidecar.favorite ? "Remove favorite" : "Add favorite"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={togglePin}>
                {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{pinned ? "Unpin tab" : "Pin tab"}</TooltipContent>
          </Tooltip>
        </div>
      </header>
      {lastError && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-destructive/10 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate text-foreground" title={lastError.message}>
            The artifact reported an error: {lastError.message}
          </span>
          <Button
            size="sm"
            variant="default"
            className="shrink-0 h-7"
            onClick={() => openFixChat(lastError)}
          >
            Fix with OpenBrowse
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                aria-label="Dismiss error"
                onClick={() => setLastError(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Dismiss</TooltipContent>
          </Tooltip>
        </div>
      )}
      {/* No sandbox= attr by design — see sandboxUrl definition above. */}
      <iframe
        ref={iframeRef}
        src={sandboxUrl}
        title={artifact.manifest.title}
        className="flex-1 w-full border-0 bg-background"
        style={{ display: view === "rendered" ? "block" : "none" }}
      />
      {view === "code" && (
        <div className="flex-1 overflow-auto bg-background">
          <CodeViewer
            code={artifact.html}
            language="html"
            lineNumbers
            className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
          />
        </div>
      )}
      <DiagnosticsPanel
        open={showDiagnostics}
        entries={diagnostics}
        onClear={() => setDiagnostics([])}
        onHide={() => setShowDiagnostics(false)}
      />
      <WriteApprovalDialog
        open={pendingApproval !== null}
        manifest={artifact.manifest}
        onApprove={() => pendingApproval?.resolve()}
        onCancel={() => pendingApproval?.reject()}
      />
    </div>
  );
}
