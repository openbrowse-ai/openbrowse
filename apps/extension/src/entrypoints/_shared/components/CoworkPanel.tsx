import { ProgressCard, WorkingFolderCard, ArtifactsCard, ContextCard } from "@/components/cowork";

interface CoworkPanelProps {
  conversationId: string;
  /**
   * Active space id, threaded down so the Working Folder card can offer a
   * per-row "Save to space" action. `null` disables that affordance.
   */
  spaceId: string | null;
  /**
   * Click handler for a working-folder file row OR an Uploads row in the
   * Context card. Called with the file path RELATIVE to the conversation
   * workspace root (e.g. `subdir/data.csv`, `.uploads/foo.png`). Pass
   * `null` to deselect.
   */
  onSelectFile: (file: string | null) => void;
  /**
   * Click handler for a Space files row in the Context card. Called with
   * the file path RELATIVE to the active space's workspace root (e.g.
   * `poem.md`). When omitted, Space file rows render as non-clickable.
   */
  onSelectSpaceFile?: (file: string | null) => void;
  /**
   * Click handler for an Artifacts card row. Opens the artifact in the rail's
   * in-panel viewer. When omitted, artifact rows open in a separate tab.
   */
  onSelectArtifact?: (artifact: { id: string; title: string } | null) => void;
}

export function CoworkPanel({
  conversationId,
  spaceId,
  onSelectFile,
  onSelectSpaceFile,
  onSelectArtifact,
}: CoworkPanelProps) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <ProgressCard conversationId={conversationId} />
      <WorkingFolderCard
        conversationId={conversationId}
        spaceId={spaceId}
        onSelectFile={onSelectFile}
      />
      <ArtifactsCard
        conversationId={conversationId}
        onSelectArtifact={onSelectArtifact}
      />
      <ContextCard
        conversationId={conversationId}
        onSelectFile={onSelectFile}
        onSelectSpaceFile={onSelectSpaceFile}
      />
    </div>
  );
}
