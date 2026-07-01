import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import { providers as registryProviders } from "@/registry/providers";

const labeledGroups = new Set<number>();
const inFlight = new Set<number>();

export async function maybeGenerateGroupLabel(
  conversationId: string,
  groupId: number,
): Promise<void> {
  if (labeledGroups.has(groupId) || inFlight.has(groupId)) return;
  inFlight.add(groupId);

  try {
    const conv = await chatDb.getConversation(conversationId);
    if (!conv) {
      console.warn("[group-label] conversation not found", conversationId);
      return;
    }

    const tabs = await chrome.tabs.query({ groupId });
    const tabContext = tabs
      .filter((t) => !!t.url && !t.url.startsWith("chrome://"))
      .map((t) => ({ title: t.title ?? "", url: t.url ?? "" }));
    // Don't gate on tabContext.length — fresh tabs may have empty url at
    // query time. The chat title and user message are sufficient context
    // for the LLM to produce a sensible label.

    const messages = await chatDb.getMessages(conversationId);
    const firstUser = messages.find((m) => m.role === "user");
    const userMessage =
      firstUser?.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ")
        .trim() ?? "";

    const settings = await storage.getSettings();
    const agentSettings = await storage.getAgentSettings();
    const provider = registryProviders.find((p) =>
      p.models.some((m) => m.id === agentSettings.agentModel),
    );
    if (!provider) {
      console.warn(
        "[group-label] no provider for agent model",
        agentSettings.agentModel,
      );
      return;
    }

    const { ensureOffscreenDocument } = await import("./messages");
    await ensureOffscreenDocument();
    const { sendToOffscreen } = await import("@/lib/messages");
    const result = (await sendToOffscreen({
      type: "GENERATE_GROUP_LABEL",
      providerId: provider.id,
      config: settings.providerConfigs[provider.id] ?? {},
      modelId: agentSettings.agentModel,
      context: {
        chatTitle: conv.title,
        userMessage,
        tabs: tabContext,
      },
    })) as { title?: string; color?: string; error?: string };

    if (result?.error) {
      console.warn("[group-label] offscreen error:", result.error);
      return;
    }
    if (!result?.title) {
      console.warn("[group-label] empty title from offscreen", result);
      return;
    }

    // Prefix the LLM-generated label via `buildGroupTitle` so MCP /
    // subagent / user prefixes stay consistent with the placeholder.
    // MCP rows get a narrower body budget (14 vs 19) to leave room
    // for the "MCP · " tag.
    const { buildGroupTitle } = await import("./group-title");
    const isMcp = conv.source === "mcp";
    const prefixedTitle = buildGroupTitle({
      source: isMcp ? "mcp" : "user",
      // For MCP rows pass the LLM body as the title — `buildGroupTitle`
      // prepends "MCP · " for us. For non-MCP rows pass the LLM body as
      // the title.
      title: result.title.trim(),
      labelLength: isMcp ? 14 : 19,
    });

    try {
      await chrome.tabGroups.update(groupId, {
        title: prefixedTitle,
        color: (result.color as chrome.tabGroups.Color) ?? "grey",
      });
      labeledGroups.add(groupId);
    } catch (err) {
      console.warn("[group-label] tabGroups.update failed:", err);
      // Group may have been dissolved mid-flight; placeholder remains.
    }
  } catch (err) {
    console.warn("[group-label] unexpected error:", err);
  } finally {
    inFlight.delete(groupId);
  }
}
