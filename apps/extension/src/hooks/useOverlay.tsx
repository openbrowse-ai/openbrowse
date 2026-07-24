import { useCallback, useEffect, useRef, useState } from "react";

export function useOverlay() {
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayAction, setOverlayAction] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // This context's own window id, so TOGGLE_HOME_OVERLAY aimed at another
  // window is ignored (see HomeApp for the same guard).
  const ownWindowIdRef = useRef<number | null>(null);
  useEffect(() => {
    chrome.windows
      .getCurrent()
      .then((w) => {
        ownWindowIdRef.current = w.id ?? null;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const listener = (message: {
      type: string;
      action?: string;
      windowId?: number;
    }) => {
      if (message.type === "TOGGLE_HOME_OVERLAY") {
        if (
          message.windowId != null &&
          ownWindowIdRef.current != null &&
          message.windowId !== ownWindowIdRef.current
        ) {
          return;
        }
        if (message.action) {
          setOverlayAction(message.action);
          setShowOverlay(true);
        } else {
          setShowOverlay((prev) => !prev);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "k" && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        setShowOverlay((prev) => !prev);
      }
      if (e.key === "Escape" && showOverlay) {
        setShowOverlay(false);
      }
    };
    document.addEventListener("keydown", handleKeydown);

    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "OPENBROWSE_OVERLAY_CLOSE") {
        setShowOverlay(false);
        setOverlayAction(null);
      }
      if (
        e.data?.type === "OPENBROWSE_OVERLAY_RESIZE" &&
        typeof e.data.height === "number" &&
        iframeRef.current
      ) {
        iframeRef.current.style.height = `${e.data.height}px`;
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("message", handleMessage);
    };
  }, [showOverlay]);

  const openOverlay = useCallback((action?: string) => {
    if (action) setOverlayAction(action);
    setShowOverlay(true);
  }, []);

  const overlayUrl = chrome.runtime.getURL(
    `/overlay.html${overlayAction ? `?action=${overlayAction}` : ""}`
  );

  const OverlayPortal = showOverlay ? (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[20vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShowOverlay(false);
      }}
    >
      <iframe
        ref={iframeRef}
        src={overlayUrl}
        className="w-[580px] max-w-[90vw] max-h-[70vh] border-none rounded-lg"
        onLoad={(e) => (e.currentTarget as HTMLIFrameElement).focus()}
      />
    </div>
  ) : null;

  return { showOverlay, openOverlay, OverlayPortal };
}
