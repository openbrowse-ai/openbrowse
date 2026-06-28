import type { SkillsRegistryState } from "@/entrypoints/background/skill-registry";
import { isServiceWorkerContext } from "@/lib/runtime/context";
import { sendSkillMessage } from "./messages";

class SkillsRegistry {
  private state: SkillsRegistryState = { skills: [], spaceConfigs: [] };
  private listeners: Set<() => void> = new Set();
  private initialized = false;
  // Lazily resolved when running in the SW realm. Holds a direct reference
  // to `backgroundSkillRegistry` so `getState()` reads the freshest state
  // without going through `sendSkillMessage` every call.
  private bgRegistry:
    | { getStates: () => SkillsRegistryState }
    | null = null;

  constructor() {
    // The renderer-side cache is updated reactively via SKILL_STATE_CHANGED
    // broadcasts from the SW. In the SW realm `chrome.runtime.sendMessage`
    // does NOT echo to the sender, so a listener here would never fire —
    // we read straight from `backgroundSkillRegistry` instead (see
    // `getState`/`init` below).
    if (!isServiceWorkerContext()) {
      try {
        chrome.runtime.onMessage.addListener((message) => {
          if (message.type === "SKILL_STATE_CHANGED") {
            this.state = message.state;
            this.notifyListeners();
          }
        });
      } catch {
        // Test / non-extension context with no chrome.runtime; ignore.
      }
    }
  }

  async init() {
    if (this.initialized) return;
    if (isServiceWorkerContext()) {
      // SW realm: bypass sendSkillMessage entirely. Direct import + call.
      const { backgroundSkillRegistry } = await import(
        "@/entrypoints/background/skill-registry"
      );
      await backgroundSkillRegistry.init();
      this.bgRegistry = backgroundSkillRegistry;
      this.state = backgroundSkillRegistry.getStates();
      this.initialized = true;
      this.notifyListeners();
      return;
    }
    const res = await sendSkillMessage({ type: "SKILL_INIT" });
    if (res.success) {
      this.state = res.state;
      this.initialized = true;
      this.notifyListeners();
    }
  }

  getState(): SkillsRegistryState {
    // In the SW realm, return the live `backgroundSkillRegistry` state
    // every read so we don't serve stale cached data after a skill
    // mutation. Renderer keeps the snapshot updated via broadcasts.
    if (this.bgRegistry) {
      return this.bgRegistry.getStates();
    }
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Re-read the SW-side state into the wrapper cache and notify
   * subscribers. Called after every SW-realm mutation so React hooks
   * subscribed via `subscribe()` re-render. The renderer realm receives
   * the same notifications via the `SKILL_STATE_CHANGED` broadcast in
   * the constructor; SW callers do not receive that echo, so we must
   * synthesise the notification here.
   *
   * No-op in the renderer realm (no `bgRegistry`).
   */
  private refreshFromBgRegistry(): void {
    if (!this.bgRegistry) return;
    this.state = this.bgRegistry.getStates();
    this.notifyListeners();
  }

  async install(source: string, githubToken?: string, specificSkill?: string) {
    const res = await sendSkillMessage({
      type: "SKILL_INSTALL",
      source,
      githubToken,
      specificSkill,
    });
    this.refreshFromBgRegistry();
    return res;
  }

  async uninstall(name: string) {
    const res = await sendSkillMessage({ type: "SKILL_UNINSTALL", name });
    this.refreshFromBgRegistry();
    return res;
  }

  async setSpaceState(
    spaceId: string,
    skillName: string,
    state: "allow" | "deny",
  ) {
    const res = await sendSkillMessage({
      type: "SKILL_SET_SPACE_STATE",
      spaceId,
      skillName,
      state,
    });
    this.refreshFromBgRegistry();
    return res;
  }

  async setEnabled(name: string, enabled: boolean) {
    const res = await sendSkillMessage({ type: "SKILL_SET_ENABLED", name, enabled });
    this.refreshFromBgRegistry();
    return res;
  }
}

let registryInstance: SkillsRegistry | null = null;

export function getSkillsRegistry(): SkillsRegistry {
  if (!registryInstance) {
    registryInstance = new SkillsRegistry();
  }
  return registryInstance;
}

// Eagerly initialize the registry so state is loaded before the user types `/`
getSkillsRegistry().init().catch(console.error);
