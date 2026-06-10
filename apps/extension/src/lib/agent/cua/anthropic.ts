import { createAnthropic } from "@ai-sdk/anthropic";
import type { CanonicalAction, ModifierKey } from "./actions";
import { mapAnthropicCoord } from "./coords";
import { cuaToModelOutput, runCuaToolLoop } from "./cua-loop";
import { isNewGenComputerUseModel } from "./model-ids";
import { buildCuaNavTools } from "./nav-tools";
import type { CuaProvider, CuaRunConfig, CuaRunResult } from "./provider";

export interface AnthropicToolSpec {
  toolVersion: "computer_20250124" | "computer_20251124";
  beta: "computer-use-2025-01-24" | "computer-use-2025-11-24";
  enableZoom: boolean;
}

/**
 * Map an Anthropic model id to its computer-use tool version + beta header.
 * `computer_20251124` for Opus 4.5+/Sonnet 4.6; otherwise the 2025-01-24
 * generation. Handles both direct (`claude-sonnet-4-6`) and gateway
 * (`anthropic/claude-sonnet-4.6`) id forms via `isNewGenComputerUseModel`.
 *
 * Zoom is enabled for new-gen models (it is now decoded into a native-resolution
 * region capture).
 */
export function anthropicToolSpec(modelId: string): AnthropicToolSpec {
  if (isNewGenComputerUseModel(modelId)) {
    return {
      toolVersion: "computer_20251124",
      beta: "computer-use-2025-11-24",
      enableZoom: true,
    };
  }
  return {
    toolVersion: "computer_20250124",
    beta: "computer-use-2025-01-24",
    enableZoom: false,
  };
}

interface AnthropicComputerInput {
  action: string;
  coordinate?: number[];
  start_coordinate?: number[];
  text?: string;
  scroll_direction?: "up" | "down" | "left" | "right";
  scroll_amount?: number;
  duration?: number;
  region?: number[];
}

const SCROLL_PX_PER_UNIT = 100;

/**
 * Decode one Anthropic computer tool input into a CanonicalAction, mapping
 * coordinates into CSS pixels via the downscale factor.
 */
export function decodeAnthropicAction(
  input: AnthropicComputerInput,
  downscale: number,
): CanonicalAction {
  const coord = (c?: number[]) =>
    c ? mapAnthropicCoord(c[0], c[1], downscale) : { x: 0, y: 0 };

  switch (input.action) {
    case "left_click":
    case "mouse_move": {
      const { x, y } = coord(input.coordinate);
      if (input.action === "mouse_move") return { kind: "move", x, y };
      const modifiers = parseModifiers(input.text);
      return { kind: "click", x, y, button: "left", clickCount: 1, ...(modifiers.length && { modifiers }) };
    }
    case "right_click": {
      const { x, y } = coord(input.coordinate);
      return { kind: "click", x, y, button: "right", clickCount: 1 };
    }
    case "middle_click": {
      const { x, y } = coord(input.coordinate);
      return { kind: "click", x, y, button: "middle", clickCount: 1 };
    }
    case "double_click": {
      const { x, y } = coord(input.coordinate);
      return { kind: "click", x, y, button: "left", clickCount: 2 };
    }
    case "triple_click": {
      const { x, y } = coord(input.coordinate);
      return { kind: "click", x, y, button: "left", clickCount: 3 };
    }
    case "left_click_drag": {
      const from = coord(input.start_coordinate);
      const to = coord(input.coordinate);
      return { kind: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y };
    }
    case "scroll": {
      const { x, y } = coord(input.coordinate);
      const amount = (input.scroll_amount ?? 3) * SCROLL_PX_PER_UNIT;
      const dir = input.scroll_direction ?? "down";
      const deltaX = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const deltaY = dir === "up" ? -amount : dir === "down" ? amount : 0;
      return { kind: "scroll", x, y, deltaX, deltaY };
    }
    case "type":
      return { kind: "type", text: input.text ?? "" };
    case "key":
      return { kind: "key", keys: (input.text ?? "").split("+").map((k) => k.trim()).filter(Boolean) };
    case "wait":
      return { kind: "wait", ms: Math.round((input.duration ?? 1) * 1000) };
    case "cursor_position":
    case "screenshot":
      return { kind: "screenshot" };
    case "left_mouse_down": {
      const { x, y } = coord(input.coordinate);
      return { kind: "mouseDown", x, y };
    }
    case "left_mouse_up": {
      const { x, y } = coord(input.coordinate);
      return { kind: "mouseUp", x, y };
    }
    case "hold_key":
      return {
        kind: "holdKey",
        keys: (input.text ?? "").split("+").map((k) => k.trim()).filter(Boolean),
        ms: Math.round((input.duration ?? 1) * 1000),
      };
    case "zoom": {
      const r = input.region ?? [0, 0, 0, 0];
      return { kind: "zoom", x1: r[0], y1: r[1], x2: r[2], y2: r[3] };
    }
    default:
      return { kind: "screenshot" };
  }
}

function parseModifiers(text?: string): ModifierKey[] {
  if (!text) return [];
  const map: Record<string, ModifierKey> = {
    shift: "shift",
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    super: "super",
    cmd: "super",
    meta: "super",
  };
  return text
    .split("+")
    .map((t) => map[t.trim().toLowerCase()])
    .filter((m): m is ModifierKey => !!m);
}

/**
 * Anthropic CUA provider. Injects a single `anthropic.tools.computer_*`
 * tool whose execute decodes the model's action and runs it, returning a
 * screenshot. Sets the matching computer-use beta header.
 */
export function createAnthropicCuaProvider(apiKey: string): CuaProvider {
  return {
    async runLoop(cfg: CuaRunConfig): Promise<CuaRunResult> {
      const spec = anthropicToolSpec(cfg.modelId);
      const anthropic = createAnthropic({
        apiKey,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      });

      return runCuaToolLoop(cfg, ({ downscale, displayWidth, displayHeight, runAction }) => {
        const tools = anthropic.tools as Record<
          string,
          (opts: unknown) => unknown
        >;
        const factory = tools[spec.toolVersion];
        const computer = factory({
          displayWidthPx: displayWidth,
          displayHeightPx: displayHeight,
          ...(spec.enableZoom && { enableZoom: true }),
          execute: async (input: unknown) => {
            const action = decodeAnthropicAction(input as never, downscale);
            return runAction(action);
          },
          // The AI SDK contract splits the plain tool OUTPUT (returned by
          // `execute`) from the model-facing content (`toModelOutput`).
          // `cuaToModelOutput` converts the `{ imageDataUrl, currentUrl, ... }`
          // OUTPUT into a text-then-image content part so Claude SEES the
          // screenshot and the current URL. Shared with the navigation tools.
          toModelOutput: cuaToModelOutput,
        });
        return {
          tools: { computer, ...buildCuaNavTools(runAction) },
          providerOptions: { anthropic: { beta: [spec.beta] } },
        };
      });
    },
  };
}
