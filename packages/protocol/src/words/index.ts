// The words both sides say (zh.ts, en.ts) and the locale they are said in (locale.ts).

import { en } from "./en";
import { localized } from "./locale";
import { zh } from "./zh";

export { currentLocale, localized, setLocale } from "./locale";
export type { Words } from "./zh";

export const wording = localized({ zh, en });
