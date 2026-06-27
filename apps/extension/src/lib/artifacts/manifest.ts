export type ToolMode = "read" | "write";

export interface ToolEntry {
  name: string;          // "mcp.<server>.<tool>" | "browser.<tool>" | "system.<tool>"
  mode: ToolMode;
}

export interface ArtifactManifest {
  v: 1;
  id: string;
  title: string;
  /**
   * A single emoji used as the artifact's icon (favicon in the standalone tab,
   * leading glyph in lists). Required for newly created artifacts; older
   * artifacts may not have one — display sites should fall back to a default
   * (e.g. 📦) when missing.
   */
  icon?: string;
  description?: string;
  tools: ToolEntry[];
  cdns?: string[];
  network?: string[];
}

export interface ArtifactSidecar {
  id: string;
  createdAt: string;
  updatedAt: string;
  installedAt?: string;
  lastOpenedAt?: string;
  sourceConversationId?: string;
  favorite?: boolean;
  approvedWrites: string[];
  approvedNetwork: string[];
  manifestVersion: string;
}
