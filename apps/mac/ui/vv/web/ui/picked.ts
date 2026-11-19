import type { PickedFile } from "nsh";

import { t } from "@vibevalley/i18n";

import { toast } from "./toasts";

/** The picked files whose bytes nsh read. One over its read limit comes without them: it is named in a toast and left out. */
export const readFiles = (picked: readonly PickedFile[]): File[] =>
  picked.flatMap((p) => {
    if (p.file) return [p.file];
    toast(t("web.base.pickTooLarge", { name: p.name }), "bad");
    return [];
  });
