import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { McpServerConfig, McpServerState, McpToolPermission } from "@/lib/mcp/types";
import { ConnectorPermissions } from "./ConnectorPermissions";

interface McpConnectorDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: McpServerConfig;
  state: McpServerState | undefined;
  onUpdatePermissions: (toolPermissions: Record<string, McpToolPermission>) => void;
  onDisconnect: () => void;
}

export function McpConnectorDetail({
  open,
  onOpenChange,
  server,
  state,
  onUpdatePermissions,
  onDisconnect,
}: McpConnectorDetailProps) {
  const tools = state?.tools ?? [];
  const permissions = server.toolPermissions ?? {};

  const handlePermissionChange = (toolName: string, permission: McpToolPermission) => {
    const updated = { ...permissions, [toolName]: permission };
    if (permission === "allowed") delete updated[toolName];
    onUpdatePermissions(updated);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <DialogTitle className="text-base">{server.name}</DialogTitle>
          <Button variant="outline" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        </DialogHeader>

        <div className="text-xs text-muted-foreground font-mono truncate pb-2 border-b">
          {server.url}
        </div>

        {tools.length > 0 && (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 mt-1">
            <ConnectorPermissions
              tools={tools}
              permissions={permissions}
              onPermissionChange={handlePermissionChange}
            />
          </div>
        )}

        {tools.length === 0 && state?.status === "connected" && (
          <div className="text-xs text-muted-foreground text-center py-6">
            No tools available from this server.
          </div>
        )}

        {state?.status !== "connected" && (
          <div className="text-xs text-muted-foreground text-center py-6">
            Connect to view available tools.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
