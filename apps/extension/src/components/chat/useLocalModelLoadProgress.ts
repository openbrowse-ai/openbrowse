import { useEffect, useState } from "react";

export interface LocalModelLoadProgress {
  modelId: string;
  /** 0..1 */
  progress: number;
  text: string;
}

/**
 * Listens for `LOCAL_MODEL_LOAD_PROGRESS` broadcasts emitted by the offscreen
 * document while a local (WebLLM) model's engine loads on the first turn of an
 * agent run.
 *
 * A cold local load (WASM instantiate + WebGPU shader compilation) can take
 * several seconds with zero token output, which reads as a frozen UI. Surfacing
 * this turns the dead time into visible progress. Returns the latest progress,
 * or `null` when idle or once the load completes (progress >= 1), at which point
 * the normal generating indicator takes over.
 */
export function useLocalModelLoadProgress(): LocalModelLoadProgress | null {
  const [progress, setProgress] = useState<LocalModelLoadProgress | null>(null);

  useEffect(() => {
    const listener = (msg: unknown) => {
      const m = msg as {
        type?: string;
        modelId?: string;
        progress?: number;
        text?: string;
      };
      if (m?.type !== "LOCAL_MODEL_LOAD_PROGRESS") return;
      const p = typeof m.progress === "number" ? m.progress : 0;
      if (p >= 1) {
        setProgress(null);
        return;
      }
      setProgress({ modelId: m.modelId ?? "", progress: p, text: m.text ?? "" });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return progress;
}
