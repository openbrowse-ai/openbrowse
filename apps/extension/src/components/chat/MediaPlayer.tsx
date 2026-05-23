import { cn } from "@/lib/utils";

interface MediaPlayerProps {
  blobUrl: string;
  fileName: string;
  kind: "audio" | "video";
  className?: string;
}

/**
 * Plays audio or video from a `blob:` URL using the native HTML5 controls.
 * No fancy waveforms, no auto-play. Sized to fit the viewer modal.
 */
export function MediaPlayer({ blobUrl, fileName, kind, className }: MediaPlayerProps) {
  if (kind === "audio") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 p-10 bg-muted/20 min-h-full",
          className,
        )}
      >
        <span className="text-xs text-muted-foreground font-mono truncate max-w-full">
          {fileName}
        </span>
        <audio controls preload="metadata" src={blobUrl} className="w-full max-w-md">
          Your browser does not support the audio element.
        </audio>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center justify-center p-4 bg-black min-h-full",
        className,
      )}
    >
      <video
        controls
        preload="metadata"
        src={blobUrl}
        className="max-w-full max-h-[70vh]"
      >
        Your browser does not support the video element.
      </video>
    </div>
  );
}
