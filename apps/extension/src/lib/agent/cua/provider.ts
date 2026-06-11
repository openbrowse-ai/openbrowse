import type { LanguageModel } from "ai";
import type { BrowserDriver, TabId } from "../driver";

export interface CuaRunConfig {
  model: LanguageModel;
  driver: BrowserDriver;
  tabId: TabId;
  /** SDK model id (e.g. "claude-sonnet-4-6"), used to pick tool version. */
  modelId: string;
  /** The delegated task text. */
  task: string;
  systemPrompt: string;
  maxSteps: number;
  /**
   * Max width (CSS px) of the display declared to the model; the viewport is
   * downscaled to fit. Lets a provider tune the resolution/cost tradeoff.
   * Defaults to 1280 when unset.
   */
  maxDisplayWidth?: number;
  abortSignal?: AbortSignal;
  /** Called with each assistant UIMessage so the runner can persist the trace. */
  onUiMessage?: (message: unknown) => void;
}

export interface CuaRunResult {
  finalText: string;
  status: "completed" | "failed" | "cancelled" | "budget-exceeded";
  errorMessage?: string;
}

export interface CuaProvider {
  runLoop(cfg: CuaRunConfig): Promise<CuaRunResult>;
}
