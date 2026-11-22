// Imported right after polyfill and before any app/feature/workspace/farm module
// so module-level t(...) calls resolve through native VvI18n in the host's locale.
import { host } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { installNativeI18n } from "./rich";

installNativeI18n();
setLocale(host.params.locale === "en" ? "en" : "zh");
