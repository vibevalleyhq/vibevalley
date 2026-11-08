import { getRequestEvent } from "@solidjs/web";

import { en } from "../i18n/en";
import { zh } from "../i18n/zh";

export function page() {
  const path = new URL(getRequestEvent()?.request.url ?? window.location.href).pathname;
  return { copy: path === "/en/" ? en : zh, lost: path !== "/" && path !== "/en/" };
}
