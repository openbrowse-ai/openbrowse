import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RegistryIcon } from "@/components/ui/registry-icon";
import { useMcpState } from "@/hooks/useMcpState";
import type { McpServerConfig, McpToolPermission } from "@/lib/mcp/types";
import type { Settings } from "@/lib/types";
import { connectors } from "@openbrowse/connectors";
import type { ConnectorDefinition } from "@openbrowse/connectors";
import {
  ChevronLeft,
  ExternalLink,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConnectorPermissions } from "./ConnectorPermissions";

interface ConnectorsTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => Promise<void> | void;
}

export function ConnectorsTab({ settings, onChange }: ConnectorsTabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    settings.mcpServers[0]?.id ?? null,
  );
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [browseDetail, setBrowseDetail] = useState<ConnectorDefinition | null>(
    null,
  );
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const mcpStates = useMcpState();

  const selectedServer = selectedId
    ? settings.mcpServers.find((s) => s.id === selectedId)
    : null;
  const selectedRegistry = selectedServer
    ? getRegistryEntry(selectedServer.url)
    : undefined;

  const connectedUrls = new Set(settings.mcpServers.map((s) => s.url));

  const activeServers = settings.mcpServers.filter((s) => {
    const state = mcpStates.find((st) => st.config.id === s.id);
    return state?.status === "connected";
  });
  const inactiveServers = settings.mcpServers.filter((s) => {
    const state = mcpStates.find((st) => st.config.id === s.id);
    return state?.status !== "connected";
  });

  function getRegistryEntry(url: string): ConnectorDefinition | undefined {
    return connectors.find((c) => c.url === url);
  }

  function isCustomServer(server: McpServerConfig): boolean {
    return !connectors.some((c) => c.url === server.url);
  }

  async function handleConnect(connector: ConnectorDefinition) {
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      name: connector.name,
      url: connector.url,
      enabled: true,
    };
    await onChange({ mcpServers: [...settings.mcpServers, server] });
    setConnecting(true);
    setBrowseOpen(false);
    setBrowseDetail(null);
    setSelectedId(server.id);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "MCP_OAUTH_START",
        serverId: server.id,
        serverConfig: server,
      });
      if (res && res.ok === false) {
        toast.error(`Failed to connect ${server.name}`, {
          description: res.error || "Unknown error",
        });
      }
    } catch (err) {
      toast.error(`Failed to connect ${server.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect(serverId: string) {
    onChange({
      mcpServers: settings.mcpServers.filter((s) => s.id !== serverId),
    });
    setSelectedId(null);
  }

  function handlePermissionChange(
    serverId: string,
    toolName: string,
    permission: McpToolPermission,
  ) {
    handleBulkPermissionChange(serverId, { [toolName]: permission });
  }

  function handleBulkPermissionChange(
    serverId: string,
    changes: Record<string, McpToolPermission>,
  ) {
    const updated = settings.mcpServers.map((s) => {
      if (s.id !== serverId) return s;
      const perms = { ...(s.toolPermissions || {}), ...changes };
      for (const [name, perm] of Object.entries(changes)) {
        if (perm === "allowed") delete perms[name];
      }
      return { ...s, toolPermissions: perms };
    });
    onChange({ mcpServers: updated });
  }

  function handleUpdateAuth(
    serverId: string,
    patch: { clientId?: string; clientSecret?: string },
  ) {
    const updated = settings.mcpServers.map((s) => {
      if (s.id !== serverId) return s;
      const nextAuth = {
        type: "oauth" as const,
        ...(s.auth ?? {}),
        ...patch,
      };
      return { ...s, auth: nextAuth };
    });
    onChange({ mcpServers: updated });
  }

  async function handleAddCustom() {
    if (!customName.trim() || !customUrl.trim()) return;
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      name: customName.trim(),
      url: customUrl.trim(),
      apiKey: customApiKey.trim() || undefined,
      enabled: true,
    };
    await onChange({ mcpServers: [...settings.mcpServers, server] });
    setCustomName("");
    setCustomUrl("");
    setCustomApiKey("");
    setCustomDialogOpen(false);
    setSelectedId(server.id);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "MCP_OAUTH_START",
        serverId: server.id,
        serverConfig: server,
      });
      if (res && res.ok === false) {
        toast.error(`Failed to connect ${server.name}`, {
          description: res.error || "Unknown error",
        });
      }
    } catch (err) {
      toast.error(`Failed to connect ${server.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleBrowseConnect(connector: ConnectorDefinition) {
    handleConnect(connector);
  }

  const filteredBrowse = connectors.filter(
    (c) =>
      !connectedUrls.has(c.url) &&
      (searchQuery === "" ||
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.description.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  return (
    <div className="flex h-full -m-4">
      {/* Left panel — connector list */}
      <div className="w-64 shrink-0 border-r border-border flex flex-col">
        {/* List header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium">Connectors</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded-md hover:bg-accent transition-colors">
                <Plus className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="bottom" className="w-64">
              <DropdownMenuItem onClick={() => setBrowseOpen(true)}>
                <Search className="h-4 w-4" />
                Browse connectors
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCustomDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add custom connector
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Connector list */}
        <div className="flex-1 overflow-y-auto py-1">
          {/* Connected section */}
          {activeServers.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                Connected
              </div>
              {activeServers.map((server) => {
                const registry = getRegistryEntry(server.url);
                return (
                  <ServerListItem
                    key={server.id}
                    server={server}
                    registry={registry}
                    isSelected={selectedId === server.id}
                    isCustom={isCustomServer(server)}
                    onClick={() => setSelectedId(server.id)}
                  />
                );
              })}
            </div>
          )}

          {/* Not connected section — servers the user added but auth is lost/pending */}
          {inactiveServers.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground mt-1">
                Not connected
              </div>
              {inactiveServers.map((server) => {
                const registry = getRegistryEntry(server.url);
                return (
                  <ServerListItem
                    key={server.id}
                    server={server}
                    registry={registry}
                    isSelected={selectedId === server.id}
                    isCustom={isCustomServer(server)}
                    onClick={() => setSelectedId(server.id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right panel — detail view */}
      <div className="flex-1 overflow-y-auto p-4">
        {!selectedServer && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            {settings.mcpServers.length === 0
              ? "Add a connector to get started"
              : "Select a connector to view details"}
          </div>
        )}

        {selectedServer && (
          <ConnectedDetail
            server={selectedServer}
            registry={selectedRegistry}
            mcpStates={mcpStates}
            connecting={connecting}
            onViewDetails={
              selectedRegistry
                ? () => {
                    setBrowseDetail(selectedRegistry);
                    setBrowseOpen(true);
                  }
                : undefined
            }
            onDisconnect={() => handleDisconnect(selectedServer.id)}
            onRemove={() => handleDisconnect(selectedServer.id)}
            onReconnect={async () => {
              setConnecting(true);
              try {
                const res = await chrome.runtime.sendMessage({
                  type: "MCP_OAUTH_START",
                  serverId: selectedServer.id,
                  serverConfig: selectedServer,
                });
                if (res && res.ok === false) {
                  toast.error(`Failed to connect ${selectedServer.name}`, {
                    description: res.error || "Unknown error",
                  });
                }
              } catch (err) {
                toast.error(`Failed to connect ${selectedServer.name}`, {
                  description: err instanceof Error ? err.message : String(err),
                });
              } finally {
                setConnecting(false);
              }
            }}
            onPermissionChange={(toolName, perm) =>
              handlePermissionChange(selectedServer.id, toolName, perm)
            }
            onBulkPermissionChange={(changes) =>
              handleBulkPermissionChange(selectedServer.id, changes)
            }
            onUpdateAuth={(patch) => handleUpdateAuth(selectedServer.id, patch)}
          />
        )}
      </div>

      {/* Browse connectors dialog */}
      <Dialog
        open={browseOpen}
        onOpenChange={(open) => {
          setBrowseOpen(open);
          if (!open) {
            setBrowseDetail(null);
            setSearchQuery("");
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col p-0 gap-0">
          {!browseDetail ? (
            <>
              <div className="px-5 pt-5 pb-3">
                <DialogHeader>
                  <DialogTitle className="text-lg">
                    Browse Connectors
                  </DialogTitle>
                </DialogHeader>
                <div className="relative mt-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search connectors..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-5 pb-5">
                <div className="grid grid-cols-2 gap-3">
                  {filteredBrowse.map((connector) => (
                    <button
                      key={connector.id}
                      onClick={() => setBrowseDetail(connector)}
                      className="flex flex-col items-start gap-2 p-4 text-left rounded-lg border border-border hover:border-foreground/20 hover:shadow-sm transition-all"
                    >
                      <div className="flex items-center gap-3 w-full">
                        <span className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                          <RegistryIcon id={connector.id} className="w-5 h-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">
                            {connector.name}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {connector.category.replace("-", " ")}
                          </div>
                        </div>
                        <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {connector.description}
                      </p>
                    </button>
                  ))}
                </div>
                {filteredBrowse.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No connectors found
                  </p>
                )}
              </div>
            </>
          ) : (
            <BrowseDetailView
              connector={browseDetail}
              isConnected={mcpStates.some(
                (s) =>
                  s.config.url === browseDetail.url && s.status === "connected",
              )}
              connecting={connecting}
              onBack={() => setBrowseDetail(null)}
              onConnect={() => handleBrowseConnect(browseDetail)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Custom connector dialog */}
      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Connector</DialogTitle>
            <DialogDescription>
              Connect to a custom MCP server by providing its name and URL.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Name</Label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="My Custom Server"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>URL</Label>
              <Input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>API Key (optional)</Label>
              <Input
                type="password"
                value={customApiKey}
                onChange={(e) => setCustomApiKey(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCustomDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddCustom}
              disabled={!customName.trim() || !customUrl.trim()}
            >
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BrowseDetailView({
  connector,
  isConnected,
  connecting,
  onBack,
  onConnect,
}: {
  connector: ConnectorDefinition;
  isConnected: boolean;
  connecting: boolean;
  onBack: () => void;
  onConnect: () => void;
}) {
  const details = connector.details;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Back button */}
      <div className="px-5 pt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <RegistryIcon id={connector.id} className="w-6 h-6" />
          </span>
          <div>
            <h2 className="text-base font-semibold">{connector.name}</h2>
            <p className="text-xs text-muted-foreground">
              {connector.description}
            </p>
          </div>
        </div>
        <Button
          onClick={onConnect}
          disabled={isConnected || connecting}
          size="sm"
        >
          {connecting ? "Connecting…" : isConnected ? "Connected" : "Connect"}
        </Button>
      </div>

      {/* Content */}
      <div className="px-5 pb-5 space-y-5">
        {/* Long description */}
        {details?.longDescription && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {details.longDescription}
          </p>
        )}

        {/* Developer */}
        {details?.developer && (
          <div>
            <p className="text-sm">
              Developed by{" "}
              {details.developer.url ? (
                <a
                  href={details.developer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
                >
                  {details.developer.name}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-foreground">
                  {details.developer.name}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Only use connectors from developers you trust. OpenBrowse does not
              control which tools developers make available and cannot verify
              that they will work as intended or that they won't change.
            </p>
          </div>
        )}

        {/* Tools */}
        {details?.tools && details.tools.length > 0 && (
          <div>
            <h3 className="text-sm font-medium mb-2">
              Tools{" "}
              <span className="text-muted-foreground font-normal">
                {details.tools.length}
              </span>
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {details.tools.map((tool) => (
                <span
                  key={tool}
                  className="px-2 py-1 text-xs rounded-md border border-border bg-muted/50"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Details grid */}
        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-medium mb-3">Details</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            {details?.developer && (
              <div>
                <div className="text-muted-foreground text-xs mb-0.5">
                  Author
                </div>
                {details.developer.url ? (
                  <a
                    href={details.developer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground inline-flex items-center gap-1"
                  >
                    {details.developer.name}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span>{details.developer.name}</span>
                )}
              </div>
            )}
            <div>
              <div className="text-muted-foreground text-xs mb-0.5">
                Connector URL
              </div>
              <span className="text-xs font-mono break-all">
                {connector.url}
              </span>
            </div>
          </div>
        </div>

        {/* Links */}
        {details?.links && details.links.length > 0 && (
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-medium mb-2">More info</h3>
            <div className="flex flex-col gap-1.5">
              {details.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-foreground inline-flex items-center gap-1 hover:underline"
                >
                  {link.label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectedDetail({
  server,
  registry,
  mcpStates,
  connecting,
  onViewDetails,
  onDisconnect,
  onRemove,
  onReconnect,
  onPermissionChange,
  onBulkPermissionChange,
  onUpdateAuth,
}: {
  server: McpServerConfig;
  registry?: ConnectorDefinition;
  mcpStates: ReturnType<typeof useMcpState>;
  connecting: boolean;
  onViewDetails?: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onReconnect: () => void;
  onPermissionChange: (toolName: string, permission: McpToolPermission) => void;
  onBulkPermissionChange: (changes: Record<string, McpToolPermission>) => void;
  onUpdateAuth: (auth: { clientId?: string; clientSecret?: string }) => void;
}) {
  const state = mcpStates.find((s) => s.config.id === server.id);
  const tools = state?.tools ?? [];
  const permissions = server.toolPermissions ?? {};
  const isConnected = state?.status === "connected";
  const isExplicitlyDisconnected = !state || state.status !== "connected";

  if (isExplicitlyDisconnected) {
    const requiresManual = registry?.requiresManualClientId === true;
    return (
      <div className="h-full flex flex-col">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-2 rounded-md hover:bg-accent transition-colors">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onViewDetails && (
                <>
                  <DropdownMenuItem onClick={onViewDetails}>
                    View details
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem className="text-destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
            {registry ? (
              <RegistryIcon id={registry.id} className="w-7 h-7" />
            ) : (
              <span className="text-lg font-medium">{server.name[0]}</span>
            )}
          </span>
          <p className="text-sm text-muted-foreground">
            You are not connected to {server.name} yet.
          </p>

          {requiresManual && (
            <ManualClientIdForm
              server={server}
              registry={registry}
              onUpdateAuth={onUpdateAuth}
            />
          )}

          <Button
            size="sm"
            onClick={onReconnect}
            disabled={connecting || (requiresManual && !server.auth?.clientId)}
          >
            {connecting ? "Connecting…" : "Connect"}
          </Button>
          {state?.error && (
            <p className="text-xs text-red-600 max-w-sm text-center px-4">
              {state.error}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
            {registry ? (
              <RegistryIcon id={registry.id} className="w-5 h-5" />
            ) : (
              <span className="text-sm font-medium">{server.name[0]}</span>
            )}
          </span>
          <h3 className="text-base font-semibold">{server.name}</h3>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-2 rounded-md hover:bg-accent transition-colors">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onViewDetails && (
                <DropdownMenuItem onClick={onViewDetails}>
                  View details
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={onRemove}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Description */}
      {registry && (
        <p className="text-sm text-muted-foreground">{registry.description}</p>
      )}
      {!registry && (
        <p className="text-xs text-muted-foreground font-mono">{server.url}</p>
      )}

      {/* Tools */}
      {tools.length > 0 && (
        <ConnectorPermissions
          tools={tools}
          permissions={permissions}
          onPermissionChange={onPermissionChange}
          onBulkPermissionChange={onBulkPermissionChange}
        />
      )}

      {tools.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">
          No tools available from this server.
        </p>
      )}

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
    </div>
  );
}

function ServerListItem({
  server,
  registry,
  isSelected,
  isCustom,
  onClick,
}: {
  server: McpServerConfig;
  registry?: ConnectorDefinition;
  isSelected: boolean;
  isCustom: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
      }`}
    >
      <span className="w-5 h-5 rounded bg-muted flex items-center justify-center shrink-0">
        {registry ? (
          <RegistryIcon id={registry.id} className="w-3.5 h-3.5" />
        ) : (
          <span className="text-[10px] font-medium">{server.name[0]}</span>
        )}
      </span>
      <span className="truncate flex-1">{server.name}</span>
      {isCustom && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Custom
        </span>
      )}
    </button>
  );
}

function ManualClientIdForm({
  server,
  registry,
  onUpdateAuth,
}: {
  server: McpServerConfig;
  registry?: ConnectorDefinition;
  onUpdateAuth: (auth: { clientId?: string; clientSecret?: string }) => void;
}) {
  const help = registry?.manualClientIdHelp;
  const needsSecret = help?.needsSecret ?? false;
  const [clientId, setClientId] = useState(server.auth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(
    server.auth?.clientSecret ?? "",
  );
  const redirectUri =
    typeof chrome !== "undefined" && chrome.identity?.getRedirectURL
      ? chrome.identity.getRedirectURL()
      : "";

  function commit() {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (
      trimmedId === (server.auth?.clientId ?? "") &&
      trimmedSecret === (server.auth?.clientSecret ?? "")
    ) {
      return;
    }
    onUpdateAuth({
      clientId: trimmedId || undefined,
      clientSecret: trimmedSecret || undefined,
    });
  }

  async function copyRedirect() {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      toast.success("Redirect URL copied");
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="w-full max-w-md text-left border border-border rounded-lg p-3 space-y-3 bg-card">
      <div>
        <h4 className="text-sm font-medium">OAuth credentials required</h4>
        {help?.instructions && (
          <p className="text-xs text-muted-foreground mt-1">
            {help.instructions}
          </p>
        )}
      </div>

      {redirectUri && (
        <div>
          <Label className="text-xs">Redirect URL</Label>
          <div className="flex gap-2 mt-1">
            <Input
              readOnly
              value={redirectUri}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyRedirect}
            >
              Copy
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Add this exact URL to your OAuth app's allowed redirect URLs.
          </p>
        </div>
      )}

      <div>
        <Label htmlFor={`client-id-${server.id}`} className="text-xs">
          Client ID
        </Label>
        <Input
          id={`client-id-${server.id}`}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          onBlur={commit}
          placeholder="e.g. 1234567890.1234567890"
          className="mt-1"
          autoComplete="off"
        />
      </div>

      {needsSecret && (
        <div>
          <Label htmlFor={`client-secret-${server.id}`} className="text-xs">
            Client Secret
          </Label>
          <Input
            id={`client-secret-${server.id}`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            onBlur={commit}
            placeholder="••••••••"
            className="mt-1"
            autoComplete="off"
          />
        </div>
      )}

      {help?.setupUrl && (
        <a
          href={help.setupUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-foreground inline-flex items-center gap-1 hover:underline"
        >
          Open setup instructions
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
