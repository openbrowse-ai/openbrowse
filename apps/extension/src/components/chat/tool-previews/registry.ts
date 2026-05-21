import type { ReactNode } from "react";

export type ToolPreviewRenderer = (args: Record<string, unknown>) => ReactNode;

const registry = new Map<string, ToolPreviewRenderer>();

export function registerToolPreview(toolName: string, renderer: ToolPreviewRenderer) {
  registry.set(toolName, renderer);
}

export function getToolPreview(toolName: string): ToolPreviewRenderer | undefined {
  return registry.get(toolName);
}
