import {
  checkAvailability,
  checkModelCache,
  deleteModel,
  downloadBrowserAI,
  downloadModel,
  generateChatTitle,
  generateGroupLabel,
  testConnection,
  testConnectionFromRegistry,
} from "./ai";
import {
  clearPersistedPythonLog,
  getPersistedPythonLog,
  getPyodideManager,
} from "./python";
import { handleSandboxExecute, isSandboxExecutePayload } from "./sandbox-host";
import { sortTabs } from "./sort";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  const handle = async () => {
    console.log("[OpenBrowse offscreen] Received message:", message.type);
    switch (message.type) {
      case "SORT_TABS":
        return sortTabs(
          message.tabs,
          message.provider,
          message.modelId,
          message.cloudConfig,
          message.archiveAggressiveness,
        );
      case "CHECK_AVAILABILITY":
        return checkAvailability(
          message.provider,
          message.webllmModel,
          message.cloudConfig,
        );
      case "TEST_CONNECTION":
        return testConnection(
          message.provider,
          message.webllmModel,
          message.cloudConfig,
        );
      case "TEST_CONNECTION_REGISTRY":
        return testConnectionFromRegistry(
          message.providerId,
          message.config,
          message.modelId,
        );
      case "DOWNLOAD_MODEL":
        return downloadModel(message.modelId);
      case "DOWNLOAD_BROWSER_AI":
        return downloadBrowserAI();
      case "CHECK_MODEL_CACHE":
        return checkModelCache(message.modelIds);
      case "DELETE_MODEL":
        return deleteModel(message.modelId);
      case "GENERATE_CHAT_TITLE":
        return generateChatTitle(
          message.providerId,
          message.config,
          message.modelId,
          message.userMessage,
        );
      case "GENERATE_GROUP_LABEL":
        return generateGroupLabel(
          message.providerId,
          message.config,
          message.modelId,
          message.context,
        );
      case "PYTHON_EXECUTE":
        return getPyodideManager().runPython({
          conversationId: message.conversationId,
          spaceId: message.spaceId ?? null,
          code: message.code,
          timeoutMs: message.timeoutMs,
          resetState: message.resetState,
          allowNetwork: message.allowNetwork,
        });
      case "PYTHON_WARMUP":
        return getPyodideManager().warmup(message.conversationId);
      case "PYTHON_RESET":
        await getPyodideManager().reset(message.conversationId);
        return { ok: true };
      case "PYTHON_DISPOSE":
        getPyodideManager().dispose(message.conversationId);
        return { ok: true };
      case "PYTHON_GET_LOG":
        return { entries: await getPersistedPythonLog() };
      case "PYTHON_CLEAR_LOG":
        await clearPersistedPythonLog();
        return { ok: true };
      case "SANDBOX_EXECUTE": {
        // Validate the incoming runtime message at the boundary
        // rather than re-shaping it from untyped fields. Malformed or
        // empty payloads (e.g. a third-party message reusing this
        // type) should be rejected here so `executeInSandboxLocal`
        // never receives untrusted input.
        const candidate = {
          target: "offscreen",
          type: "SANDBOX_EXECUTE",
          code: message.code,
          input: message.input,
          options: message.options,
        };
        if (!isSandboxExecutePayload(candidate)) {
          return { error: "Invalid SANDBOX_EXECUTE payload" };
        }
        return handleSandboxExecute(candidate);
      }
      default:
        return { error: "Unknown message type" };
    }
  };

  handle()
    .then((result) => {
      console.log("[OpenBrowse offscreen] Response for", message.type);
      sendResponse(result);
    })
    .catch((err) => {
      console.error(
        "[OpenBrowse offscreen] Error handling",
        message.type,
        ":",
        err,
      );
      sendResponse({ error: String(err) });
    });

  return true;
});

console.log("[OpenBrowse offscreen] Loaded and listening");
