import { ProgressCard, WorkingFolderCard, ContextCard } from "@/components/cowork";

interface CoworkPanelProps {
  conversationId: string;
  /**
   * Click handler for a working-folder file row. Called with the file path
   * RELATIVE to the workspace root (e.g. `subdir/data.csv`). Pass `null` to
   * deselect (currently only used by the parent on Esc / file panel close).
   */
  onSelectFile: (file: string | null) => void;
}

export function CoworkPanel({ conversationId, onSelectFile }: CoworkPanelProps) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <ProgressCard conversationId={conversationId} />
      <WorkingFolderCard conversationId={conversationId} onSelectFile={onSelectFile} />
      <ContextCard conversationId={conversationId} onSelectFile={onSelectFile} />
    </div>
  );
}
