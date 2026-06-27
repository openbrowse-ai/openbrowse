/**
 * Pure parser for the sidepanel's launch query string. Extracted from
 * `App.tsx`'s `readPopupParams` so the param-parsing logic is unit-testable
 * without a DOM. `App.tsx` calls this with `window.location.search`.
 */
export interface PopupParams {
  isPopupMode: boolean;
  isGlobalChat: boolean;
  originWindowId: number | null;
  originTabId: number | null;
  originUrl: string | null;
  initialConversationId: string | null;
  /**
   * Artifact id the user asked to edit (from the artifact tab's "Make edits"
   * pencil). When present, the sidepanel spins up a fresh conversation tagged
   * with this artifact. `null` when absent or empty.
   */
  editArtifactId: string | null;
  /**
   * Optional message to pre-seed the composer with (from the artifact's "Fix
   * with OpenBrowse" banner). `null` when absent or empty.
   */
  seedPrompt: string | null;
  /** When true, the seeded prompt is submitted automatically. */
  autoSubmit: boolean;
}

export function parsePopupParams(search: string): PopupParams {
  const params = new URLSearchParams(search);
  const isPopupMode = params.get("mode") === "popup";
  const isGlobalChat = params.get("globalChat") === "true";
  const owid = params.get("originWindowId");
  const otid = params.get("originTabId");
  const ourl = params.get("originUrl");
  const cid = params.get("conversationId");
  const eaid = params.get("editArtifactId");
  const prompt = params.get("prompt");
  return {
    isPopupMode,
    isGlobalChat,
    originWindowId: owid ? Number(owid) : null,
    originTabId: otid ? Number(otid) : null,
    originUrl: ourl && ourl.length > 0 ? ourl : null,
    initialConversationId: cid && cid.length > 0 ? cid : null,
    editArtifactId: eaid && eaid.length > 0 ? eaid : null,
    seedPrompt: prompt && prompt.length > 0 ? prompt : null,
    autoSubmit: params.get("autoSubmit") === "1",
  };
}
