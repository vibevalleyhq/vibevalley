// What every model is told of the owner's language: the farm's locale (setting.ts), in the words its Chinese
// instructions use. The instructions stay Chinese whatever the locale; what a model says to the owner is in this one.

import { currentLocale } from "@vibevalley/protocol/words";

export const ownersLanguage = () => (currentLocale() === "en" ? "英文（English）" : "中文");
