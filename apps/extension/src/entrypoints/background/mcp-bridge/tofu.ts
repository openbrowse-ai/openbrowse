const STORAGE_KEY = "mcp_bridge_trust";

export interface TrustRecord {
  fingerprint: string;
  trustedAt: number;
  processInfo: { pid: number; executablePath: string; startedAt: number };
  /**
   * SHA-256 of the broker binary recorded at TOFU time. Optional because
   * older brokers / unreadable execPath both omit this field. When present,
   * a later reconnect with a different `binarySha256` triggers an advisory
   * warning (see `onBinaryDrift` in `index.ts`) — never a hard block.
   */
  binarySha256?: string;
}

export async function getTrustedFingerprint(): Promise<string | null> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const record = obj[STORAGE_KEY] as TrustRecord | undefined;
  return record?.fingerprint ?? null;
}

export async function trustBroker(
  input: {
    fingerprint: string;
    processInfo: TrustRecord["processInfo"];
    binarySha256?: string;
  },
): Promise<void> {
  const record: TrustRecord = {
    fingerprint: input.fingerprint,
    trustedAt: Date.now(),
    processInfo: input.processInfo,
    ...(input.binarySha256 !== undefined ? { binarySha256: input.binarySha256 } : {}),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
}

export async function isTrustedBroker(fingerprint: string): Promise<boolean> {
  const trusted = await getTrustedFingerprint();
  return trusted === fingerprint;
}

export async function clearTrust(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function getTrustRecord(): Promise<TrustRecord | null> {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  return (obj[STORAGE_KEY] as TrustRecord | undefined) ?? null;
}
