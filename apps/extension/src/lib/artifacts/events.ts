/**
 * Lightweight pub/sub for changes to the saved-artifact registry.
 *
 * The right-rail Artifacts card (and any other surface listing artifacts)
 * subscribes to `artifacts:changed` so it can re-read the registry when an
 * artifact is created, updated, renamed, (un)favorited, installed, or
 * deleted. We emit a dedicated event rather than reusing `vfs:change`
 * because consumers want a single coarse "the artifact set changed" signal
 * without having to pattern-match raw OPFS paths.
 *
 * `detail.id` is the affected artifact id when known (best-effort; consumers
 * should re-query rather than rely on it for correctness).
 */
export const artifactsEvents = new EventTarget();

export interface ArtifactsChangedDetail {
  id?: string;
}

export function emitArtifactsChanged(id?: string): void {
  artifactsEvents.dispatchEvent(
    new CustomEvent("artifacts:changed", { detail: { id } }),
  );
}

export interface ArtifactCreatedDetail {
  id: string;
  title: string;
}

/**
 * Fired once when an artifact is first created via the `create_artifact` tool
 * (NOT on later updates/renames). Surfaces let the UI auto-open the new
 * artifact in the in-panel viewer so it actually runs — which is also what
 * makes the agent's `read_artifact_diagnostics` get a live signal. Same
 * in-context caveat as `artifactsEvents` (an in-memory EventTarget only
 * reaches listeners in the same JS context, e.g. the home page where the
 * agent runs in-page).
 *
 * KNOWN LIMITATION (I2): this rests on an unenforced "agent and viewer share a
 * JS context" invariant. If the agent ever runs in the background/offscreen
 * context (e.g. a scheduled run via ScheduledRunHost), this event reaches no
 * listener, nothing mounts the artifact, and `read_artifact_diagnostics` will
 * report rendered:null. If create_artifact starts running off the home page,
 * route this through a cross-context channel (e.g. chrome.storage.local, as the
 * fix-request flow does) instead of an in-memory EventTarget.
 */
export function emitArtifactCreated(id: string, title: string): void {
  artifactsEvents.dispatchEvent(
    new CustomEvent("artifacts:created", { detail: { id, title } }),
  );
}
