import { OPFS } from "@/lib/vfs/opfs";
import type { ArtifactManifest, ArtifactSidecar } from "./manifest";
import { canonicalizeManifest, manifestVersion, validateManifest } from "./validate";
import { emitArtifactsChanged } from "./events";
import { clearDiagnostics } from "./diagnostics";

const ROOT = "artifacts";

export interface SavedArtifact {
  manifest: ArtifactManifest;
  sidecar: ArtifactSidecar;
  html: string;
}

export interface SaveOptions {
  manifest: ArtifactManifest;
  html: string;
  sourceConversationId: string | null;
}

const META_TAG_RE = /<meta\s+name=["']openbrowse:artifact["'][^>]*>/gi;
const HEAD_INSERT_RE = /(<head[^>]*>)/i;

function htmlPath(id: string) { return `${ROOT}/${id}.html`; }
function metaPath(id: string) { return `${ROOT}/${id}.meta.json`; }
function dirPath(id: string)  { return `${ROOT}/${id}`; }

function inlineManifestMeta(html: string, manifest: ArtifactManifest): string {
  const cleaned = html.replace(META_TAG_RE, "");
  const tag = `<meta name="openbrowse:artifact" content='${
    JSON.stringify(manifest)
      .replace(/'/g, "&#39;")
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
  }'>`;
  if (HEAD_INSERT_RE.test(cleaned)) return cleaned.replace(HEAD_INSERT_RE, `$1${tag}`);
  // No <head>: insert before first tag, after doctype if present.
  return cleaned.replace(/^(<!doctype[^>]*>\s*)?/i, (m) => `${m ?? ""}${tag}`);
}

export function extractManifest(html: string): ArtifactManifest | null {
  const tag = html.match(META_TAG_RE)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=(['"])([\s\S]*?)\1/)?.[2];
  if (!content) return null;
  try {
    const decoded = content.replace(/&#39;/g, "'");
    const parsed = JSON.parse(decoded);
    const r = validateManifest(parsed);
    return r.ok ? (parsed as ArtifactManifest) : null;
  } catch {
    return null;
  }
}

export async function saveArtifact(opts: SaveOptions): Promise<SavedArtifact> {
  const { manifest, html, sourceConversationId } = opts;
  const r = validateManifest(manifest);
  if (!r.ok) throw new Error(`invalid manifest: ${r.errors.join("; ")}`);

  const inlined = inlineManifestMeta(html, manifest);
  const now = new Date().toISOString();
  const version = await manifestVersion(canonicalizeManifest(manifest));

  let sidecar: ArtifactSidecar;
  const existing = await OPFS.exists(metaPath(manifest.id));
  if (existing) {
    const prior = JSON.parse(await OPFS.readFile(metaPath(manifest.id))) as ArtifactSidecar;
    const versionChanged = prior.manifestVersion !== version;
    sidecar = {
      ...prior,
      updatedAt: now,
      manifestVersion: version,
      // If the security surface changed, reset approvals.
      approvedWrites: versionChanged ? [] : prior.approvedWrites,
      approvedNetwork: versionChanged ? [] : prior.approvedNetwork,
      installedAt: versionChanged ? undefined : prior.installedAt,
      sourceConversationId: sourceConversationId ?? prior.sourceConversationId,
    };
  } else {
    sidecar = {
      id: manifest.id,
      createdAt: now,
      updatedAt: now,
      sourceConversationId: sourceConversationId ?? undefined,
      approvedWrites: [],
      approvedNetwork: [],
      manifestVersion: version,
    };
  }

  await OPFS.writeFileAtomic(htmlPath(manifest.id), inlined);
  await OPFS.writeFileAtomic(metaPath(manifest.id), JSON.stringify(sidecar, null, 2));
  emitArtifactsChanged(manifest.id);
  return { manifest, sidecar, html: inlined };
}

export async function loadArtifact(id: string): Promise<SavedArtifact | null> {
  if (!(await OPFS.exists(htmlPath(id)))) return null;
  const html = await OPFS.readFile(htmlPath(id));
  const manifest = extractManifest(html);
  if (!manifest) return null;
  if (!(await OPFS.exists(metaPath(id)))) return null;
  const sidecar = JSON.parse(await OPFS.readFile(metaPath(id))) as ArtifactSidecar;
  return { manifest, sidecar, html };
}

export async function listArtifacts(): Promise<SavedArtifact[]> {
  if (!(await OPFS.exists(ROOT))) return [];
  const entries = await OPFS.readDir(ROOT);
  const ids = entries
    .filter((n) => n.endsWith(".html"))
    .map((n) => n.slice(0, -".html".length));
  const out: SavedArtifact[] = [];
  for (const id of ids) {
    const a = await loadArtifact(id);
    if (a) out.push(a);
  }
  return out;
}

export async function deleteArtifact(id: string): Promise<void> {
  for (const p of [htmlPath(id), metaPath(id)]) {
    if (await OPFS.exists(p)) await OPFS.rm(p);
  }
  if (await OPFS.exists(dirPath(id))) await OPFS.rm(dirPath(id), { recursive: true });
  await clearDiagnostics(id);
  emitArtifactsChanged(id);
}

export async function recordOpened(id: string): Promise<void> {
  if (!(await OPFS.exists(metaPath(id)))) return;
  const s = JSON.parse(await OPFS.readFile(metaPath(id))) as ArtifactSidecar;
  s.lastOpenedAt = new Date().toISOString();
  await OPFS.writeFileAtomic(metaPath(id), JSON.stringify(s, null, 2));
}

export async function recordInstalled(id: string, opts: {
  approvedWrites: string[];
  approvedNetwork: string[];
}): Promise<void> {
  if (!(await OPFS.exists(metaPath(id)))) throw new Error(`no sidecar for ${id}`);
  const s = JSON.parse(await OPFS.readFile(metaPath(id))) as ArtifactSidecar;
  s.installedAt = new Date().toISOString();
  s.approvedWrites = opts.approvedWrites;
  s.approvedNetwork = opts.approvedNetwork;
  await OPFS.writeFileAtomic(metaPath(id), JSON.stringify(s, null, 2));
  emitArtifactsChanged(id);
}

export async function renameArtifact(id: string, title: string): Promise<SavedArtifact> {
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new Error("title must be 1-80 chars");
  const a = await loadArtifact(id);
  if (!a) throw new Error(`no artifact ${id}`);
  a.manifest.title = trimmed;
  return saveArtifact({
    manifest: a.manifest,
    html: a.html,
    sourceConversationId: a.sidecar.sourceConversationId ?? null,
  });
}

/**
 * Update the artifact's emoji icon, persisting it on the manifest. Goes
 * through `saveArtifact` (not a direct sidecar edit) because the icon lives
 * on the manifest meta tag inside the HTML. The icon is not part of the
 * security surface, so this never resets approvals (manifestVersion only
 * hashes v/id/tools/cdns/network).
 */
export async function setArtifactIcon(id: string, icon: string): Promise<SavedArtifact> {
  const trimmed = icon.trim();
  if (trimmed.length < 1 || trimmed.length > 32) throw new Error("icon must be 1-32 chars");
  const a = await loadArtifact(id);
  if (!a) throw new Error(`no artifact ${id}`);
  a.manifest.icon = trimmed;
  return saveArtifact({
    manifest: a.manifest,
    html: a.html,
    sourceConversationId: a.sidecar.sourceConversationId ?? null,
  });
}

export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  const meta = metaPath(id);
  if (!(await OPFS.exists(meta))) return;
  const s = JSON.parse(await OPFS.readFile(meta)) as ArtifactSidecar;
  s.favorite = favorite;
  await OPFS.writeFileAtomic(meta, JSON.stringify(s, null, 2));
  emitArtifactsChanged(id);
}
