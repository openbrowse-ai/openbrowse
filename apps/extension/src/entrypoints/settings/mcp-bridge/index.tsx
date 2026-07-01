import { ActivitySection } from "./ActivitySection";
import { AdvancedSection } from "./AdvancedSection";
import { ConnectedToolsSection } from "./ConnectedToolsSection";
import { ConnectionStatusPanel } from "./ConnectionStatusPanel";
import { InlineHelp } from "@/components/ui/inline-help";
import { PreferencesSection } from "./PreferencesSection";

/**
 * Settings → MCP Server tab.
 *
 * OpenBrowse acts as an MCP server: coding tools and other MCP clients
 * (like Cursor, Claude Desktop, OpenCode) connect to it and ask it to
 * take actions in the user's browser. This tab is the user's control
 * surface for that side of the protocol. The Connectors tab handles
 * the opposite direction (OpenBrowse as MCP client to external
 * servers like Notion, GitHub, etc.).
 *
 * Sections, top to bottom:
 *   - Connection status pill (Ready / Not connected / Needs approval / etc.)
 *   - Connected tools: per-client policy + block
 *   - Preferences: small toggles users may want
 *   - Activity: pending confirmations, running tasks, recent tasks
 *   - Advanced (collapsed): MCP logs, auto-cancel timeout, always-confirm
 *
 * Configuration (who's connected, how they behave) is placed above
 * runtime state (what they're doing right now). Users open this tab
 * most often to change a policy or block a client, not to watch
 * activity — activity has its own toast + counter surfaces.
 *
 * Copy is intentionally direct ("MCP client", "MCP server") because
 * the audience installing MCP hosts already knows the spec; we use
 * `(?)` popovers to demystify terms inline rather than introducing
 * marketing euphemisms.
 */
export function McpBridgeTab() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-muted-foreground">
          Coding tools and other{" "}
          <InlineHelp term="MCP clients">
            The Model Context Protocol lets AI tools talk to each other
            and to local programs. An MCP client is any external tool
            (like Cursor, Claude Desktop, or OpenCode) that connects to
            OpenBrowse to take actions in your browser on your behalf.
          </InlineHelp>{" "}
          connect to OpenBrowse here.
        </p>
        <div className="mt-3">
          <ConnectionStatusPanel />
        </div>
      </header>

      <section>
        <h2 className="text-sm font-semibold">Connected tools</h2>
        <div className="mt-3">
          <ConnectedToolsSection />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Preferences</h2>
        <div className="mt-3">
          <PreferencesSection />
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          What MCP clients are doing right now, plus tasks they've
          finished recently.
        </p>
        <div className="mt-3">
          <ActivitySection />
        </div>
      </section>

      <AdvancedSection />
    </div>
  );
}
