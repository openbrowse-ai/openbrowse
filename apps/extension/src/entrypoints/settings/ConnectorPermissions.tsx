import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { McpToolInfo, McpToolPermission } from "@/lib/mcp/types";
import { CheckCircle2, Hand, Ban, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useState } from "react";

type GroupPermission = McpToolPermission | "custom";

interface ToolGroup {
  label: string;
  tools: McpToolInfo[];
}

function categorizeTools(tools: McpToolInfo[]): ToolGroup[] {
  const writePatterns = /^(create|update|delete|remove|apply|deploy|pause|restore|confirm|save|merge|reset|rebase|set|put|post|insert|drop|alter|execute|run)/i;

  const readTools: McpToolInfo[] = [];
  const writeTools: McpToolInfo[] = [];

  for (const tool of tools) {
    if (writePatterns.test(tool.name)) {
      writeTools.push(tool);
    } else {
      readTools.push(tool);
    }
  }

  const groups: ToolGroup[] = [];
  if (readTools.length > 0) groups.push({ label: "Read-only tools", tools: readTools });
  if (writeTools.length > 0) groups.push({ label: "Write/delete tools", tools: writeTools });
  return groups;
}

function getGroupPermission(
  tools: McpToolInfo[],
  permissions: Record<string, McpToolPermission>,
): GroupPermission {
  if (tools.length === 0) return "allowed";
  const first = permissions[tools[0].name] ?? "allowed";
  const allSame = tools.every((t) => (permissions[t.name] ?? "allowed") === first);
  return allSame ? first : "custom";
}

const PERMISSION_LABELS: Record<GroupPermission, string> = {
  allowed: "Always allow",
  approval: "Needs approval",
  disabled: "Blocked",
  custom: "Custom",
};

const PERMISSION_ICONS: Record<GroupPermission, typeof CheckCircle2> = {
  allowed: CheckCircle2,
  approval: Hand,
  disabled: Ban,
  custom: Hand,
};

function PermissionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-1.5 rounded-md transition-colors ${
        active
          ? "bg-accent text-foreground ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      }`}
    >
      {children}
    </button>
  );
}

function GroupSection({
  group,
  permissions,
  onPermissionChange,
  onBulkPermissionChange,
}: {
  group: ToolGroup;
  permissions: Record<string, McpToolPermission>;
  onPermissionChange: (toolName: string, p: McpToolPermission) => void;
  onBulkPermissionChange?: (changes: Record<string, McpToolPermission>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const groupPermission = getGroupPermission(group.tools, permissions);
  const Icon = PERMISSION_ICONS[groupPermission];

  const setGroupPermission = (p: McpToolPermission) => {
    if (onBulkPermissionChange) {
      const changes: Record<string, McpToolPermission> = {};
      for (const tool of group.tools) {
        changes[tool.name] = p;
      }
      onBulkPermissionChange(changes);
    } else {
      for (const tool of group.tools) {
        onPermissionChange(tool.name, p);
      }
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {group.label}
          <span className="text-xs text-muted-foreground font-normal ml-1">{group.tools.length}</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 text-xs border rounded-md px-2 py-1 hover:bg-accent transition-colors">
              <Icon className="h-3.5 w-3.5" />
              {PERMISSION_LABELS[groupPermission]}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {(["allowed", "approval", "disabled"] as const).map((p) => {
              const ItemIcon = PERMISSION_ICONS[p];
              return (
                <DropdownMenuItem key={p} onClick={() => setGroupPermission(p)}>
                  <ItemIcon className="h-4 w-4" />
                  {PERMISSION_LABELS[p]}
                  {groupPermission === p && <Check className="h-3.5 w-3.5 ml-auto text-primary" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem disabled={groupPermission === "custom"}>
              <Hand className="h-4 w-4" />
              Custom
              {groupPermission === "custom" && <Check className="h-3.5 w-3.5 ml-auto text-primary" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && (
        <div className="pl-5 space-y-0">
          {group.tools.map((tool) => {
            const perm = permissions[tool.name] ?? "allowed";
            return (
              <div key={tool.name} className="flex items-center justify-between py-2.5 border-t border-border/40">
                <div className="min-w-0 flex-1 mr-3">
                  <div className="text-sm capitalize">{tool.name.replace(/_/g, " ")}</div>
                  {tool.description && (
                    <div className="text-xs text-muted-foreground truncate max-w-[260px]">{tool.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <PermissionButton active={perm === "allowed"} onClick={() => onPermissionChange(tool.name, "allowed")}>
                    <CheckCircle2 className="h-4 w-4" />
                  </PermissionButton>
                  <PermissionButton active={perm === "approval"} onClick={() => onPermissionChange(tool.name, "approval")}>
                    <Hand className="h-4 w-4" />
                  </PermissionButton>
                  <PermissionButton active={perm === "disabled"} onClick={() => onPermissionChange(tool.name, "disabled")}>
                    <Ban className="h-4 w-4" />
                  </PermissionButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ConnectorPermissionsProps {
  tools: McpToolInfo[];
  permissions: Record<string, McpToolPermission>;
  onPermissionChange: (toolName: string, permission: McpToolPermission) => void;
  onBulkPermissionChange?: (changes: Record<string, McpToolPermission>) => void;
}

export function ConnectorPermissions({ tools, permissions, onPermissionChange, onBulkPermissionChange }: ConnectorPermissionsProps) {
  const groups = categorizeTools(tools);

  if (tools.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="mb-3">
        <h4 className="text-sm font-medium">Tool permissions</h4>
        <p className="text-xs text-muted-foreground">
          Choose when OpenBrowse is allowed to use these tools.
        </p>
      </div>

      {groups.map((group) => (
        <GroupSection
          key={group.label}
          group={group}
          permissions={permissions}
          onPermissionChange={onPermissionChange}
          onBulkPermissionChange={onBulkPermissionChange}
        />
      ))}
    </div>
  );
}
