import { getRequestEvent } from "@solidjs/web";

import { en } from "./en";
import { zh } from "./zh";

export function page() {
  const path = new URL(getRequestEvent()?.request.url ?? window.location.href).pathname;
  return { copy: path === "/en/" ? en : zh, lost: path !== "/" && path !== "/en/" };
}
