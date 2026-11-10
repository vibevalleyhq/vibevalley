import { render } from "@solidjs/web";

import { App } from "./app/App";
import { isRemote } from "./features/lan";
import { entryFor } from "./features/user";
import { api } from "./infra/api";

import "./style.css";
import { followAppearance } from "./state/prefs";

/** A device from outside holds a key before anything else: without one the gate answers nothing. The key may be in an
 * HttpOnly cookie, so the server is asked, not document.cookie. */
const entry = (): Promise<string> =>
  !isRemote(location.hostname) || location.pathname === "/pair" || location.pathname === "/login"
    ? Promise.resolve("")
    : api.user.get().then(
        (status) => entryFor({ status, at: location.pathname + location.search }),
        () => entryFor({ status: undefined }),
      );

void entry().then((to) => {
  if (to !== "") return location.replace(to);
  followAppearance();
  const root = document.getElementById("root");
  if (root) render(() => <App />, root);
});
