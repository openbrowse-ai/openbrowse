import { DEFAULT_SETTINGS } from "@/lib/constants";
import { storage } from "@/lib/storage";
import type { AIProvider, ModelStatus, Settings } from "@/lib/types";
import { getProvider } from "@/registry/providers";
import { browserAI, doesBrowserSupportBrowserAI } from "@browser-ai/core";
import { doesBrowserSupportWebLLM, webLLM } from "@browser-ai/web-llm";
import {
  type AppConfig,
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
} from "@mlc-ai/web-llm";
import { WEB_LLM_MODEL_CONTEXT } from "@/registry/providers/web-llm-model-context";
import { createSerialQueue } from "./download-queue";
import { withLocalEngineLock } from "./engine-lock";

export interface CloudConfig {
  cloudProvider: Settings["cloudProvider"];
  cloudApiKey: string;
  cloudModel: string;
  cloudBaseUrl: string;
}

let currentModel:
  | ReturnType<typeof webLLM>
  | ReturnType<typeof browserAI>
  | null = null;
let currentProvider: AIProvider | null = null;
let currentModelId: string | null = null;

/**
 * All local-model downloads funnel through one serial queue. WebLLM / Gemini
 * Nano share a single WebGPU / `chrome.ai` engine in this offscreen document;
 * running two loads at once contends on that engine and stalls at 0%. The
 * queue also dedupes a model against itself, so a double-click or a duplicate
 * `DOWNLOAD_MODEL` message can't launch the same download twice.
 */
const downloadQueue = createSerialQueue();

/**
 * Construct a WebLLM model handle with its context window raised from mlc's
 * conservative prebuilt default (4096) to the model's real, sourced window
 * (see `web-llm-model-context.ts`).
 *
 * The override must ride on `engineConfig.appConfig`: `@browser-ai/web-llm`
 * declares a top-level `appConfig` option but its runtime ignores it, only
 * forwarding `engineConfig` into `new MLCEngine(...)`. mlc's `reload()` then
 * merges `overrides.context_window_size` over the fetched model config, and
 * the paged KV cache treats it as a ceiling that grows on demand — so a large
 * window costs nothing at load (verified empirically at 131072).
 */
let lastProgressPct = -1;

function reportLocalModelLoadProgress(
  modelId: string,
  progress: number,
  text: string,
): void {
  // mlc fires the init-progress callback very frequently (per tensor/shard).
  // Throttle to whole-percent changes so we don't flood every extension
  // context (and its console) with hundreds of near-identical messages.
  const pct = Math.round((progress ?? 0) * 100);
  if (pct === lastProgressPct && pct < 100) return;
  lastProgressPct = pct >= 100 ? -1 : pct;
  try {
    chrome.runtime.sendMessage({
      type: "LOCAL_MODEL_LOAD_PROGRESS",
      modelId,
      progress,
      text,
    });
  } catch {
    // Best-effort UX signal; no receiver (or offscreen teardown) is fine.
  }
}

function createWebLLM(modelId: string): ReturnType<typeof webLLM> {
  // Surface the lazy engine load (WASM instantiate + WebGPU shader compile)
  // that happens on the first generation of an agent turn. mlc's
  // `_initializeEngine` falls back to this constructor callback when no
  // per-call progress cb is supplied, so it fires for inference but NOT for
  // downloads (which pass their own via `createSessionWithProgress`, which
  // takes precedence).
  const initProgressCallback = (report: { progress: number; text: string }) =>
    reportLocalModelLoadProgress(modelId, report.progress, report.text);
  const override = WEB_LLM_MODEL_CONTEXT[modelId]?.overrideContextWindowSize;
  if (!override) return webLLM(modelId, { initProgressCallback });
  const appConfig: AppConfig = {
    ...prebuiltAppConfig,
    model_list: prebuiltAppConfig.model_list.map((m) =>
      m.model_id === modelId
        ? {
            ...m,
            overrides: {
              ...(m.overrides ?? {}),
              context_window_size: override,
              sliding_window_size: -1,
            },
          }
        : m,
    ),
  };
  return webLLM(modelId, { initProgressCallback, engineConfig: { appConfig } });
}

async function createCloudModel(
  cloudConfig: CloudConfig,
  modelIdOverride?: string,
) {
  const apiKey = cloudConfig.cloudApiKey;
  if (!apiKey) {
    throw new Error(
      "Cloud API key not configured. Go to Settings to add your key.",
    );
  }

  const modelId = modelIdOverride || cloudConfig.cloudModel;

  if (cloudConfig.cloudProvider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey });
    return anthropic(modelId);
  }

  if (cloudConfig.cloudProvider === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelId);
  }

  // openai or openai-compatible
  const { createOpenAI } = await import("@ai-sdk/openai");
  const openai = createOpenAI({
    apiKey,
    ...(cloudConfig.cloudBaseUrl ? { baseURL: cloudConfig.cloudBaseUrl } : {}),
  });
  return openai(modelId);
}

export async function getModel(
  providerOverride?: AIProvider,
  modelIdOverride?: string,
  cloudConfig?: CloudConfig,
) {
  const provider =
    providerOverride || DEFAULT_SETTINGS.aiProvider || "browser-ai";

  if (provider === "disabled") {
    throw new Error("AI is disabled");
  }

  if (provider === "cloud") {
    if (!cloudConfig) {
      throw new Error(
        "Cloud configuration not provided. Go to Settings to configure your cloud provider.",
      );
    }
    return await createCloudModel(cloudConfig, modelIdOverride);
  }

  if (provider === "browser-ai") {
    if (currentModel && currentProvider === "browser-ai") {
      return currentModel;
    }
    currentModel = browserAI("text");
    currentProvider = "browser-ai";
    currentModelId = "text";
    return currentModel;
  }

  const modelId =
    modelIdOverride ||
    DEFAULT_SETTINGS.webllmModel ||
    "Llama-3.2-3B-Instruct-q4f16_1-MLC";

  if (
    currentModel &&
    currentProvider === "web-llm" &&
    currentModelId === modelId
  ) {
    return currentModel;
  }

  currentModel = createWebLLM(modelId);
  currentProvider = "web-llm";
  currentModelId = modelId;
  return currentModel;
}

export async function checkAvailability(
  provider: AIProvider,
  webllmModel?: string,
  cloudConfig?: CloudConfig,
): Promise<ModelStatus> {
  if (provider === "disabled") {
    return {
      provider,
      availability: "available",
      message: "AI features disabled",
    };
  }

  if (provider === "browser-ai") {
    if (!doesBrowserSupportBrowserAI()) {
      return {
        provider,
        availability: "unavailable",
        message:
          "Browser does not support built-in AI (requires Chrome 138+ with Prompt API enabled)",
      };
    }
    try {
      const model = browserAI("text");
      const avail = await model.availability();
      console.log("[OpenBrowse] browser-ai availability:", avail);
      if (avail === "available") {
        return {
          provider,
          availability: "available",
          message: "Gemini Nano ready",
        };
      }
      if (avail === "available-after-download") {
        return {
          provider,
          availability: "downloadable",
          message: "Gemini Nano available but needs download",
        };
      }
      if (avail === "downloadable") {
        return {
          provider,
          availability: "downloadable",
          message: "Gemini Nano available — download required",
        };
      }
      if (avail === "downloading") {
        return {
          provider,
          availability: "downloadable",
          message: "Gemini Nano is currently downloading…",
        };
      }
      return {
        provider,
        availability: "unavailable",
        message: `Built-in AI model not available (status: ${avail})`,
      };
    } catch (err) {
      return {
        provider,
        availability: "error",
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (provider === "cloud") {
    if (!cloudConfig || !cloudConfig.cloudApiKey) {
      return {
        provider,
        availability: "unavailable",
        message: "No API key configured",
      };
    }
    return {
      provider,
      availability: "available",
      message: `${cloudConfig.cloudProvider} (${cloudConfig.cloudModel}) ready`,
    };
  }

  if (provider === "web-llm") {
    if (!doesBrowserSupportWebLLM()) {
      return {
        provider,
        availability: "unavailable",
        message: "Browser does not support WebGPU (required for WebLLM)",
      };
    }
    const modelId =
      webllmModel ||
      DEFAULT_SETTINGS.webllmModel ||
      "Llama-3.2-3B-Instruct-q4f16_1-MLC";
    if (
      currentModel &&
      currentProvider === "web-llm" &&
      currentModelId === modelId
    ) {
      return {
        provider,
        availability: "available",
        message: `${modelId} loaded and ready`,
      };
    }
    try {
      const isCached = await hasModelInCache(modelId);
      if (isCached) {
        return {
          provider,
          availability: "available",
          message: `${modelId} downloaded — ready to load`,
        };
      }
      const model = createWebLLM(modelId);
      const avail = await model.availability();
      if (avail === "available") {
        return {
          provider,
          availability: "available",
          message: `${modelId} loaded and ready`,
        };
      }
      if (avail === "downloadable") {
        return {
          provider,
          availability: "downloadable",
          message: `${modelId} needs to be downloaded first`,
        };
      }
      return {
        provider,
        availability: "unavailable",
        message: `${modelId} not available`,
      };
    } catch (err) {
      return {
        provider,
        availability: "error",
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { provider, availability: "error", message: "Unknown provider" };
}

export async function downloadModel(
  modelId: string,
): Promise<{ success: boolean; message: string }> {
  return downloadQueue.run(`web-llm:${modelId}`, () =>
    performDownloadModel(modelId),
  );
}

async function performDownloadModel(
  modelId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const model = createWebLLM(modelId);
    const modelKey = `web-llm:${modelId}`;
    await model.createSessionWithProgress((progress: number) => {
      chrome.runtime
        .sendMessage({
          target: "settings",
          type: "DOWNLOAD_PROGRESS",
          modelKey,
          progress: Math.round(progress * 100),
        })
        .catch(() => {});
    });
    currentModel = model;
    currentProvider = "web-llm";
    currentModelId = modelId;
    try {
      await storage.addDownloadedModel(modelId);
    } catch {}
    chrome.runtime
      .sendMessage({
        target: "settings",
        type: "DOWNLOAD_PROGRESS",
        modelKey,
        progress: 100,
        done: true,
      })
      .catch(() => {});
    return { success: true, message: `${modelId} downloaded and ready` };
  } catch (err) {
    chrome.runtime
      .sendMessage({
        target: "settings",
        type: "DOWNLOAD_PROGRESS",
        modelKey: `web-llm:${modelId}`,
        progress: -1,
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function downloadBrowserAI(): Promise<{
  success: boolean;
  message: string;
}> {
  return downloadQueue.run("browser-ai:gemini-nano", () =>
    performDownloadBrowserAI(),
  );
}

async function performDownloadBrowserAI(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    if (!doesBrowserSupportBrowserAI()) {
      const errorMsg =
        "Requires Chrome 138+ with Prompt API enabled. Go to chrome://flags/#prompt-api-for-gemini-nano and enable it, then relaunch Chrome.";
      chrome.runtime
        .sendMessage({
          target: "settings",
          type: "DOWNLOAD_PROGRESS",
          modelKey: "browser-ai:gemini-nano",
          progress: -1,
          error: errorMsg,
        })
        .catch(() => {});
      return { success: false, message: errorMsg };
    }

    const model = browserAI("text");
    const modelKey = "browser-ai:gemini-nano";

    const avail = await model.availability();
    if (avail === "unavailable" || avail === "no") {
      const errorMsg =
        'Gemini Nano not available. Enable it at chrome://flags/#optimization-guide-on-device-model (set to "Enabled BypassPerfRequirement"), then relaunch Chrome and check chrome://components for the model download.';
      chrome.runtime
        .sendMessage({
          target: "settings",
          type: "DOWNLOAD_PROGRESS",
          modelKey,
          progress: -1,
          error: errorMsg,
        })
        .catch(() => {});
      return { success: false, message: errorMsg };
    }

    // #region DEBUG
    console.log(
      "[DEBUG H2] downloadBrowserAI called, about to createSessionWithProgress",
    );
    // #endregion DEBUG
    await model.createSessionWithProgress((progress: number) => {
      // #region DEBUG
      console.log("[DEBUG H2] progress callback fired:", progress);
      // #endregion DEBUG
      chrome.runtime
        .sendMessage({
          target: "settings",
          type: "DOWNLOAD_PROGRESS",
          modelKey,
          progress: Math.round(progress * 100),
        })
        .catch((err) => {
          // #region DEBUG
          console.log("[DEBUG H1] sendMessage failed:", err);
          // #endregion DEBUG
        });
    });
    currentModel = model;
    currentProvider = "browser-ai";
    currentModelId = "text";
    chrome.runtime
      .sendMessage({
        target: "settings",
        type: "DOWNLOAD_PROGRESS",
        modelKey,
        progress: 100,
        done: true,
      })
      .catch(() => {});
    return { success: true, message: "Gemini Nano downloaded and ready" };
  } catch (err) {
    chrome.runtime
      .sendMessage({
        target: "settings",
        type: "DOWNLOAD_PROGRESS",
        modelKey: "browser-ai:gemini-nano",
        progress: -1,
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkModelCache(
  modelIds: string[],
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const modelId of modelIds) {
    try {
      const cached = await hasModelInCache(modelId);
      console.log(`[OpenBrowse] hasModelInCache(${modelId}) = ${cached}`);
      result[modelId] = cached;
    } catch (err) {
      console.warn(`[OpenBrowse] hasModelInCache(${modelId}) threw:`, err);
      result[modelId] = false;
    }
  }
  return result;
}

export async function deleteModel(
  modelId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    await deleteModelAllInfoInCache(modelId);
    if (currentModelId === modelId) {
      currentModel = null;
      currentProvider = null;
      currentModelId = null;
    }
    try {
      await storage.removeDownloadedModel(modelId);
    } catch {}
    return { success: true, message: `${modelId} deleted` };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Registry-based functions (new path, existing functions preserved above) ---

export async function createModelFromRegistry(
  providerId: string,
  config: Record<string, string>,
  modelId: string,
) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (provider.setup !== "byok") {
    throw new Error(
      `Provider ${providerId} does not support createLanguageModel directly`,
    );
  }
  return await provider.createLanguageModel(config, modelId);
}

export async function getModelFromRegistry(
  providerId: string,
  config: Record<string, string>,
  modelId: string,
) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  if (provider.setup === "byok") {
    return await provider.createLanguageModel(config, modelId);
  }

  if (provider.setup === "browser-ai") {
    if (currentModel && currentProvider === "browser-ai") return currentModel;
    currentModel = browserAI("text");
    currentProvider = "browser-ai";
    currentModelId = "text";
    return currentModel;
  }

  // web-llm
  if (
    currentModel &&
    currentProvider === "web-llm" &&
    currentModelId === modelId
  ) {
    return currentModel;
  }
  currentModel = createWebLLM(modelId);
  currentProvider = "web-llm";
  currentModelId = modelId;
  return currentModel;
}

export async function testConnectionFromRegistry(
  providerId: string,
  config: Record<string, string>,
  modelId?: string,
): Promise<{ success: boolean; message: string; responseTime: number }> {
  const { generateText } = await import("ai");
  const start = performance.now();

  try {
    const provider = getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    let model;
    if (provider.setup === "byok") {
      const resolvedModelId = modelId || provider.models[0]?.id || "";
      model = await provider.createLanguageModel(config, resolvedModelId);
    } else if (provider.setup === "browser-ai") {
      model = browserAI("text");
    } else if (provider.setup === "web-llm") {
      const resolvedModelId = modelId || provider.models[0]?.id || "";
      model = createWebLLM(resolvedModelId);
    } else {
      return { success: false, message: "Unknown setup type", responseTime: 0 };
    }

    const { text } = await generateText({
      model,
      prompt: "Respond with exactly: OK",
      maxOutputTokens: 10,
    });

    const elapsed = Math.round(performance.now() - start);
    return {
      success: true,
      message: `Model responded: "${text.trim()}"`,
      responseTime: elapsed,
    };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      responseTime: elapsed,
    };
  }
}

export async function generateChatTitle(
  providerId: string,
  config: Record<string, string>,
  modelId: string,
  userMessage: string,
): Promise<{ title: string }> {
  const { generateText } = await import("ai");

  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const isLocal =
    provider.setup === "browser-ai" || provider.setup === "web-llm";

  let model;
  if (provider.setup === "byok") {
    model = await provider.createLanguageModel(config, modelId);
  } else if (isLocal) {
    // Reuse the agent run's cached engine instead of constructing a second one
    // (createWebLLM / browserAI). A separate engine would re-load the model's
    // multi-GB weights concurrently with the agent's first turn — the freeze
    // right after send. See getModelFromRegistry + createWebLLM.
    model = await getModelFromRegistry(providerId, config, modelId);
  } else {
    return { title: userMessage.slice(0, 50) };
  }

  const runGenerate = () =>
    generateText({
      model,
      prompt: `Summarize the following message into a short chat title (3-6 words). Output ONLY the title, nothing else.

Message: "${userMessage.slice(0, 300)}"

Title:`,
      maxOutputTokens: 30,
    });

  // Local models share one on-device engine with the agent loop; hold the
  // engine lock so title generation never overlaps an active agent turn (which
  // would contend on / interrupt the same engine).
  const { text } = isLocal
    ? await withLocalEngineLock(runGenerate)
    : await runGenerate();

  const raw = text
    .trim()
    .split("\n")[0]
    .replace(/^["']|["']$/g, "")
    .replace(/\.+$/, "")
    .trim();
  const title = raw.slice(0, 60);
  return { title: title || userMessage.slice(0, 50) };
}

export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

const TAB_GROUP_COLORS: TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

export async function generateGroupLabel(
  providerId: string,
  config: Record<string, string>,
  modelId: string,
  context: {
    chatTitle: string;
    userMessage: string;
    tabs: { title: string; url: string }[];
  },
): Promise<{ title: string; color: TabGroupColor }> {
  const { generateText } = await import("ai");

  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  let model;
  if (provider.setup === "byok") {
    model = await provider.createLanguageModel(config, modelId);
  } else if (provider.setup === "browser-ai") {
    model = browserAI("text");
  } else if (provider.setup === "web-llm") {
    model = createWebLLM(modelId);
  } else {
    return {
      title: (context.chatTitle || "Agent").slice(0, 24),
      color: "grey",
    };
  }

  const tabsSnippet = context.tabs
    .slice(0, 8)
    .map((t) => `- ${t.title} (${t.url})`)
    .join("\n");

  const prompt = `Name a Chrome tab group that contains tabs an AI agent is working on for a user.

Chat title: "${context.chatTitle}"
User request: "${context.userMessage.slice(0, 200)}"
Tabs in the group:
${tabsSnippet}

Respond with JSON only, no prose:
{"title": "2-4 word label", "color": "one of: grey, blue, red, yellow, green, pink, purple, cyan, orange"}`;

  const { text } = await generateText({
    model,
    prompt,
    maxOutputTokens: 60,
  });

  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(cleaned) as { title?: string; color?: string };
    const title = (parsed.title ?? "").trim().slice(0, 24);
    const color = TAB_GROUP_COLORS.includes(parsed.color as TabGroupColor)
      ? (parsed.color as TabGroupColor)
      : "grey";
    return { title: title || context.chatTitle.slice(0, 24) || "Agent", color };
  } catch {
    return { title: context.chatTitle.slice(0, 24) || "Agent", color: "grey" };
  }
}

// --- Legacy functions (preserved for backwards compatibility) ---

export async function testConnection(
  provider: AIProvider,
  webllmModel?: string,
  cloudConfig?: CloudConfig,
): Promise<{ success: boolean; message: string; responseTime: number }> {
  const { generateText } = await import("ai");
  const start = performance.now();

  try {
    let model;
    if (provider === "cloud") {
      model = await createCloudModel(
        cloudConfig!,
        webllmModel || cloudConfig?.cloudModel,
      );
    } else if (provider === "browser-ai") {
      model = browserAI("text");
    } else if (provider === "web-llm") {
      const modelId =
        webllmModel ||
        DEFAULT_SETTINGS.webllmModel ||
        "Llama-3.2-3B-Instruct-q4f16_1-MLC";
      model = createWebLLM(modelId);
    } else {
      return { success: false, message: "AI is disabled", responseTime: 0 };
    }

    const { text } = await generateText({
      model,
      prompt: "Respond with exactly: OK",
      maxOutputTokens: 10,
    });

    if (provider !== "cloud") {
      currentModel = model as
        | ReturnType<typeof webLLM>
        | ReturnType<typeof browserAI>;
      currentProvider = provider;
      currentModelId =
        provider === "web-llm"
          ? webllmModel ||
            DEFAULT_SETTINGS.webllmModel ||
            "Llama-3.2-3B-Instruct-q4f16_1-MLC"
          : "text";
      if (provider === "web-llm" && currentModelId) {
        try {
          await storage.addDownloadedModel(currentModelId);
        } catch {}
      }
    }

    const elapsed = Math.round(performance.now() - start);
    return {
      success: true,
      message: `Model responded: "${text.trim()}"`,
      responseTime: elapsed,
    };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
      responseTime: elapsed,
    };
  }
}
