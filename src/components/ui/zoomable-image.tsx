import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import { cn } from "@/lib/utils";

interface ZoomableImageProps {
  src: string;
  alt?: string;
  className?: string;
}

export function ZoomableImage({ src, alt, className }: ZoomableImageProps) {
  return (
    <Zoom zoomMargin={20}>
      <img
        src={src}
        alt={alt ?? "Image"}
        className={cn("cursor-zoom-in rounded-md", className)}
      />
    </Zoom>
  );
}
