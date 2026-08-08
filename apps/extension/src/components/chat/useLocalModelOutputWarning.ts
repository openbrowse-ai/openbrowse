import { useCallback, useEffect, useState } from "react";

export interface LocalModelOutputWarning {
  modelId: string;
  /** Signals that tripped the coherence check (e.g. "3 replacement characters"). */
  reasons: string[];
}

/**
 * Listens for `LOCAL_MODEL_OUTPUT_GARBLED` broadcasts from the offscreen
 * document, emitted when a finished WebLLM reply scores as corrupted.
 *
 * Some WebLLM builds load and report success but emit token salad on specific
 * GPUs/drivers — a known quantization + WebGPU issue, not a bug in the
 * extension. Without a signal, the user just sees nonsense and reasonably
 * concludes the app is broken. Surfacing it names the cause and the fix
 * (try another quantization or model).
 *
 * Stays visible until dismissed, since the offending reply remains on screen. A
 * newer warning replaces an older one.
 */
export function useLocalModelOutputWarning(): {
  warning: LocalModelOutputWarning | null;
  dismiss: () => void;
} {
  const [warning, setWarning] = useState<LocalModelOutputWarning | null>(null);

  useEffect(() => {
    const listener = (msg: unknown) => {
      const m = msg as {
        type?: string;
        modelId?: string;
        reasons?: unknown;
      };
      if (m?.type !== "LOCAL_MODEL_OUTPUT_GARBLED") return;
      setWarning({
        modelId: m.modelId ?? "",
        reasons: Array.isArray(m.reasons) ? (m.reasons as string[]) : [],
      });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const dismiss = useCallback(() => setWarning(null), []);
  return { warning, dismiss };
}
