import type { SettingsUpdate } from "@vibevalley/protocol";

import { api } from "./api";
import { settingsQuery, useQueryClient } from "./query";

/** Saves, and the settings the server answers with are the cached ones from then on. */
export function useSaveSettings() {
  const client = useQueryClient();
  return async (update: SettingsUpdate) => {
    const saved = await api.setting.update(update);
    client.setData(settingsQuery(), () => ({ value: saved }));
    return saved;
  };
}
