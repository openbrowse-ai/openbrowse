import { ZoomableImage } from "@/components/ui/zoomable-image";

interface Props {
  result: unknown;
}

export function ScreenshotResult({ result }: Props) {
  const obj = result as { imageDataUrl?: string; data?: string } | undefined;
  const url = obj?.imageDataUrl ?? obj?.data;
  if (!url) return null;

  return (
    <div className="ml-3 mt-1 pl-3 pb-1">
      <ZoomableImage
        src={url}
        alt="Screenshot"
        className="max-w-full h-auto max-h-[400px] rounded border border-border object-contain"
      />
    </div>
  );
}
