import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

function buildTree(paths: string[]): FileNode[] {
  const root: FileNode = { name: "", path: "", isDir: true, children: [] };

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let current = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isFile,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    });
  }

  function sort(node: FileNode) {
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sort(c);
  }
  sort(root);

  return root.children;
}

interface SkillFileTreeProps {
  paths: string[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** When true, the entire tree appears muted (used when the skill is disabled). */
  muted?: boolean;
}

export function SkillFileTree({
  paths,
  selectedPath,
  onSelect,
  muted = false,
}: SkillFileTreeProps) {
  const tree = buildTree(paths);
  return (
    <div className={muted ? "opacity-50" : ""}>
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

// Indent units (rem). Each depth nests by INDENT_PER_DEPTH.
// Files no longer get an extra offset so their text aligns vertically
// with the folder icon, ensuring equal left margins.
const BASE_INDENT_REM = 1.25;
const INDENT_PER_DEPTH = 0.875;

function TreeNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [open, setOpen] = useState(false);
  const isSelected = selectedPath === node.path;

  if (node.isDir) {
    const indent = `${BASE_INDENT_REM + depth * INDENT_PER_DEPTH}rem`;
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group w-full flex items-center justify-between gap-2 py-1 pr-2 text-sm text-left text-foreground/90 hover:bg-accent/50 transition-colors"
            style={{ paddingLeft: indent }}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {open ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{node.name}</span>
            </span>
            <ChevronDown
              className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
                open ? "" : "-rotate-90"
              }`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // File row: no icon, just indented text aligned with the folder icon.
  const fileIndent = `${BASE_INDENT_REM + depth * INDENT_PER_DEPTH}rem`;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={`w-full flex items-center py-1 pr-2 text-sm text-left transition-colors truncate ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : "text-foreground/90 hover:bg-accent/50"
      }`}
      style={{ paddingLeft: fileIndent }}
    >
      <span className="truncate">{node.name}</span>
    </button>
  );
}
