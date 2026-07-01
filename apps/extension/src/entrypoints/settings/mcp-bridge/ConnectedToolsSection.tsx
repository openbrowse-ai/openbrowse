import { HostsList } from "./HostsList";

export function ConnectedToolsSection() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        MCP clients (like Cursor, Claude Desktop, or OpenCode) that have
        connected to OpenBrowse. Change how they're confirmed, or block
        them entirely.
      </p>
      <HostsList />
    </div>
  );
}
