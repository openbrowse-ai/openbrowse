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
  /**
   * Conversation id driving this CUA loop. Required for per-tab overlay
   * ownership: when a parent agent spawns N parallel subagents (each with
   * its own child cid and its own working tab), the overlay state map keys
   * by tabId but stamps ownership by conversationId so a finishing peer
   * can't clear another peer's working overlay. Subagents inherit a fresh
   * cid via the child conversation; the parent's CUA driver (when used
   * directly) passes its own cid here. May be null in tests or legacy paths
   * that don't drive an overlay.
   */
  conversationId?: string | null;
  /**
   * Space glow color to paint the overlay with. Resolved by the caller from
   * the conversation's space — parent and child subagents inherit the same
   * color when they share a space; an incognito child has spaceId=null and
   * therefore color=null. May be null when no Space is bound.
   */
  spaceColor?: string | null;
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
