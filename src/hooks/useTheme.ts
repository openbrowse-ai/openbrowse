import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import type { ThemeMode } from "@/lib/types";
import { STORAGE_KEYS } from "@/lib/constants";

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    storage.getSettings().then((s) => setThemeMode(s.themeMode));
  }, []);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes[STORAGE_KEYS.SETTINGS]) {
        const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue as
          | Partial<{ themeMode: ThemeMode }>
          | undefined;
        if (newSettings?.themeMode) {
          setThemeMode(newSettings.themeMode);
        }
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");

    function apply() {
      const dark =
        themeMode === "dark" || (themeMode === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      setIsDark(dark);
      chrome.storage.local.set({ "theme-is-dark": dark });
      const favicon = document.getElementById("favicon") as HTMLLinkElement | null;
      if (favicon) {
        favicon.href = dark ? "/icon/32-dark.png" : "/icon/32.png";
      }
    }

    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode]);

  return { themeMode, isDark };
}
