import { getMcpRegistry } from "@/lib/mcp";
import type { McpServerState } from "@/lib/mcp/types";
import { useEffect, useState } from "react";

export function useMcpState() {
  const [states, setStates] = useState<McpServerState[]>(getMcpRegistry().getStates());

  useEffect(() => {
    const registry = getMcpRegistry();
    registry.refreshStates();
    return registry.subscribe(() => {
      setStates(registry.getStates());
    });
  }, []);

  return states;
}
