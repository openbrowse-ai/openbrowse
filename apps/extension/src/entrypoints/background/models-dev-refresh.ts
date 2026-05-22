/**
 * Background refresh of the models.dev catalog.
 *
 * Runs once at extension startup (opportunistic) and every 60 minutes
 * via chrome.alarms. The fetcher itself enforces a 5-minute freshness
 * gate, so the alarm cadence is conservatively bounded above the
 * minimum useful interval.
 *
 * UI consumers (useProviders) listen for chrome.storage changes on
 * the catalog key, so a successful refresh re-renders model pickers
 * and settings without any further wiring.
 */

import { refreshCatalog } from "@/registry/models-dev/catalog";

const ALARM_NAME = "models-dev-refresh";
const PERIOD_MINUTES = 60;

export function registerModelsDevRefresh(): void {
  // Schedule recurring refresh. Service workers are torn down between
  // alarms, so we don't need to track the timer ourselves.
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void refreshCatalog().catch((err) => {
      console.warn("[bg] models.dev alarm refresh failed", err);
    });
  });

  // Opportunistic refresh on this script's startup. The fetcher's
  // freshness gate skips the network if storage is recent, so
  // multiple SW wake-ups in a short window don't hammer models.dev.
  void refreshCatalog().catch((err) => {
    console.warn("[bg] models.dev startup refresh failed", err);
  });
}
