import { useState, useEffect } from "react";
import { getSkillsRegistry } from "@/lib/skills/registry";
import type { SkillsRegistryState } from "@/entrypoints/background/skill-registry";

export function useSkillsState(): SkillsRegistryState {
  const registry = getSkillsRegistry();
  const [state, setState] = useState<SkillsRegistryState>(registry.getState());

  useEffect(() => {
    registry.init();
    
    const unsubscribe = registry.subscribe(() => {
      setState(registry.getState());
    });
    
    return unsubscribe;
  }, []);

  return state;
}
