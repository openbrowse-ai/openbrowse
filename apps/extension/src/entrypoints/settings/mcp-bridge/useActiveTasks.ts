import { useEffect, useState } from "react";
import {
  TASKS_PORT_NAME,
  type ActiveTaskPublicSummary,
  type TasksTickMessage,
} from "@/entrypoints/background/mcp-bridge-tasks-port";

/**
 * Subscribe to active MCP tasks pushed from the SW over a long-lived
 * `chrome.runtime.connect` port.
 */
export function useActiveTasks(): ActiveTaskPublicSummary[] {
  const [tasks, setTasks] = useState<ActiveTaskPublicSummary[]>([]);
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: TASKS_PORT_NAME });
    } catch {
      return;
    }
    const handler = (raw: unknown) => {
      if (!isTick(raw)) return;
      setTasks(raw.tasks);
    };
    port.onMessage.addListener(handler);
    return () => {
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
    };
  }, []);
  return tasks;
}

function isTick(x: unknown): x is TasksTickMessage {
  return (
    x !== null &&
    typeof x === "object" &&
    (x as { type?: string }).type === "MCP_BRIDGE_TASKS_TICK" &&
    Array.isArray((x as { tasks?: unknown }).tasks)
  );
}
