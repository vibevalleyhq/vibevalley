// The command line speaks the farm's language: the locale saved in the home's settings.json. Imported first in cli.ts,
// since the other modules build their help text as they load.

import { setLocale } from "@vibevalley/protocol/words";
import { loadConfig } from "../base/config.ts";
import { savedLocale } from "../setting/setting.ts";

try {
  setLocale(savedLocale(loadConfig().home));
} catch {
  // A configuration that cannot be read fails the command that needs it, in the default language.
}
