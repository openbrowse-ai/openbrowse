import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, KeyObject, createPrivateKey, createPublicKey } from "node:crypto";

export interface BrokerKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicKeyPemSpki: string;       // PEM SPKI of public key
  privateKeyPemPkcs8: string;     // PEM PKCS8 of private key
  fingerprint: string;            // first 16 hex chars of sha256(public-DER)
}

const KEY_DIR = () => join(process.env.HOME ?? homedir(), ".openbrowse");
const KEY_FILE = () => join(KEY_DIR(), "broker-key.json");

interface PersistedKey {
  algorithm: "Ed25519";
  publicKeyPemSpki: string;
  privateKeyPemPkcs8: string;
  fingerprint: string;
  createdAt: number;
}

export async function loadOrCreateKeyPair(): Promise<BrokerKeyPair> {
  if (existsSync(KEY_FILE())) {
    const json = JSON.parse(readFileSync(KEY_FILE(), "utf8")) as PersistedKey;
    const privateKey = createPrivateKey({ key: json.privateKeyPemPkcs8, format: "pem" });
    const publicKey = createPublicKey({ key: json.publicKeyPemSpki, format: "pem" });
    return {
      publicKey,
      privateKey,
      publicKeyPemSpki: json.publicKeyPemSpki,
      privateKeyPemPkcs8: json.privateKeyPemPkcs8,
      fingerprint: json.fingerprint,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPemSpki = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPemPkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const fingerprint = createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);

  mkdirSync(KEY_DIR(), { recursive: true, mode: 0o700 });
  const persisted: PersistedKey = {
    algorithm: "Ed25519",
    publicKeyPemSpki,
    privateKeyPemPkcs8,
    fingerprint,
    createdAt: Date.now(),
  };
  writeFileSync(KEY_FILE(), JSON.stringify(persisted, null, 2), { mode: 0o600 });
  chmodSync(KEY_FILE(), 0o600);

  return { publicKey, privateKey, publicKeyPemSpki, privateKeyPemPkcs8, fingerprint };
}

/**
 * Rotate the broker's signing keypair.
 *
 * Backs the current key up to `broker-key.previous.json` (mode 0600), deletes
 * the active key file, and calls `loadOrCreateKeyPair` again to generate a
 * fresh Ed25519 pair. Returns the new keypair so callers can display its
 * fingerprint.
 *
 * No module-scope caching is involved — `loadOrCreateKeyPair` reads from disk
 * on every call — so the next caller of `loadOrCreateKeyPair` (typically the
 * broker on next startup) will pick up the new key transparently.
 *
 * The caller is responsible for ensuring the broker process is NOT running
 * when this is called; otherwise the running broker keeps its in-memory key
 * and rotation appears partially applied. The `--rotate-keys` CLI enforces
 * this via the broker lock file.
 */
export async function rotateKeyPair(): Promise<BrokerKeyPair> {
  const path = KEY_FILE();
  if (existsSync(path)) {
    const backup = path.replace(/\.json$/, ".previous.json");
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
    unlinkSync(path);
  }
  return loadOrCreateKeyPair();
}
