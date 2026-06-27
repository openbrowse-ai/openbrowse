import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArtifactPermissions } from "./ArtifactPermissions";
import type { ArtifactManifest } from "@/lib/artifacts/manifest";

interface Props {
  open: boolean;
  manifest: ArtifactManifest;
  onApprove: () => void;
  onCancel: () => void;
}

/**
 * One-time consent prompt shown the first time an artifact attempts a write
 * tool. Approving grants every declared write (and network host) for the life
 * of the artifact; cancelling rejects the in-flight call.
 */
export function WriteApprovalDialog({ open, manifest, onApprove, onCancel }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Allow “{manifest.title}” to make changes?</DialogTitle>
          <DialogDescription>
            This artifact wants to perform an action that modifies your data.
            Approve once to let it use the capabilities below.
          </DialogDescription>
        </DialogHeader>

        <ArtifactPermissions manifest={manifest} />

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={onApprove}>Allow</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
