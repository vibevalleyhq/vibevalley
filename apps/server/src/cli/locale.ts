// The command line speaks the farm's language: the locale saved in the home's settings.json. Imported first in cli.ts,
// since the other modules build their help text as they load; the home is found as the configuration finds it
// (VIBEVALLEY_HOME, else the default's).

import { setLocale } from "@vibevalley/i18n";
import { defaults } from "../base/config.ts";
import { savedLocale } from "../setting/setting.ts";

setLocale(savedLocale(process.env.VIBEVALLEY_HOME || defaults().home));
