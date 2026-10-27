import type { SettingsUpdate } from "@vibevalley/protocol";
import { api } from "./api";
import { queries } from "./query";

/** Saves, and the settings the server answers with are the cached ones from then on. */
export async function saveSettings(update: SettingsUpdate) {
  const saved = await api.setting.save({ body: update });
  queries.setQueryData(["settings"], saved);
  return saved;
}
